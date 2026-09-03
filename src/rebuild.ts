import type {
  KVNamespace,
  Message,
  MessageBatch,
  Queue,
  R2Bucket,
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

/** Last job whose output was successfully promoted to `podcasts.xml`. */
export const REBUILD_PUBLISHED_KV_KEY = 'rebuild:published';

function jobStatusKey(jobId: string): string {
  return `rebuild:job:${jobId}`;
}

function jobOutputKey(jobId: string): string {
  return `rebuild/${jobId}/podcasts.xml`;
}

export type RebuildJobStatus = 'queued' | 'running' | 'ready' | 'failed';

export type RebuildStatus = {
  jobId: string;
  status: RebuildJobStatus;
  totalFeeds: number;
  feedIndex: number;
  updatedAt: string;
  error?: string;
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

async function getPublishedJobId(env: RebuildEnv): Promise<string | null> {
  if (!env.CONFIG_KV) {
    return null;
  }
  const raw = await env.CONFIG_KV.get(REBUILD_PUBLISHED_KV_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { jobId?: string };
    return typeof parsed.jobId === 'string' ? parsed.jobId : null;
  } catch {
    return null;
  }
}

async function setPublishedJobId(
  env: RebuildEnv,
  jobId: string | null,
): Promise<void> {
  if (!env.CONFIG_KV) {
    throw new Error('CONFIG_KV binding missing');
  }
  if (jobId == null) {
    await env.CONFIG_KV.delete(REBUILD_PUBLISHED_KV_KEY);
    return;
  }
  await env.CONFIG_KV.put(
    REBUILD_PUBLISHED_KV_KEY,
    JSON.stringify({ jobId }),
  );
}

const XML_HTTP_METADATA = { contentType: 'application/xml' } as const;

/** Copy a job-scoped feed artifact to the public `podcasts.xml` key. */
async function promoteJobOutput(
  env: RebuildEnv,
  jobId: string,
): Promise<boolean> {
  const obj = await env.XML_BUCKET.get(jobOutputKey(jobId));
  if (!obj) {
    return false;
  }
  await env.XML_BUCKET.put('podcasts.xml', obj.body, {
    httpMetadata: XML_HTTP_METADATA,
  });
  return true;
}

/**
 * If we published while superseded, restore the prior published artifact —
 * but only when we still own the published pointer (or it never moved off the
 * snapshot we captured). Never clobber a newer job's successful publish.
 */
async function restorePublishedFeed(
  env: RebuildEnv,
  ourJobId: string,
  previousPublishedJobId: string | null,
): Promise<void> {
  const publishedNow = await getPublishedJobId(env);
  const weOwnPublish = publishedNow === ourJobId;
  const pointerStillAtSnapshot =
    publishedNow === previousPublishedJobId ||
    (publishedNow == null && previousPublishedJobId == null);

  if (!weOwnPublish && !pointerStillAtSnapshot) {
    return;
  }

  if (!previousPublishedJobId) {
    if (weOwnPublish) {
      await setPublishedJobId(env, null);
    }
    return;
  }

  const restored = await promoteJobOutput(env, previousPublishedJobId);
  if (!restored) {
    console.error(
      `Could not restore podcasts.xml from published job ${previousPublishedJobId}`,
    );
    return;
  }

  // A newer job may have claimed publish during the R2 copy — leave their pointer.
  const publishedAfter = await getPublishedJobId(env);
  if (
    publishedAfter != null &&
    publishedAfter !== ourJobId &&
    publishedAfter !== previousPublishedJobId
  ) {
    return;
  }

  if (publishedAfter === ourJobId) {
    await setPublishedJobId(env, previousPublishedJobId);
  }
}

/** Delete per-feed JSON shards; keep `rebuild/{jobId}/podcasts.xml` for rollback. */
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
  const status: RebuildStatus = {
    jobId,
    status: 'queued',
    totalFeeds,
    feedIndex: 0,
    updatedAt: new Date().toISOString(),
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
  if (!(await requireCurrentJob(env, jobId))) {
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
 * Promote staged job output to public `podcasts.xml`, rolling back if we lose
 * ownership mid-publish. Returns true when this job remains current and published.
 */
async function publishJobFeed(
  env: RebuildEnv,
  jobId: string,
  xml: string,
): Promise<boolean> {
  await env.XML_BUCKET.put(jobOutputKey(jobId), xml, {
    httpMetadata: XML_HTTP_METADATA,
  });

  if (!(await requireCurrentJob(env, jobId))) {
    return false;
  }

  const previousPublishedJobId = await getPublishedJobId(env);
  await env.XML_BUCKET.put('podcasts.xml', xml, {
    httpMetadata: XML_HTTP_METADATA,
  });

  if (!(await requireCurrentJob(env, jobId))) {
    await restorePublishedFeed(env, jobId, previousPublishedJobId);
    return false;
  }

  await setPublishedJobId(env, jobId);

  if (!(await requireCurrentJob(env, jobId))) {
    await restorePublishedFeed(env, jobId, previousPublishedJobId);
    return false;
  }

  // Re-write after claiming publish so a concurrent restore that still saw the
  // old published pointer cannot leave stale XML under our published id.
  await env.XML_BUCKET.put('podcasts.xml', xml, {
    httpMetadata: XML_HTTP_METADATA,
  });

  if (!(await requireCurrentJob(env, jobId))) {
    await restorePublishedFeed(env, jobId, previousPublishedJobId);
    return false;
  }

  return true;
}

async function finishReadyCleanup(env: RebuildEnv, jobId: string): Promise<void> {
  try {
    await deleteFeedShards(env, jobId);
  } catch (error) {
    console.error('Rebuild shard cleanup failed (feed is ready):', error);
  }
}

/** Idempotent path when job status is already ready. */
async function finalizeAlreadyReady(
  env: RebuildEnv,
  jobId: string,
): Promise<void> {
  if (await requireCurrentJob(env, jobId)) {
    const previousPublishedJobId = await getPublishedJobId(env);
    if (previousPublishedJobId !== jobId) {
      const promoted = await promoteJobOutput(env, jobId);
      if (promoted && (await requireCurrentJob(env, jobId))) {
        await setPublishedJobId(env, jobId);
        if (await requireCurrentJob(env, jobId)) {
          await promoteJobOutput(env, jobId);
        } else {
          await restorePublishedFeed(env, jobId, previousPublishedJobId);
        }
      } else if (!(await requireCurrentJob(env, jobId))) {
        await restorePublishedFeed(env, jobId, previousPublishedJobId);
      }
    }
  }
  await finishReadyCleanup(env, jobId);
}

async function finalize(env: RebuildEnv, jobId: string): Promise<void> {
  const current = await requireCurrentJob(env, jobId);
  if (!current) {
    return;
  }
  if (current.status === 'ready') {
    await finalizeAlreadyReady(env, jobId);
    return;
  }

  const config = await resolveConfig(env as Env, env.CONFIG_KV);
  const allSerialized = await loadJobEpisodes(env, jobId, config.feeds.length);
  const xml = buildPodcastsXml(
    config,
    deserializeMergedEpisodes(allSerialized),
  );

  const published = await publishJobFeed(env, jobId, xml);
  if (!published) {
    return;
  }

  await putJobStatus(env, {
    jobId,
    status: 'ready',
    totalFeeds: config.feeds.length,
    feedIndex: config.feeds.length,
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
