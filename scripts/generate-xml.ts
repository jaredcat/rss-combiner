import { parse } from 'smol-toml';
import fs from 'node:fs/promises';
import { envToAppConfig as environmentToAppConfig } from '../src/config';
import type { Env as Environment } from '../src/worker';
import { XMLBuilder } from '../src/xml-builder';

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

async function loadWranglerConfig(): Promise<Environment> {
  const wranglerContent = await fs.readFile('wrangler.toml', 'utf8');
  const config = parse(wranglerContent);

  const environment: Record<string, unknown> = {
    ...(isPlainObject(config.vars) && config.vars),
  };

  // Add feed variables from top level config
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith('FEED_')) {
      continue;
    }
    const asString = tomlScalarToString(value);
    if (asString !== undefined) {
      environment[key] = asString;
    }
  }

  return environment as Environment;
}

async function generateXml() {
  try {
    const environment = await loadWranglerConfig();
    const config = environmentToAppConfig(environment);
    const xml = await XMLBuilder.fetchXml(config, { quiet: true });
    console.log(xml);
  } catch (error) {
    console.error('Error generating XML:', error);
    process.exit(1);
  }
}

await generateXml();
