#!/usr/bin/env bun
/**
 * Ensures a Cloudflare Queue exists for REBUILD_QUEUE and syncs the queue name
 * in wrangler.toml from the Worker `name` (rss-combiner-rebuild-<worker-name>).
 * Intended for GitHub Actions CI (and optional local use).
 *
 * Requires: CLOUDFLARE_API_TOKEN
 * Optional: CLOUDFLARE_ACCOUNT_ID (required if the token can access multiple accounts)
 *
 * Note: Enabling Queues typically requires a Workers Paid plan.
 */

import fs from 'node:fs/promises';

function queueNameForWorker(workerName: string): string {
  const safe = workerName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return `rss-combiner-rebuild-${safe || 'default'}`;
}

async function resolveAccountId(
  token: string,
  explicit?: string,
): Promise<string> {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;

  const r = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as {
    success: boolean;
    result?: Array<{ id: string; name: string }>;
    errors?: unknown;
  };
  if (!j.success || !j.result?.length) {
    console.error(
      'Could not resolve Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID in repository secrets.',
    );
    console.error(j.errors);
    process.exit(1);
  }
  if (j.result.length > 1) {
    console.error(
      'This API token can access multiple Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID in repository secrets to the account id you want (Dashboard → Workers overview → right column).',
    );
    process.exit(1);
  }
  return j.result[0].id;
}

type QueueListItem = { queue_id?: string; queue_name?: string; id?: string; name?: string };

