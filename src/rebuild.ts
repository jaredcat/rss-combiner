import type {
  KVNamespace,
  Message,
  MessageBatch,
  Queue,
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from '@cloudflare/workers-types';
import { resolveConfig } from './config';
import type { Env } from './worker';
import {
  buildPodcastsXml,
  deserializeMergedEpisodes,
  parseAndFilterFeed,
  serializeMergedEpisodes,
  type SerializedMergedEpisode,
} from './xmlBuilder';

/** Must match `max_retries` on the queue consumer in wrangler.toml. */
export const REBUILD_MAX_RETRIES = 5;

/** Pointer to the active job id only — written solely by `startRebuild`. */
export const REBUILD_CURRENT_KV_KEY = 'rebuild:v1';

/**
 * Live publication pointer in R2 (not KV). Conditional puts (`onlyIf` etag) give
 * compare-and-swap so a superseded finalizer cannot clobber a newer claim.
 * @see https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
 */
export const REBUILD_PUBLISHED_R2_KEY = 'rebuild/published.json';

function jobStatusKey(jobId: string): string {
  return `rebuild:job:${jobId}`;
}

export function jobOutputKey(jobId: string): string {
  return `rebuild/${jobId}/podcasts.xml`;
}

export type RebuildJobStatus = 'queued' | 'running' | 'ready' | 'failed';

export type RebuildStatus = {
  jobId: string;
  status: RebuildJobStatus;
  totalFeeds: number;
  feedIndex: number;
  /** Job start time (ISO). Newer jobs win publication claims. */
  createdAt: string;
  updatedAt: string;
  error?: string;
};

type PublishedPointer = {
  jobId: string;
  createdAt: string;
};

export type RebuildMessage =
  | { type: 'process_feed'; jobId: string; feedIndex: number }
  | { type: 'finalize'; jobId: string };

export interface RebuildEnv {
  XML_BUCKET: R2Bucket;
  CONFIG_KV?: KVNamespace;
  REBUILD_QUEUE: Queue<RebuildMessage>;
}

function shardKey(jobId: string, feedIndex: number): string {
  return `rebuild/${jobId}/${feedIndex}.json`;
}

function shardPrefix(jobId: string): string {
  return `rebuild/${jobId}/`;
}

function parseStatus(raw: string | null): RebuildStatus | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as RebuildStatus;
  } catch {
    return null;
  }
}

async function putJobStatus(
  env: RebuildEnv,
  status: RebuildStatus,
): Promise<void> {
  if (!env.CONFIG_KV) {
    throw new Error('CONFIG_KV binding missing');
  }
  await env.CONFIG_KV.put(jobStatusKey(status.jobId), JSON.stringify(status));
}

/**
 * Read the active rebuild status via the current-job pointer, then the job record.
 * Job workers never write the pointer — only `startRebuild` does — so a superseded
 * worker updating its own job record cannot overwrite a newer job's status.
 */
export async function getRebuildStatus(
  env: RebuildEnv,
): Promise<RebuildStatus | null> {
  if (!env.CONFIG_KV) {
    return null;
  }
  const pointerRaw = await env.CONFIG_KV.get(REBUILD_CURRENT_KV_KEY);
  if (!pointerRaw) {
    return null;
  }
  try {
    const pointer = JSON.parse(pointerRaw) as { jobId?: string } | RebuildStatus;
    if (!pointer || typeof pointer !== 'object' || typeof pointer.jobId !== 'string') {
      return null;
    }
    // Prefer per-job record; fall back to legacy single-key payload for one deploy.
    const jobRaw = await env.CONFIG_KV.get(jobStatusKey(pointer.jobId));
    const fromJob = parseStatus(jobRaw);
    if (fromJob) {
      return fromJob;
    }
    return parseStatus(pointerRaw);
  } catch {
    return null;
  }
}

async function requireCurrentJob(
  env: RebuildEnv,
  jobId: string,
): Promise<RebuildStatus | null> {
  const current = await getRebuildStatus(env);
  if (!current || current.jobId !== jobId) {
    return null;
  }
  return current;
}

function jobCreatedAt(status: RebuildStatus): string {
  return status.createdAt || status.updatedAt;
}

/** Return <0 if a is older than b, >0 if newer, 0 if same claim. */
function comparePublishAge(
  aCreatedAt: string,
  aJobId: string,
  bCreatedAt: string,
  bJobId: string,
): number {
  if (aCreatedAt !== bCreatedAt) {
    return aCreatedAt < bCreatedAt ? -1 : 1;
  }
  if (aJobId === bJobId) {
    return 0;
  }
  return aJobId < bJobId ? -1 : 1;
}

