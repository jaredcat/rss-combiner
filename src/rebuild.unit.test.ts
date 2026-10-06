import { describe, expect, test } from 'vitest';
import { shouldPersistRunningStatus } from './rebuild.ts';

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
