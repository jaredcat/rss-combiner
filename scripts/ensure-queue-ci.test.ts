import { describe, expect, test } from 'bun:test';
import {
  eachTomlTableBlock,
  patchWranglerQueueNames,
} from './ensure-queue-ci.ts';

const NEW_QUEUE = 'rss-combiner-rebuild-my-worker';

describe('patchWranglerQueueNames', () => {
  test('patches REBUILD_QUEUE when another producer precedes it', () => {
    const toml = `name = "my-worker"

[[queues.producers]]
binding = "OTHER_QUEUE"
queue = "unrelated-queue"

[[queues.producers]]
binding = "REBUILD_QUEUE"
queue = "rss-combiner-rebuild-old-name"

[[queues.consumers]]
queue = "unrelated-queue"
max_batch_size = 10

[[queues.consumers]]
queue = "rss-combiner-rebuild-old-name"
max_batch_size = 1
`;

    const patched = patchWranglerQueueNames(toml, NEW_QUEUE);

    expect(patched).toContain(`binding = "REBUILD_QUEUE"\nqueue = "${NEW_QUEUE}"`);
    expect(patched).toContain('binding = "OTHER_QUEUE"\nqueue = "unrelated-queue"');
    expect(patched).toContain(`queue = "${NEW_QUEUE}"\nmax_batch_size = 1`);
    expect(patched).toContain('queue = "unrelated-queue"\nmax_batch_size = 10');
    expect(patched).not.toContain('rss-combiner-rebuild-old-name');
  });

  test('is a no-op when already on the target queue', () => {
    const toml = `[[queues.producers]]
binding = "REBUILD_QUEUE"
queue = "${NEW_QUEUE}"

[[queues.consumers]]
queue = "${NEW_QUEUE}"
`;

    expect(patchWranglerQueueNames(toml, NEW_QUEUE)).toBe(toml);
  });

  test('leaves a trailing single-bracket table outside the block', () => {
    const toml = `[[queues.producers]]
binding = "REBUILD_QUEUE"
queue = "old"

[[queues.consumers]]
queue = "old"

[vars]
queue = "not-a-queue-binding"
`;

    const patched = patchWranglerQueueNames(toml, NEW_QUEUE);

    expect(patched).toContain('[vars]\nqueue = "not-a-queue-binding"');
  });
});

describe('eachTomlTableBlock', () => {
  test('stops a block at the next table header of any kind', () => {
    const toml = `[[queues.producers]]
binding = "REBUILD_QUEUE"
queue = "old"

[vars]
FOO = "bar"
`;

    const [block] = eachTomlTableBlock(toml, '[[queues.producers]]');

    expect(block.body).toContain('binding = "REBUILD_QUEUE"');
    expect(block.body).not.toContain('FOO');
  });
});