function parsePublishedPointer(raw: string): PublishedPointer | null {
  try {
    const parsed = JSON.parse(raw) as { jobId?: string; createdAt?: string };
    if (
      typeof parsed.jobId !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return { jobId: parsed.jobId, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function readPublishedPointer(env: RebuildEnv): Promise<{
  value: PublishedPointer | null;
  etag: string | null;
}> {
  const obj = await env.XML_BUCKET.get(REBUILD_PUBLISHED_R2_KEY);
  if (!obj) {
    return { value: null, etag: null };
  }
  return {
    value: parsePublishedPointer(await obj.text()),
    etag: obj.httpEtag,
  };
}

async function getPublishedJobId(env: RebuildEnv): Promise<string | null> {
  const { value } = await readPublishedPointer(env);
  return value?.jobId ?? null;
}

/**
 * Atomically claim the live publication pointer via R2 etag preconditions.
 * Returns false if a newer (or equal-and-other) job already owns publish, or
 * if this job is no longer current.
 */
async function claimPublishedPointer(
  env: RebuildEnv,
  jobId: string,
  createdAt: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await requireCurrentJob(env, jobId))) {
      return false;
    }

    const { value, etag } = await readPublishedPointer(env);
    if (value) {
      if (value.jobId === jobId) {
        return true;
      }
      if (
        comparePublishAge(createdAt, jobId, value.createdAt, value.jobId) <= 0
      ) {
        return false;
      }
    }

    const payload = JSON.stringify({
      jobId,
      createdAt,
    } satisfies PublishedPointer);

    const result = await env.XML_BUCKET.put(REBUILD_PUBLISHED_R2_KEY, payload, {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: etag
        ? { etagMatches: etag }
        : { etagDoesNotMatch: '*' },
    });

    // null => precondition failed (someone else wrote).
    if (result !== null) {
      return true;
    }
  }
  return false;
}

const XML_HTTP_METADATA = { contentType: 'application/xml' } as const;

/**
 * Live feed object: staged output for `rebuild/published.json`, else legacy `podcasts.xml`.
 * Serving must use this — never trust `podcasts.xml` alone under concurrent finalizers.
 */
export async function getPublishedFeedObject(
  env: RebuildEnv,
): Promise<R2ObjectBody | null> {
  const publishedId = await getPublishedJobId(env);
  if (publishedId) {
    const staged = await env.XML_BUCKET.get(jobOutputKey(publishedId));
    if (staged) {
      return staged;
    }
  }
  return env.XML_BUCKET.get('podcasts.xml');
}

export async function headPublishedFeedObject(
  env: RebuildEnv,
): Promise<R2Object | null> {
  const publishedId = await getPublishedJobId(env);
  if (publishedId) {
    const staged = await env.XML_BUCKET.head(jobOutputKey(publishedId));
    if (staged) {
      return staged;
    }
  }
  return env.XML_BUCKET.head('podcasts.xml');
}

/** Best-effort legacy mirror; not authoritative for GET /podcasts.xml. */
async function mirrorPublicPodcastsXml(
  env: RebuildEnv,
  xml: string,
): Promise<void> {
  try {
    await env.XML_BUCKET.put('podcasts.xml', xml, {
      httpMetadata: XML_HTTP_METADATA,
    });
  } catch (error) {
    console.error(
      'podcasts.xml mirror failed (published job output is authoritative):',
      error,
    );
  }
}

/** Delete per-feed JSON shards; keep `rebuild/{jobId}/podcasts.xml` as the live artifact. */
async function deleteFeedShards(env: RebuildEnv, jobId: string): Promise<void> {
  const prefix = shardPrefix(jobId);
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.XML_BUCKET.list({ prefix, cursor, limit: 1000 });
    await Promise.all(
      listed.objects
        .filter((obj) => obj.key.endsWith('.json'))
        .map((obj) => env.XML_BUCKET.delete(obj.key)),
    );
    if (!listed.truncated) {
      break;
    }
    cursor = listed.cursor;
  }
}

/**
 * Start a new rebuild job: write job status + current pointer, then enqueue.
 */
