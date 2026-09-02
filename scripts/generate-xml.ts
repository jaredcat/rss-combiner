import { parse } from '@iarna/toml';
import fs from 'node:fs/promises';
import { envToAppConfig } from '../src/config';
import type { Env } from '../src/worker';
import { XMLBuilder } from '../src/xmlBuilder';

function tomlScalarToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadWranglerConfig(): Promise<Env> {
  const wranglerContent = await fs.readFile('wrangler.toml', 'utf-8');
  const config = parse(wranglerContent);

  const env: Record<string, unknown> = {
    ...(isPlainObject(config.vars) ? config.vars : undefined),
  };

  // Add feed variables from top level config
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith('FEED_')) {
      continue;
    }
    const asString = tomlScalarToString(value);
    if (asString !== undefined) {
      env[key] = asString;
    }
  }

  return env as Env;
}

async function generateXml() {
  try {
    const env = await loadWranglerConfig();
    const config = envToAppConfig(env);
    const xml = await XMLBuilder.fetchXml(config, { quiet: true });
    console.log(xml);
  } catch (error) {
    console.error('Error generating XML:', error);
    process.exit(1);
  }
}

await generateXml();
