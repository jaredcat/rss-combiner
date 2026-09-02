#!/usr/bin/env bun
/**
 * Ensures a Workers KV namespace exists for CONFIG_KV and patches wrangler.toml
 * when the id is still the template placeholder. Intended for GitHub Actions CI.
 *
 * Requires: CLOUDFLARE_API_TOKEN
 * Optional: CLOUDFLARE_ACCOUNT_ID (required if the token can access multiple accounts)
 */

import fs from 'node:fs/promises';

const PLACEHOLDER_ID = '00000000000000000000000000000000';

function kvNamespaceTitle(workerName: string): string {
  const safe = workerName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  return `rss-combiner-kv-${safe || 'default'}`;
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

async function listKvNamespaces(
  accountId: string,
  token: string,
): Promise<Array<{ id: string; title: string }>> {
  const out: Array<{ id: string; title: string }> = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
    );
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = (await r.json()) as {
      success: boolean;
      result: Array<{ id: string; title: string }>;
      result_info?: { total_count: number };
      errors?: unknown;
    };
    if (!j.success) {
      console.error('KV namespace list failed:', j.errors);
      process.exit(1);
    }
    out.push(...j.result);
    const total = j.result_info?.total_count ?? out.length;
    if (out.length >= total || j.result.length < perPage) break;
    page += 1;
  }
  return out;
}

async function createKvNamespace(
  accountId: string,
  token: string,
  title: string,
): Promise<string> {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
    },
  );
  const j = (await r.json()) as {
    success: boolean;
    result?: { id: string; title: string };
    errors?: Array<{ code: number; message: string }>;
  };
  if (j.success && j.result?.id) {
    return j.result.id;
  }
  const msg = j.errors?.map((e) => e.message).join('; ') || 'unknown error';
  if (r.status === 400 && /already exists|unique/i.test(msg)) {
    const list = await listKvNamespaces(accountId, token);
    const found = list.find((n) => n.title === title);
    if (found) return found.id;
  }
  console.error('KV namespace create failed:', j.errors);
  process.exit(1);
}

async function ensureNamespaceId(
  accountId: string,
  token: string,
  title: string,
): Promise<string> {
  const list = await listKvNamespaces(accountId, token);
  const existing = list.find((n) => n.title === title);
  if (existing) {
    console.log(`Using existing KV namespace "${title}" (${existing.id})`);
    return existing.id;
  }
  console.log(`Creating KV namespace "${title}"...`);
  return createKvNamespace(accountId, token, title);
}

function patchWranglerKvId(content: string, newId: string): string {
  if (!content.includes(`id = "${PLACEHOLDER_ID}"`)) {
    console.error(
      'Expected placeholder KV id in wrangler.toml; refusing to patch ambiguously.',
    );
    process.exit(1);
  }
  return content.replace(`id = "${PLACEHOLDER_ID}"`, `id = "${newId}"`);
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

  if (!raw.includes(`id = "${PLACEHOLDER_ID}"`)) {
    console.log(
      'KV id in wrangler.toml is not the template placeholder; leaving file unchanged.',
    );
    return;
  }

  const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(raw);
  if (!nameMatch) {
    console.error('Could not parse worker name from wrangler.toml');
    process.exit(1);
  }
  const workerName = nameMatch[1];
  const title = kvNamespaceTitle(workerName);
  const newId = await ensureNamespaceId(accountId, token, title);
  const patched = patchWranglerKvId(raw, newId);
  await fs.writeFile(wranglerPath, patched, 'utf-8');
  console.log(`Patched wrangler.toml with KV namespace id ${newId}`);
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
