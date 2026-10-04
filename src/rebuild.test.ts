import { beforeEach, describe, expect, test } from 'bun:test';
import {
  claimPublishedPointer,
  REBUILD_CURRENT_KV_KEY,
  REBUILD_PUBLISHED_R2_KEY,
  shouldPersistRunningStatus,
  type RebuildEnv as RebuildEnvironment,
} from './rebuild.ts';

type Conditional = {
  etagMatches?: string;
  etagDoesNotMatch?: string;
};

/**
Mirrors workerd: a quoted etag in `onlyIf` is a TypeError, not a soft failure.
@see https://github.com/cloudflare/workerd/blob/main/src/workerd/api/r2-bucket.c%2B%2B
*/
function assertUnquotedEtag(value: string): void {
  if (value.startsWith('"') || value.startsWith('W/"')) {
    throw new TypeError(
      `Conditional ETag should not be wrapped in quotes (${value}).`,
    );
  }
}

class FakeBucket {
  private seq = 0;
  store = new Map<string, { body: string; etag: string }>();
  onGet?: (key: string) => Promise<void>;

  async get(key: string) {
    await this.onGet?.(key);
    const object = this.store.get(key);
    if (!object) {
      return;
    }
    return {
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      text: async () => object.body,
    };
  }

  async head(key: string) {
    return this.get(key);
  }

  async put(key: string, value: string, options?: { onlyIf?: Conditional }) {
    const existing = this.store.get(key);
    const cond = options?.onlyIf;

    if (cond?.etagMatches !== undefined) {
      assertUnquotedEtag(cond.etagMatches);
      const isOk =
        cond.etagMatches === '*'
          ? existing !== undefined
          : existing?.etag === cond.etagMatches;
      if (!isOk) {
        return;
      }
    }
    if (cond?.etagDoesNotMatch !== undefined) {
      assertUnquotedEtag(cond.etagDoesNotMatch);
      const isBlocked =
        cond.etagDoesNotMatch === '*'
          ? existing !== undefined
          : existing?.etag === cond.etagDoesNotMatch;
      if (isBlocked) {
        return;
      }
    }

    this.seq += 1;
    const etag = `etag-${this.seq}`;
    this.store.set(key, { body: value, etag });
    return { etag, httpEtag: `"${etag}"` };
  }
}

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? undefined;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-06-01T00:00:00.000Z';

let bucket: FakeBucket;
let kv: FakeKV;
let environment: RebuildEnvironment;

function setCurrentJob(jobId: string, createdAt: string): void {
  kv.store.set(REBUILD_CURRENT_KV_KEY, JSON.stringify({ jobId, createdAt }));
  kv.store.set(
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

function setPublished(jobId: string, createdAt: string): void {
  bucket.store.set(REBUILD_PUBLISHED_R2_KEY, {
    body: JSON.stringify({ jobId, createdAt }),
    etag: `etag-${jobId}`,
  });
}

function publishedPointer(): { jobId: string; createdAt: string } | undefined {
  const raw = bucket.store.get(REBUILD_PUBLISHED_R2_KEY);
  return raw ? JSON.parse(raw.body) : undefined;
}

beforeEach(() => {
  bucket = new FakeBucket();
  kv = new FakeKV();
  environment = {
    XML_BUCKET: bucket,
    CONFIG_KV: kv,
    REBUILD_QUEUE: { send: async () => {} },
  } as unknown as RebuildEnvironment;
});

describe('shouldPersistRunningStatus', () => {
  test('writes running only for the first feed while still queued', () => {
    expect(shouldPersistRunningStatus(0, 'queued')).toBe(true);
    expect(shouldPersistRunningStatus(0, 'failed')).toBe(true);
  });

  test('does not write per-feed progress or on retries already marked running', () => {
    expect(shouldPersistRunningStatus(1, 'queued')).toBe(false);
    expect(shouldPersistRunningStatus(12, 'running')).toBe(false);
    expect(shouldPersistRunningStatus(0, 'running')).toBe(false);
    expect(shouldPersistRunningStatus(0, 'ready')).toBe(false);
  });
});

describe('claimPublishedPointer', () => {
  test('claims the first publication when no pointer exists', async () => {
    setCurrentJob('job-a', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-a', NEW),
    ).resolves.toBe(true);
    expect(publishedPointer()).toEqual({ jobId: 'job-a', createdAt: NEW });
  });

  test('does not throw on the update path (regression: quoted httpEtag)', async () => {
    setCurrentJob('job-new', NEW);
    setPublished('job-old', OLD);

    // Passing a quoted etag to onlyIf would throw here rather than return false.
    await expect(
      claimPublishedPointer(environment, 'job-new', NEW),
    ).resolves.toBe(true);
    expect(publishedPointer()).toEqual({ jobId: 'job-new', createdAt: NEW });
  });

  test('refuses to overwrite a newer publication', async () => {
    setCurrentJob('job-old', OLD);
    setPublished('job-new', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-old', OLD),
    ).resolves.toBe(false);
    expect(publishedPointer()).toEqual({ jobId: 'job-new', createdAt: NEW });
  });

  test('is a no-op when this job already owns the pointer', async () => {
    setCurrentJob('job-a', NEW);
    setPublished('job-a', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-a', NEW),
    ).resolves.toBe(true);
    expect(publishedPointer()).toEqual({ jobId: 'job-a', createdAt: NEW });
  });

  test('backs off when a newer job publishes mid-claim', async () => {
    setCurrentJob('job-mid', OLD);

    let isInjected = false;
    bucket.onGet = async (key) => {
      if (key !== REBUILD_PUBLISHED_R2_KEY || isInjected) {
        return;
      }

      isInjected = true;
      // A newer finalizer wins the pointer between our read and our write.
      setPublished('job-newest', NEW);
    };

    await expect(
      claimPublishedPointer(environment, 'job-mid', OLD),
    ).resolves.toBe(false);
    expect(publishedPointer()).toEqual({ jobId: 'job-newest', createdAt: NEW });
  });

  test('retries and wins when the interleaved publication is older', async () => {
    setCurrentJob('job-newest', NEW);

    let isInjected = false;
    bucket.onGet = async (key) => {
      if (key !== REBUILD_PUBLISHED_R2_KEY || isInjected) {
        return;
      }

      isInjected = true;
      setPublished('job-stale', OLD);
    };

    await expect(
      claimPublishedPointer(environment, 'job-newest', NEW),
    ).resolves.toBe(true);
    expect(publishedPointer()).toEqual({ jobId: 'job-newest', createdAt: NEW });
  });

  test('refuses to claim once the job is no longer current', async () => {
    setCurrentJob('job-other', NEW);

    await expect(
      claimPublishedPointer(environment, 'job-superseded', OLD),
    ).resolves.toBe(false);
    expect(publishedPointer()).toBeUndefined();
  });
});
