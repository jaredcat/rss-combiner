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

export const REBUILD_STATUS_KV_KEY = 'rebuild:v1';

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

async function putRebuildStatus(
  env: RebuildEnv,
  status: RebuildStatus,
): Promise<void> {
  if (!env.CONFIG_KV) {
    throw new Error('CONFIG_KV binding missing');
  }
  await env.CONFIG_KV.put(REBUILD_STATUS_KV_KEY, JSON.stringify(status));
}

export async function getRebuildStatus(
  env: RebuildEnv,
): Promise<RebuildStatus | null> {
  if (!env.CONFIG_KV) {
    return null;
  }
  const raw = await env.CONFIG_KV.get(REBUILD_STATUS_KV_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as RebuildStatus;
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

async function deleteJobShards(env: RebuildEnv, jobId: string): Promise<void> {
  const prefix = shardPrefix(jobId);
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.XML_BUCKET.list({ prefix, cursor, limit: 1000 });
    await Promise.all(
      listed.objects.map((obj) => env.XML_BUCKET.delete(obj.key)),
    );
    if (!listed.truncated) {
      break;
    }
    cursor = listed.cursor;
  }
}

/**
 * Start a new rebuild job: write KV status and enqueue the first feed
 * (or finalize immediately when there are no feeds).
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
  await putRebuildStatus(env, status);

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

  await putRebuildStatus(env, {
    ...current,
    status: 'running',
    feedIndex,
    updatedAt: new Date().toISOString(),
    error: undefined,
  });

  const feedConfig = config.feeds[feedIndex];
  const { episodes } = await parseAndFilterFeed(feedConfig, config);
  const payload = serializeMergedEpisodes(episodes);
  await env.XML_BUCKET.put(shardKey(jobId, feedIndex), JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json' },
  });

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

async function finalize(env: RebuildEnv, jobId: string): Promise<void> {
  const current = await requireCurrentJob(env, jobId);
  if (!current) {
    return;
  }

  const config = await resolveConfig(env as Env, env.CONFIG_KV);
  const allSerialized: SerializedMergedEpisode[] = [];

  for (let i = 0; i < config.feeds.length; i++) {
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

  const episodes = deserializeMergedEpisodes(allSerialized);
  const xml = buildPodcastsXml(config, episodes);
  await env.XML_BUCKET.put('podcasts.xml', xml, {
    httpMetadata: { contentType: 'application/xml' },
  });
  await deleteJobShards(env, jobId);

  await putRebuildStatus(env, {
    ...current,
    status: 'ready',
    feedIndex: config.feeds.length,
    updatedAt: new Date().toISOString(),
    error: undefined,
  });
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
  await putRebuildStatus(env, {
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
