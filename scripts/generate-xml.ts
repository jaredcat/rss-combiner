import { parse } from '@iarna/toml';
import fs from 'fs/promises';
import type { Env } from '../src/worker';
import { XMLBuilder } from '../src/xmlBuilder';

async function loadWranglerConfig(): Promise<Env> {
  const wranglerContent = await fs.readFile('wrangler.toml', 'utf-8');
  const config = parse(wranglerContent);

  const env: Record<string, string | any> = {
    ...((config.vars as Record<string, string>) || {}),
    XML_BUCKET: {} as any,
  };

  // Add feed variables from top level config
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('FEED_')) {
      env[key] = String(value);
    }
  }

  return env as Env;
}

async function generateXml() {
  try {
    const env = await loadWranglerConfig();
    const xml = await XMLBuilder.fetchXml(env, { quiet: true });
    console.log(xml);
  } catch (error) {
    console.error('Error generating XML:', error);
    process.exit(1);
  }
}

generateXml();
