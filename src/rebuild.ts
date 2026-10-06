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
import type { Env as Environment } from './worker';
import {
  buildPodcastsXml,
  deserializeMergedEpisodes,
  parseAndFilterFeed,
  serializeMergedEpisodes,
  type SerializedMergedEpisode,
} from './xml-builder';

/**
Must match `max_retries` on the queue consumer in wrangler.toml.
*/
export const REBUILD_MAX_RETRIES = 5;

/**
Pointer to the active job id only — written solely by `startRebuild`.
*/
export const REBUILD_CURRENT_KV_KEY = 'rebuild:v1';

/**
Live publication pointer in R2 (not KV). Conditional puts (`onlyIf` etag) give
compare-and-swap so a superseded finalizer cannot clobber a newer claim.
@see https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
*/
export const REBUILD_PUBLISHED_R2_KEY = 'rebuild/published.json';

function jobStatusKey(jobId: string): string {
  return `rebuild:job:${jobId}`;
}

export function jobOutputKey(jobId: string): string {
  return `rebuild/${jobId}/podcasts.xml`;
}

export type RebuildJobStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface RebuildStatus {
  jobId: string;
  status: RebuildJobStatus;
  totalFeeds: number;
  feedIndex: number;
  /**
  Job start time (ISO). Newer jobs win publication claims.
  */
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface PublishedPointer {
  jobId: string;
  createdAt: string;
}

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

/**
Sorts before any real timestamp so a job of unknown age can never win a
publication claim against a job with a known `createdAt`.
*/
const UNKNOWN_CREATED_AT = new Date(0).toISOString();

/**
Strict: a payload without `jobId` + `status` is not a status record. This
keeps the `{ jobId, createdAt }` pointer from being read as a half-empty
status whose missing `createdAt` would disable publish ordering.
*/
function parseStatus(raw: string | undefined): RebuildStatus | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RebuildStatus> | undefined;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.jobId !== 'string' ||
      typeof parsed.status !== 'string'
    ) {
      return undefined;
    }
    return {
      jobId: parsed.jobId,
      status: parsed.status,
      totalFeeds: typeof parsed.totalFeeds === 'number' ? parsed.totalFeeds : 0,
      feedIndex: typeof parsed.feedIndex === 'number' ? parsed.feedIndex : 0,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      ...(typeof parsed.error === 'string' && { error: parsed.error }),
    };
  } catch {
    return undefined;
  }
}

/**
Current-job pointer. Carries `createdAt` so publish ordering survives a stale
read of the per-job record (KV reads are eventually consistent).
*/
function parseCurrentPointer(
  raw: string | undefined,
): { jobId: string; createdAt: string } | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as
      | {
          jobId?: unknown;
          createdAt?: unknown;
          updatedAt?: unknown;
        }
      | undefined;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.jobId !== 'string'
    ) {
      return undefined;
    }
    const candidates = [parsed.createdAt, parsed.updatedAt];
    const createdAt = candidates.find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    return { jobId: parsed.jobId, createdAt: createdAt ?? '' };
  } catch {
    return undefined;
  }
}

async function putJobStatus(
  environment: RebuildEnv,
  status: RebuildStatus,
): Promise<void> {
  if (!environment.CONFIG_KV) {
    throw new Error('CONFIG_KV binding missing');
  }
  await environment.CONFIG_KV.put(
    jobStatusKey(status.jobId),
    JSON.stringify(status),
  );
}

/**
Admin banner only needs queued → running → ready/failed. Per-feed KV writes
are not used for shard assembly or publish claims (those are R2 + job id).
Write `running` once on the first feed so hourly rebuilds stay within the
free-tier KV write budget.
*/
export function shouldPersistRunningStatus(
  feedIndex: number,
  currentStatus: RebuildJobStatus,
): boolean {
  return (
    feedIndex === 0 && currentStatus !== 'running' && currentStatus !== 'ready'
  );
}