export async function startRebuild(env: RebuildEnv): Promise<RebuildStatus> {
  if (!env.CONFIG_KV) {
    throw new Error('CONFIG_KV binding missing');
  }
  if (!env.REBUILD_QUEUE) {
    throw new Error('REBUILD_QUEUE binding missing');
  }

  const config = await resolveConfig(env as Env, env.CONFIG_KV);
  const jobId = crypto.randomUUID();
  const totalFeeds = config.feeds.length;
  const now = new Date().toISOString();
  const status: RebuildStatus = {
    jobId,
    status: 'queued',
    totalFeeds,
    feedIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
  await putJobStatus(env, status);
  // Pointer last so readers never see a new id without a job record.
  await env.CONFIG_KV.put(
    REBUILD_CURRENT_KV_KEY,
    JSON.stringify({ jobId }),
  );

  if (totalFeeds === 0) {
    await env.REBUILD_QUEUE.send({ type: 'finalize', jobId });
  } else {
    await env.REBUILD_QUEUE.send({
      type: 'process_feed',
      jobId,
      feedIndex: 0,
    });
  }

  return status;
}

async function processFeed(
  env: RebuildEnv,
  jobId: string,
  feedIndex: number,
): Promise<void> {
  const current = await requireCurrentJob(env, jobId);
  if (!current) {
    return;
  }

  const config = await resolveConfig(env as Env, env.CONFIG_KV);
  if (feedIndex < 0 || feedIndex >= config.feeds.length) {
    throw new Error(
      `Invalid feedIndex ${feedIndex} (total ${config.feeds.length})`,
    );
  }

  // Only touch this job's record — never the current pointer.
  if (!(await requireCurrentJob(env, jobId))) {
    return;
  }
  await putJobStatus(env, {
    jobId,
    status: 'running',
    totalFeeds: config.feeds.length,
    feedIndex,
    createdAt: jobCreatedAt(current),
    updatedAt: new Date().toISOString(),
  });

  const feedConfig = config.feeds[feedIndex];
  const { episodes } = await parseAndFilterFeed(feedConfig, config);
  const payload = serializeMergedEpisodes(episodes);
  await env.XML_BUCKET.put(shardKey(jobId, feedIndex), JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json' },
  });

  if (!(await requireCurrentJob(env, jobId))) {
    return;
  }

  const nextIndex = feedIndex + 1;
  if (nextIndex >= config.feeds.length) {
    await env.REBUILD_QUEUE.send({ type: 'finalize', jobId });
  } else {
    await env.REBUILD_QUEUE.send({
      type: 'process_feed',
      jobId,
      feedIndex: nextIndex,
    });
  }
}

