/**
Picks `wrangler.local.toml` when present (gitignored personal deploy config),
otherwise `wrangler.toml`. Usage: `tsx scripts/wrangler-with-local.ts deploy`
*/
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.existsSync(path.join(root, 'wrangler.local.toml'))
  ? 'wrangler.local.toml'
  : 'wrangler.toml';

const wranglerArguments = process.argv.slice(2);
if (wranglerArguments.length === 0) {
  console.error('Usage: tsx scripts/wrangler-with-local.ts <wrangler-args...>');
  process.exit(1);
}

const wranglerBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);

console.log(`Using Wrangler config: ${config}`);

const result = spawnSync(
  wranglerBin,
  ['--config', config, ...wranglerArguments],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

process.exit(result.status ?? 1);