/**
Read the active rebuild status via the current-job pointer, then the job record.
Job workers never write the pointer — only `startRebuild` does — so a superseded
worker updating its own job record cannot overwrite a newer job's status.
*/
export async function getRebuildStatus(
  environment: RebuildEnv,
): Promise<RebuildStatus | undefined> {
  if (!environment.CONFIG_KV) {
    return undefined;
  }
  const pointerRaw =
    (await environment.CONFIG_KV.get(REBUILD_CURRENT_KV_KEY)) ?? undefined;
  const pointer = parseCurrentPointer(pointerRaw);
  if (!pointer) {
    return undefined;
  }

  const withPointerAge = (status: RebuildStatus): RebuildStatus => ({
    ...status,
    createdAt: status.createdAt || pointer.createdAt || UNKNOWN_CREATED_AT,
  });

  const fromJob = parseStatus(
    (await environment.CONFIG_KV.get(jobStatusKey(pointer.jobId))) ?? undefined,
  );
  if (fromJob?.jobId === pointer.jobId) {
    return withPointerAge(fromJob);
  }

  // Legacy single-key payload (pre-split), readable for one deploy.
  const legacy = parseStatus(pointerRaw);
  if (legacy?.jobId === pointer.jobId) {
    return withPointerAge(legacy);
  }

  // Pointer is visible but the job record is not yet. Synthesize rather than
  // returning a partial record, so `createdAt` is never undefined downstream.
  return {
    jobId: pointer.jobId,
    status: 'queued',
    totalFeeds: 0,
    feedIndex: 0,
    createdAt: pointer.createdAt || UNKNOWN_CREATED_AT,
    updatedAt: pointer.createdAt || UNKNOWN_CREATED_AT,
  };
}

async function requireCurrentJob(
  environment: RebuildEnv,
  jobId: string,
): Promise<RebuildStatus | undefined> {
  const current = await getRebuildStatus(environment);
  return current?.jobId === jobId ? current : undefined;
}

function jobCreatedAt(status: RebuildStatus): string {
  return status.createdAt || status.updatedAt || UNKNOWN_CREATED_AT;
}

/**
Return <0 if a is older than b, >0 if newer, 0 if same claim.
*/
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

function parsePublishedPointer(raw: string): PublishedPointer | undefined {
  try {
    const parsed = JSON.parse(raw) as { jobId?: string; createdAt?: string };
    return typeof parsed.jobId !== 'string' ||
      typeof parsed.createdAt !== 'string'
      ? undefined
      : { jobId: parsed.jobId, createdAt: parsed.createdAt };
  } catch {
    return undefined;
  }
}

async function readPublishedPointer(environment: RebuildEnv): Promise<{
  value: PublishedPointer | undefined;
  etag: string | undefined;
}> {
  const object = await environment.XML_BUCKET.get(REBUILD_PUBLISHED_R2_KEY);
  if (!object) {
    return { value: undefined, etag: undefined };
  }
  return {
    value: parsePublishedPointer(await object.text()),
    // Raw etag, not `httpEtag`: R2 rejects a quoted etag in `onlyIf` with a
    // TypeError ("Conditional ETag should not be wrapped in quotes").
    etag: object.etag,
  };
}

async function getPublishedJobId(
  environment: RebuildEnv,
): Promise<string | undefined> {
  const { value } = await readPublishedPointer(environment);
  return value?.jobId ?? undefined;
}

/**
Atomically claim the live publication pointer via R2 etag preconditions.
Returns false if a newer (or equal-and-other) job already owns publish, or
if this job is no longer current.
*/
export async function claimPublishedPointer(
  environment: RebuildEnv,
  jobId: string,
  createdAt: string,
): Promise<boolean> {
  // Never write a pointer without an age; that would disable ordering for
  // every later claimant, since `parsePublishedPointer` would reject it.
  const claimCreatedAt = createdAt || UNKNOWN_CREATED_AT;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await requireCurrentJob(environment, jobId))) {
      return false;
    }

    const { value, etag } = await readPublishedPointer(environment);
    if (value) {
      if (value.jobId === jobId) {
        return true;
      }
      if (
        comparePublishAge(
          claimCreatedAt,
          jobId,
          value.createdAt,
          value.jobId,
        ) <= 0
      ) {
        return false;
      }
    }

    const payload = JSON.stringify({
      jobId,
      createdAt: claimCreatedAt,
    } satisfies PublishedPointer);

    const result = await environment.XML_BUCKET.put(
      REBUILD_PUBLISHED_R2_KEY,
      payload,
      {
        httpMetadata: { contentType: 'application/json' },
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
      },
    );

    // null => precondition failed (someone else wrote).
    if (result !== null) {
      return true;
    }
  }
  return false;
}

