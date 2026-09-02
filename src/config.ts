import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env } from './worker';

export const CONFIG_KV_KEY = 'config:v1';

export type CoverMode = 'source' | 'main' | 'per_feed_main';

export interface FeedEntry {
  url: string;
  cutoffYear?: string;
  cutoffMonth?: string;
  cutoffDay?: string;
  /** When true, apply year-shifting for this feed (admin “Merge this feed’s timeline”). */
  mergeTimeline?: boolean;
}

export interface StoredConfig {
  version: 1;
  feedTitle?: string;
  feedImageUrl?: string;
  feedIndexPadding?: string;
  defaultCutoff?: { day: string; month: string; year: string };
  feeds?: FeedEntry[];
  coverMode?: CoverMode;
  publicBaseUrl?: string;
}

export interface AppConfig {
  feedTitle: string;
  feedImageUrl?: string;
  feedIndexPadding: number;
  defaultCutoff: { day: string; month: string; year: string };
  feeds: FeedEntry[];
  coverMode: CoverMode;
  publicBaseUrl: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Read a text field from FormData; ignore File values. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalize coverMode from form/KV/unknown input. */
export function parseCoverMode(value: unknown): CoverMode {
  if (value === 'main') {
    return 'main';
  }
  if (value === 'per_feed_main') {
    return 'per_feed_main';
  }
  return 'source';
}

export function isValidFeedEntry(x: unknown): x is FeedEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return isNonEmptyString(o.url);
}

/** Parse and validate feeds from admin form fields: feed_0_url, feed_0_cutoffYear, … */
export function parseFeedsFromFormData(form: FormData): FeedEntry[] {
  const feeds: FeedEntry[] = [];
  for (let i = 0; i < 100; i++) {
    const url = formText(form, `feed_${i}_url`);
    if (!url) continue;
    const entry: FeedEntry = { url };
    const y = formText(form, `feed_${i}_cutoffYear`);
    const m = formText(form, `feed_${i}_cutoffMonth`);
    const d = formText(form, `feed_${i}_cutoffDay`);
    if (y) entry.cutoffYear = y;
    if (m) entry.cutoffMonth = m;
    if (d) entry.cutoffDay = d;
    if (
      form.get(`feed_${i}_mergeTimeline`) === 'on' ||
      form.get(`feed_${i}_dateSync`) === 'on'
    ) {
      entry.mergeTimeline = true;
    }
    feeds.push(entry);
  }
  if (feeds.length === 0) {
    throw new Error('Add at least one source feed with a URL');
  }
  return feeds;
}

function isValidStoredConfig(raw: unknown): raw is StoredConfig {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.feeds) || o.feeds.length === 0) return false;
  return o.feeds.every(isValidFeedEntry);
}

/** Build config from wrangler [vars] / Env only (local scripts, first deploy). */
export function envToAppConfig(env: Env): AppConfig {
  const padding = Number.parseInt(String(env.FEED_INDEX_PADDING || '2'), 10);
  const feeds: FeedEntry[] = [];
  const pad = Number.isFinite(padding) ? padding : 2;

  for (let i = 1; i <= 99; i++) {
    const paddedIndex = i.toString().padStart(pad, '0');
    const urlKey = `FEED_${paddedIndex}_URL`;
    if (urlKey in env && isNonEmptyString(env[urlKey])) {
      feeds.push({
        url: String(env[urlKey]),
        cutoffYear: env[`FEED_${paddedIndex}_CUTOFF_YEAR`] as
          | string
          | undefined,
        cutoffMonth: env[`FEED_${paddedIndex}_CUTOFF_MONTH`] as
          | string
          | undefined,
        cutoffDay: env[`FEED_${paddedIndex}_CUTOFF_DAY`] as string | undefined,
        mergeTimeline:
          env[`FEED_${paddedIndex}_MERGE_TIMELINE`] === 'true' ||
          env[`FEED_${paddedIndex}_DATE_SYNC`] === 'true',
      });
    } else {
      break;
    }
  }

  const base =
    (env.PUBLIC_BASE_URL as string | undefined)?.replace(/\/$/, '') || '';

  return {
    feedTitle: (env.FEED_TITLE as string) || 'My Combined Podcast Feed',
    feedImageUrl: env.FEED_IMAGE_URL as string | undefined,
    feedIndexPadding: pad,
    defaultCutoff: {
      day: String(env.DEFAULT_CUTOFF_DATE_DAY || '1'),
      month: String(env.DEFAULT_CUTOFF_DATE_MONTH || '1'),
      year: String(env.DEFAULT_CUTOFF_DATE_YEAR || '2024'),
    },
    feeds,
    coverMode: 'source',
    publicBaseUrl:
      base || 'https://your-worker-name.your-subdomain.workers.dev',
  };
}

function mergeStored(stored: StoredConfig, env: Env): AppConfig {
  const fallback = envToAppConfig(env);
  const pad = stored.feedIndexPadding
    ? Number.parseInt(String(stored.feedIndexPadding), 10)
    : fallback.feedIndexPadding;

  return {
    feedTitle: stored.feedTitle ?? fallback.feedTitle,
    feedImageUrl: stored.feedImageUrl ?? fallback.feedImageUrl,
    feedIndexPadding: Number.isFinite(pad) ? pad : fallback.feedIndexPadding,
    defaultCutoff: stored.defaultCutoff
      ? {
          day: String(stored.defaultCutoff.day),
          month: String(stored.defaultCutoff.month),
          year: String(stored.defaultCutoff.year),
        }
      : fallback.defaultCutoff,
    feeds: stored.feeds!.map((f) => {
      return {
        url: f.url,
        cutoffYear: f.cutoffYear,
        cutoffMonth: f.cutoffMonth,
        cutoffDay: f.cutoffDay,
        mergeTimeline: f.mergeTimeline === true,
      };
    }),
    coverMode: parseCoverMode(stored.coverMode),
    publicBaseUrl:
      stored.publicBaseUrl?.replace(/\/$/, '') || fallback.publicBaseUrl,
  };
}

/**
 * If KV contains valid v1 JSON, use it (merged with env for missing optional fields).
 * Otherwise use env-only config.
 */
export async function resolveConfig(
  env: Env,
  kv?: KVNamespace,
): Promise<AppConfig> {
  if (!kv) {
    return envToAppConfig(env);
  }

  try {
    const raw = await kv.get(CONFIG_KV_KEY);
    if (!raw) {
      return envToAppConfig(env);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (isValidStoredConfig(parsed)) {
      return mergeStored(parsed, env);
    }
  } catch {
    // fall through
  }

  return envToAppConfig(env);
}

export function appConfigToStored(config: AppConfig): StoredConfig {
  return {
    version: 1,
    feedTitle: config.feedTitle,
    feedImageUrl: config.feedImageUrl,
    defaultCutoff: { ...config.defaultCutoff },
    feeds: config.feeds.map((f) => ({
      url: f.url,
      ...(f.cutoffYear != null && f.cutoffYear !== ''
        ? { cutoffYear: f.cutoffYear }
        : {}),
      ...(f.cutoffMonth != null && f.cutoffMonth !== ''
        ? { cutoffMonth: f.cutoffMonth }
        : {}),
      ...(f.cutoffDay != null && f.cutoffDay !== ''
        ? { cutoffDay: f.cutoffDay }
        : {}),
      ...(f.mergeTimeline ? { mergeTimeline: true } : {}),
    })),
    coverMode: config.coverMode,
    publicBaseUrl: config.publicBaseUrl,
  };
}
