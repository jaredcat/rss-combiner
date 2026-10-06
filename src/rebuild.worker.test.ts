import type { KVNamespace, Queue, R2Bucket } from '@cloudflare/workers-types';
import { reset } from 'cloudflare:test';
import { env as workersEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  claimPublishedPointer,
  REBUILD_CURRENT_KV_KEY,
  REBUILD_PUBLISHED_R2_KEY,
  type RebuildEnv as RebuildEnvironment,
  type RebuildMessage,
} from './rebuild.ts';

const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-06-01T00:00:00.000Z';

interface TestBindings {
  XML_BUCKET: R2Bucket;
  CONFIG_KV?: KVNamespace;
  REBUILD_QUEUE: Queue<RebuildMessage>;
}

const env = workersEnv as unknown as TestBindings;

function rebuildEnv(): RebuildEnvironment {
  if (!env.CONFIG_KV) {
    throw new Error('CONFIG_KV binding is required for rebuild worker tests');
  }
  return {
    XML_BUCKET: env.XML_BUCKET,
    CONFIG_KV: env.CONFIG_KV,
    REBUILD_QUEUE: env.REBUILD_QUEUE,
  };
}

async function setCurrentJob(jobId: string, createdAt: string): Promise<void> {
  const kv = env.CONFIG_KV;
  if (!kv) {
    throw new Error('CONFIG_KV binding is required for rebuild worker tests');
  }
  await kv.put(REBUILD_CURRENT_KV_KEY, JSON.stringify({ jobId, createdAt }));
  await kv.put(
    `rebuild:job:${jobId}`,
    JSON.stringify({
      jobId,
      status: 'running',
      totalFeeds: 1,
      feedIndex: 0,
      createdAt,
      updatedAt: createdAt,
    }),
  );
}

async function setPublished(jobId: string, createdAt: string): Promise<void> {
  await env.XML_BUCKET.put(
    REBUILD_PUBLISHED_R2_KEY,
    JSON.stringify({ jobId, createdAt }),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

async function publishedPointer(): Promise<
  { jobId: string; createdAt: string } | undefined
> {
  const object = await env.XML_BUCKET.get(REBUILD_PUBLISHED_R2_KEY);
  if (!object) {
    return;
  }
  return JSON.parse(await object.text()) as {
    jobId: string;
    createdAt: string;
  };
}

beforeEach(async () => {
  await reset();
});

afterEach(async () => {
  await reset();
});

describe('claimPublishedPointer', () => {
  test('claims the first publication when no pointer exists', async () => {
    const environment = rebuildEnv();
    await setCurrentJob('job-a', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-a', NEW),
    ).resolves.toBe(true);
    expect(await publishedPointer()).toEqual({
      jobId: 'job-a',
      createdAt: NEW,
    });
  });

  test('does not throw on the update path (regression: quoted httpEtag)', async () => {
    const environment = rebuildEnv();
    await setCurrentJob('job-new', NEW);
    await setPublished('job-old', OLD);

    // Passing a quoted etag to onlyIf would throw TypeError in workerd.
    await expect(
      claimPublishedPointer(environment, 'job-new', NEW),
    ).resolves.toBe(true);
    expect(await publishedPointer()).toEqual({
      jobId: 'job-new',
      createdAt: NEW,
    });
  });

  test('refuses to overwrite a newer publication', async () => {
    const environment = rebuildEnv();
    await setCurrentJob('job-old', OLD);
    await setPublished('job-new', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-old', OLD),
    ).resolves.toBe(false);
    expect(await publishedPointer()).toEqual({
      jobId: 'job-new',
      createdAt: NEW,
    });
  });

  test('is a no-op when this job already owns the pointer', async () => {
    const environment = rebuildEnv();
    await setCurrentJob('job-a', NEW);
    await setPublished('job-a', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-a', NEW),
    ).resolves.toBe(true);
    expect(await publishedPointer()).toEqual({
      jobId: 'job-a',
      createdAt: NEW,
    });
  });

  test('refuses to claim once the job is no longer current', async () => {
    const environment = rebuildEnv();
    await setCurrentJob('job-other', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-superseded', OLD),
    ).resolves.toBe(false);
    expect(await publishedPointer()).toBeUndefined();
  });
});