const XML_HTTP_METADATA = { contentType: 'application/xml' } as const;

/**
Live feed object: staged output for `rebuild/published.json`, else legacy `podcasts.xml`.
Serving must use this — never trust `podcasts.xml` alone under concurrent finalizers.
*/
export async function getPublishedFeedObject(
  environment: RebuildEnv,
): Promise<R2ObjectBody | undefined> {
  const publishedId = await getPublishedJobId(environment);
  if (publishedId) {
    const staged = await environment.XML_BUCKET.get(jobOutputKey(publishedId));
    if (staged) {
      return staged;
    }
  }
  return (await environment.XML_BUCKET.get('podcasts.xml')) ?? undefined;
}

export async function headPublishedFeedObject(
  environment: RebuildEnv,
): Promise<R2Object | undefined> {
  const publishedId = await getPublishedJobId(environment);
  if (publishedId) {
    const staged = await environment.XML_BUCKET.head(jobOutputKey(publishedId));
    if (staged) {
      return staged;
    }
  }
  return (await environment.XML_BUCKET.head('podcasts.xml')) ?? undefined;
}

/**
Best-effort legacy mirror; not authoritative for GET /podcasts.xml.
*/
async function mirrorPublicPodcastsXml(
  environment: RebuildEnv,
  xml: string,
): Promise<void> {
  try {
    await environment.XML_BUCKET.put('podcasts.xml', xml, {
      httpMetadata: XML_HTTP_METADATA,
    });
  } catch (error) {
    console.error(
      'podcasts.xml mirror failed (published job output is authoritative):',
      error,
    );
  }
}

/**
Delete per-feed JSON shards; keep `rebuild/{jobId}/podcasts.xml` as the live artifact.
*/
async function deleteFeedShards(
  environment: RebuildEnv,
  jobId: string,
): Promise<void> {
  const prefix = shardPrefix(jobId);
  let cursor: string | undefined;
  for (;;) {
    const listed = await environment.XML_BUCKET.list({
      prefix,
      cursor,
      limit: 1000,
    });
    await Promise.all(
      listed.objects
        .filter((object) => object.key.endsWith('.json'))
        .map((object) => environment.XML_BUCKET.delete(object.key)),
    );
    if (!listed.truncated) {
      break;
    }
    cursor = listed.cursor;
  }
}

/**
Start a new rebuild job: write job status + current pointer, then enqueue.
*/
export async function startRebuild(
  environment: RebuildEnv,
): Promise<RebuildStatus> {
  if (!environment.CONFIG_KV) {
    throw new Error('CONFIG_KV binding missing');
  }

  const config = await resolveConfig(
    environment as Environment,
    environment.CONFIG_KV,
  );
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
  await putJobStatus(environment, status);
  // Pointer last so readers never see a new id without a job record. It carries
  // `createdAt` so publish ordering holds even if the job record read is stale.
  await environment.CONFIG_KV.put(
    REBUILD_CURRENT_KV_KEY,
    JSON.stringify({ jobId, createdAt: now }),
  );

  if (totalFeeds === 0) {
    await environment.REBUILD_QUEUE.send({ type: 'finalize', jobId });
  } else {
    await environment.REBUILD_QUEUE.send({
      type: 'process_feed',
      jobId,
      feedIndex: 0,
    });
  }

  return status;
}