async function loadJobEpisodes(
  env: RebuildEnv,
  jobId: string,
  feedCount: number,
): Promise<SerializedMergedEpisode[]> {
  const allSerialized: SerializedMergedEpisode[] = [];
  for (let i = 0; i < feedCount; i++) {
    const obj = await env.XML_BUCKET.get(shardKey(jobId, i));
    if (!obj) {
      throw new Error(`Missing rebuild shard for feed index ${i}`);
    }
    const parsed = JSON.parse(await obj.text()) as SerializedMergedEpisode[];
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid rebuild shard JSON for feed index ${i}`);
    }
    allSerialized.push(...parsed);
  }
  return allSerialized;
}

/**
 * Commit this job's staged output as the live feed.
 * Publication uses an R2 etag CAS on `rebuild/published.json` so an older
 * finalizer cannot overwrite a newer successful claim (KV cannot do this).
 * `podcasts.xml` remains a non-authoritative mirror.
 */
async function publishJobFeed(
  env: RebuildEnv,
  jobId: string,
  createdAt: string,
  xml: string,
): Promise<boolean> {
  await env.XML_BUCKET.put(jobOutputKey(jobId), xml, {
    httpMetadata: XML_HTTP_METADATA,
  });

  const claimed = await claimPublishedPointer(env, jobId, createdAt);
  if (!claimed) {
    return false;
  }

  await mirrorPublicPodcastsXml(env, xml);
  return true;
}

async function finishReadyCleanup(env: RebuildEnv, jobId: string): Promise<void> {
  try {
    await deleteFeedShards(env, jobId);
  } catch (error) {
    console.error('Rebuild shard cleanup failed (feed is ready):', error);
  }
}

/** Claim publish for an already-ready job that is still current. */
async function claimPublishedIfCurrent(
  env: RebuildEnv,
  job: RebuildStatus,
): Promise<void> {
  if (!(await requireCurrentJob(env, job.jobId))) {
    return;
  }
  const staged = await env.XML_BUCKET.head(jobOutputKey(job.jobId));
  if (!staged) {
    return;
  }
  const claimed = await claimPublishedPointer(
    env,
    job.jobId,
    jobCreatedAt(job),
  );
  if (!claimed) {
    return;
  }
  const body = await env.XML_BUCKET.get(jobOutputKey(job.jobId));
  if (body) {
    await mirrorPublicPodcastsXml(env, await body.text());
  }
}

/** Idempotent path when job status is already ready. */
async function finalizeAlreadyReady(
  env: RebuildEnv,
  job: RebuildStatus,
): Promise<void> {
  if (await requireCurrentJob(env, job.jobId)) {
    await claimPublishedIfCurrent(env, job);
  }
  await finishReadyCleanup(env, job.jobId);
}

async function finalize(env: RebuildEnv, jobId: string): Promise<void> {
  const current = await requireCurrentJob(env, jobId);
  if (!current) {
    return;
  }
  if (current.status === 'ready') {
    await finalizeAlreadyReady(env, current);
    return;
  }

  const config = await resolveConfig(env as Env, env.CONFIG_KV);
  const allSerialized = await loadJobEpisodes(env, jobId, config.feeds.length);
  const xml = buildPodcastsXml(
    config,
    deserializeMergedEpisodes(allSerialized),
  );

  const published = await publishJobFeed(
    env,
    jobId,
    jobCreatedAt(current),
    xml,
  );
  if (!published) {
    return;
  }

  await putJobStatus(env, {
    jobId,
    status: 'ready',
    totalFeeds: config.feeds.length,
    feedIndex: config.feeds.length,
    createdAt: jobCreatedAt(current),
    updatedAt: new Date().toISOString(),
  });

  await finishReadyCleanup(env, jobId);
}

async function markFailed(
  env: RebuildEnv,
  jobId: string,
  error: unknown,
): Promise<void> {
  const current = await requireCurrentJob(env, jobId);
  if (!current) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await putJobStatus(env, {
    ...current,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    error: message.slice(0, 500),
  });
}

function parseMessageBody(body: unknown): RebuildMessage | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const o = body as Record<string, unknown>;
  if (o.type === 'finalize' && typeof o.jobId === 'string') {
    return { type: 'finalize', jobId: o.jobId };
  }
  if (
    o.type === 'process_feed' &&
    typeof o.jobId === 'string' &&
    typeof o.feedIndex === 'number' &&
    Number.isInteger(o.feedIndex)
  ) {
    return {
      type: 'process_feed',
      jobId: o.jobId,
      feedIndex: o.feedIndex,
    };
  }
  return null;
}

async function handleQueueMessage(
  env: RebuildEnv,
  message: Message<RebuildMessage>,
): Promise<void> {
  const body = parseMessageBody(message.body);
  if (!body) {
    console.error('Unknown rebuild queue message; acking', message.body);
    message.ack();
    return;
  }

  const current = await requireCurrentJob(env, body.jobId);
  if (!current) {
    // Stale job (superseded by a newer Save / rebuild) — ack and skip.
    message.ack();
    return;
  }

  try {
    if (body.type === 'process_feed') {
      await processFeed(env, body.jobId, body.feedIndex);
    } else {
      await finalize(env, body.jobId);
    }
    message.ack();
  } catch (error) {
    console.error('Rebuild queue message failed:', error);
    if (message.attempts >= REBUILD_MAX_RETRIES + 1) {
      await markFailed(env, body.jobId, error);
      message.ack();
      return;
    }
    message.retry();
  }
}

/** Queue consumer entrypoint (max_batch_size should be 1). */
export async function handleRebuildQueueBatch(
  batch: MessageBatch<RebuildMessage>,
  env: RebuildEnv,
): Promise<void> {
  for (const message of batch.messages) {
    await handleQueueMessage(env, message);
  }
}

/** Human-readable admin flash from KV rebuild status. */
export function rebuildStatusFlash(
  status: RebuildStatus | null,
  options?: { saved?: boolean },
): string | undefined {
  const saved = options?.saved === true;
  if (!status) {
    return saved
      ? 'Saved to KV. Rebuild queued — /podcasts.xml updates when the job finishes.'
      : undefined;
  }
  switch (status.status) {
    case 'queued':
      return saved
        ? 'Saved. Rebuild queued…'
        : 'Rebuild queued…';
    case 'running':
      return saved ? 'Saved. Rebuild running…' : 'Rebuild running…';
    case 'failed':
      return `Rebuild failed: ${status.error || 'unknown error'}`;
    case 'ready':
      return saved ? 'Saved. Feed ready.' : 'Feed ready';
    default:
      return undefined;
  }
}