async function listQueues(
  accountId: string,
  token: string,
): Promise<QueueListItem[]> {
  const out: QueueListItem[] = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`,
    );
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = (await r.json()) as {
      success: boolean;
      result?: QueueListItem[];
      result_info?: { total_count?: number; count?: number };
      errors?: unknown;
    };
    if (!j.success) {
      console.error('Queue list failed:', j.errors);
      process.exit(1);
    }
    const batch = j.result ?? [];
    out.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 50) break;
  }
  return out;
}

function queueItemName(q: QueueListItem): string {
  return q.queue_name || q.name || '';
}

async function createQueue(
  accountId: string,
  token: string,
  queueName: string,
): Promise<void> {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ queue_name: queueName }),
    },
  );
  const j = (await r.json()) as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
  };
  if (j.success) {
    console.log(`Created queue "${queueName}"`);
    return;
  }
  const msg = j.errors?.map((e) => e.message).join('; ') || 'unknown error';
  if (/already exists|unique|duplicate/i.test(msg)) {
    console.log(`Queue "${queueName}" already exists`);
    return;
  }
  console.error('Queue create failed:', j.errors);
  console.error(
    'Queues usually require Workers Paid. Enable Queues in the Cloudflare dashboard, or upgrade the plan, then re-run deploy.',
  );
  process.exit(1);
}

async function ensureQueue(
  accountId: string,
  token: string,
  queueName: string,
): Promise<void> {
  const list = await listQueues(accountId, token);
  const existing = list.find((q) => queueItemName(q) === queueName);
  if (existing) {
    console.log(`Using existing queue "${queueName}"`);
    return;
  }
  console.log(`Creating queue "${queueName}"...`);
  await createQueue(accountId, token, queueName);
}

/** One TOML array-of-tables section starting at `[[header]]`, ending before the next `[[`. */
function eachTomlTableBlock(
  content: string,
  header: '[[queues.producers]]' | '[[queues.consumers]]',
): Array<{ start: number; end: number; body: string }> {
  const blocks: Array<{ start: number; end: number; body: string }> = [];
  let from = 0;
  for (;;) {
    const start = content.indexOf(header, from);
    if (start < 0) {
      break;
    }
    const afterHeader = start + header.length;
    const nextTable = content.indexOf('\n[[', afterHeader);
    const end = nextTable < 0 ? content.length : nextTable;
    blocks.push({ start, end, body: content.slice(start, end) });
    from = afterHeader;
  }
  return blocks;
}

function queueAssignmentInBlock(block: string): string | null {
  const match = /^queue\s*=\s*"([^"]*)"/m.exec(block);
  return match ? match[1] : null;
}

function replaceQueueAssignment(block: string, queueName: string): string {
  if (!/^queue\s*=\s*"[^"]*"/m.test(block)) {
    return block;
  }
  return block.replace(/^queue\s*=\s*"[^"]*"/m, `queue = "${queueName}"`);
}

function blockHasBinding(block: string, bindingName: string): boolean {
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === `binding = "${bindingName}"`) {
      return true;
    }
  }
  return false;
}

/**
 * Sync only the REBUILD_QUEUE producer `queue = "..."` and any consumer that
 * already points at that same queue name. Leaves other queue bindings alone.
 */
function patchWranglerQueueNames(content: string, queueName: string): string {
  const producerBlocks = eachTomlTableBlock(content, '[[queues.producers]]');
  if (producerBlocks.length === 0) {
    console.error('wrangler.toml is missing [[queues.producers]]; refusing to patch.');
    process.exit(1);
  }

  const rebuildProducers = producerBlocks.filter((b) =>
    blockHasBinding(b.body, 'REBUILD_QUEUE'),
  );
  if (rebuildProducers.length === 0) {
    console.error(
      'wrangler.toml is missing [[queues.producers]] with binding = "REBUILD_QUEUE"',
    );
    process.exit(1);
  }
  if (rebuildProducers.length > 1) {
    console.error(
      'wrangler.toml has multiple REBUILD_QUEUE producers; refusing to patch ambiguously.',
    );
    process.exit(1);
  }

  const rebuildProducer = rebuildProducers[0];
  const oldQueueName = queueAssignmentInBlock(rebuildProducer.body);
  if (oldQueueName == null) {
    console.error(
      'REBUILD_QUEUE producer block is missing a queue = "..." line',
    );
    process.exit(1);
  }

  let patched =
    content.slice(0, rebuildProducer.start) +
    replaceQueueAssignment(rebuildProducer.body, queueName) +
    content.slice(rebuildProducer.end);

  const consumerBlocks = eachTomlTableBlock(patched, '[[queues.consumers]]');
  if (consumerBlocks.length === 0) {
    console.error('wrangler.toml is missing [[queues.consumers]]; refusing to patch.');
    process.exit(1);
  }

  let consumerPatches = 0;
  // Apply from the end so earlier offsets stay valid.
  for (let i = consumerBlocks.length - 1; i >= 0; i--) {
    const block = consumerBlocks[i];
    const q = queueAssignmentInBlock(block.body);
    if (q !== oldQueueName && q !== queueName) {
      continue;
    }
    consumerPatches += 1;
    patched =
      patched.slice(0, block.start) +
      replaceQueueAssignment(block.body, queueName) +
      patched.slice(block.end);
  }

  if (consumerPatches < 1) {
    console.error(
      `Expected a [[queues.consumers]] block for queue "${oldQueueName}" (REBUILD_QUEUE); found none.`,
    );
    process.exit(1);
  }

  return patched;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    console.error('CLOUDFLARE_API_TOKEN is required');
    process.exit(1);
  }

  const accountId = await resolveAccountId(
    token,
    process.env.CLOUDFLARE_ACCOUNT_ID,
  );

  if (process.env.GITHUB_ENV) {
    await fs.appendFile(
      process.env.GITHUB_ENV,
      `CLOUDFLARE_ACCOUNT_ID=${accountId}\n`,
    );
  }

  const wranglerPath = 'wrangler.toml';
  const raw = await fs.readFile(wranglerPath, 'utf-8');

  const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(raw);
  if (!nameMatch) {
    console.error('Could not parse worker name from wrangler.toml');
    process.exit(1);
  }
  const workerName = nameMatch[1];
  const queueName = queueNameForWorker(workerName);

  await ensureQueue(accountId, token, queueName);

  const patched = patchWranglerQueueNames(raw, queueName);
  if (patched !== raw) {
    await fs.writeFile(wranglerPath, patched, 'utf-8');
    console.log(`Patched wrangler.toml queue name to "${queueName}"`);
  } else {
    console.log(`wrangler.toml already uses queue "${queueName}"`);
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