async function processFeed(
  environment: RebuildEnv,
  jobId: string,
  feedIndex: number,
): Promise<void> {
  const current = await requireCurrentJob(environment, jobId);
  if (!current) {
    return;
  }

  const config = await resolveConfig(
    environment as Environment,
    environment.CONFIG_KV,
  );
  if (feedIndex < 0 || feedIndex >= config.feeds.length) {
    throw new Error(
      `Invalid feedIndex ${feedIndex} (total ${config.feeds.length})`,
    );
  }

  // Re-check before fetch. Do not write the current pointer from workers.
  const stillCurrent = await requireCurrentJob(environment, jobId);
  if (!stillCurrent) {
    return;
  }
  if (shouldPersistRunningStatus(feedIndex, stillCurrent.status)) {
    await putJobStatus(environment, {
      jobId,
      status: 'running',
      totalFeeds: config.feeds.length,
      feedIndex: 0,
      createdAt: jobCreatedAt(stillCurrent),
      updatedAt: new Date().toISOString(),
    });
  }

  const feedConfig = config.feeds[feedIndex];
  const { episodes } = await parseAndFilterFeed(feedConfig, config);
  const payload = serializeMergedEpisodes(episodes);
  await environment.XML_BUCKET.put(
    shardKey(jobId, feedIndex),
    JSON.stringify(payload),
    {
      httpMetadata: { contentType: 'application/json' },
    },
  );

  if (!(await requireCurrentJob(environment, jobId))) {
    return;
  }

  const nextIndex = feedIndex + 1;
  if (nextIndex >= config.feeds.length) {
    await environment.REBUILD_QUEUE.send({ type: 'finalize', jobId });
  } else {
    await environment.REBUILD_QUEUE.send({
      type: 'process_feed',
      jobId,
      feedIndex: nextIndex,
    });
  }
}

async function loadJobEpisodes(
  environment: RebuildEnv,
  jobId: string,
  feedCount: number,
): Promise<SerializedMergedEpisode[]> {
  const objects = await Promise.all(
    Array.from({ length: feedCount }, (_, index) =>
      environment.XML_BUCKET.get(shardKey(jobId, index)),
    ),
  );

  const shards = await Promise.all(
    objects.map(async (object, index) => {
      if (!object) {
        throw new Error(`Missing rebuild shard for feed index ${index}`);
      }
      const parsed = JSON.parse(
        await object.text(),
      ) as SerializedMergedEpisode[];
      if (!Array.isArray(parsed)) {
        throw new TypeError(
          `Invalid rebuild shard JSON for feed index ${index}`,
        );
      }
      return parsed;
    }),
  );

  return shards.flat();
}

/**
Commit this job's staged output as the live feed.
Publication uses an R2 etag CAS on `rebuild/published.json` so an older
finalizer cannot overwrite a newer successful claim (KV cannot do this).
`podcasts.xml` remains a non-authoritative mirror.
*/
async function publishJobFeed(
  environment: RebuildEnv,
  jobId: string,
  createdAt: string,
  xml: string,
): Promise<boolean> {
  await environment.XML_BUCKET.put(jobOutputKey(jobId), xml, {
    httpMetadata: XML_HTTP_METADATA,
  });

  const isClaimed = await claimPublishedPointer(environment, jobId, createdAt);
  if (!isClaimed) {
    return false;
  }

  await mirrorPublicPodcastsXml(environment, xml);
  return true;
}

async function finishReadyCleanup(
  environment: RebuildEnv,
  jobId: string,
): Promise<void> {
  try {
    await deleteFeedShards(environment, jobId);
  } catch (error) {
    console.error('Rebuild shard cleanup failed (feed is ready):', error);
  }
}

/**
Claim publish for an already-ready job that is still current.
*/
async function claimPublishedIfCurrent(
  environment: RebuildEnv,
  job: RebuildStatus,
): Promise<void> {
  if (!(await requireCurrentJob(environment, job.jobId))) {
    return;
  }
  const staged = await environment.XML_BUCKET.head(jobOutputKey(job.jobId));
  if (!staged) {
    return;
  }
  const isClaimed = await claimPublishedPointer(
    environment,
    job.jobId,
    jobCreatedAt(job),
  );
  if (!isClaimed) {
    return;
  }
  const body = await environment.XML_BUCKET.get(jobOutputKey(job.jobId));
  if (body) {
    await mirrorPublicPodcastsXml(environment, await body.text());
  }
}

/**
Idempotent path when job status is already ready.
*/
async function finalizeAlreadyReady(
  environment: RebuildEnv,
  job: RebuildStatus,
): Promise<void> {
  if (await requireCurrentJob(environment, job.jobId)) {
    await claimPublishedIfCurrent(environment, job);
  }
  await finishReadyCleanup(environment, job.jobId);
}

async function finalize(environment: RebuildEnv, jobId: string): Promise<void> {
  const current = await requireCurrentJob(environment, jobId);
  if (!current) {
    return;
  }
  if (current.status === 'ready') {
    await finalizeAlreadyReady(environment, current);
    return;
  }

  const config = await resolveConfig(
    environment as Environment,
    environment.CONFIG_KV,
  );
  const allSerialized = await loadJobEpisodes(
    environment,
    jobId,
    config.feeds.length,
  );
  const xml = buildPodcastsXml(
    config,
    deserializeMergedEpisodes(allSerialized),
  );

  const isPublished = await publishJobFeed(
    environment,
    jobId,
    jobCreatedAt(current),
    xml,
  );
  if (!isPublished) {
    return;
  }

  await putJobStatus(environment, {
    jobId,
    status: 'ready',
    totalFeeds: config.feeds.length,
    feedIndex: config.feeds.length,
    createdAt: jobCreatedAt(current),
    updatedAt: new Date().toISOString(),
  });

  await finishReadyCleanup(environment, jobId);
}

async function markFailed(
  environment: RebuildEnv,
  jobId: string,
  error: unknown,
): Promise<void> {
  const current = await requireCurrentJob(environment, jobId);
  if (!current) {
    return;
  }
  let message = 'Unknown error';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }
  await putJobStatus(environment, {
    ...current,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    error: message.slice(0, 500),
  });
}

function parseMessageBody(body: unknown): RebuildMessage | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const o = body as Record<string, unknown>;
  if (o.type === 'finalize' && typeof o.jobId === 'string') {
    return { type: 'finalize', jobId: o.jobId };
  }
  if (
    o.type === 'process_feed' &&
    typeof o.jobId === 'string' &&
    typeof o.feedIndex === 'number' &&
    Number.isSafeInteger(o.feedIndex)
  ) {
    return {
      type: 'process_feed',
      jobId: o.jobId,
      feedIndex: o.feedIndex,
    };
  }
  return undefined;
}

async function handleQueueMessage(
  environment: RebuildEnv,
  message: Message<RebuildMessage>,
): Promise<void> {
  const body = parseMessageBody(message.body);
  if (!body) {
    console.error('Unknown rebuild queue message; acking', message.body);
    message.ack();
    return;
  }

  const current = await requireCurrentJob(environment, body.jobId);
  if (!current) {
    // Stale job (superseded by a newer Save / rebuild) — ack and skip.
    message.ack();
    return;
  }

  try {
    if (body.type === 'process_feed') {
      await processFeed(environment, body.jobId, body.feedIndex);
    } else {
      await finalize(environment, body.jobId);
    }
    message.ack();
  } catch (error) {
    console.error('Rebuild queue message failed:', error);
    if (message.attempts >= REBUILD_MAX_RETRIES + 1) {
      await markFailed(environment, body.jobId, error);
      message.ack();
      return;
    }
    message.retry();
  }
}

async function handleQueueMessages(
  environment: RebuildEnv,
  messages: readonly Message<RebuildMessage>[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  await handleQueueMessage(environment, messages[0]);
  await handleQueueMessages(environment, messages.slice(1));
}

/**
Queue consumer entrypoint (max_batch_size should be 1).
Messages are handled in order so a multi-message batch cannot interleave
`process_feed` / `finalize` for the same job.
*/
export async function handleRebuildQueueBatch(
  batch: MessageBatch<RebuildMessage>,
  environment: RebuildEnv,
): Promise<void> {
  await handleQueueMessages(environment, batch.messages);
}

/**
Human-readable admin flash from KV rebuild status.
*/
export function rebuildStatusFlash(
  status: RebuildStatus | undefined,
  options?: { saved?: boolean },
): string | undefined {
  const isSaved = options?.saved === true;
  if (!status) {
    return isSaved
      ? 'Saved to KV. Rebuild queued — /podcasts.xml updates when the job finishes.'
      : undefined;
  }
  switch (status.status) {
    case 'queued': {
      return isSaved ? 'Saved. Rebuild queued…' : 'Rebuild queued…';
    }
    case 'running': {
      return isSaved ? 'Saved. Rebuild running…' : 'Rebuild running…';
    }
    case 'failed': {
      return `Rebuild failed: ${status.error || 'unknown error'}`;
    }
    case 'ready': {
      return isSaved ? 'Saved. Feed ready.' : 'Feed ready';
    }
    default: {
      return undefined;
    }
  }
}
