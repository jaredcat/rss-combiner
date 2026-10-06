import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env as Environment } from './worker';

export const CONFIG_KV_KEY = 'config:v1';

export type CoverMode = 'source' | 'main' | 'per_feed_main';

/**
How the combined feed is written. One value for every source.
*/
export type FeedType = 'podcast' | 'generic';

/**
Public filename when `outputFilename` is unset. Version 1 served `podcasts.xml`.
*/
export const DEFAULT_OUTPUT_FILENAME = 'feed.xml';

const OUTPUT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.xml$/;

export interface FeedEntry {
  url: string;
  cutoffYear?: string;
  cutoffMonth?: string;
  cutoffDay?: string;
  /**
  When true, apply year-shifting for this feed (admin “Merge this feed’s timeline”).
  */
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
  /**
  `podcast` keeps iTunes season/episode/artwork tags. `generic` is plain RSS 2.0.
  Missing means podcast so existing KV documents keep their item shape.
  */
  feedType?: FeedType;
  /**
  Public path segment, e.g. `feed.xml`. Missing means `feed.xml` (version 2 default).
  */
  outputFilename?: string;
}

export interface AppConfig {
  feedTitle: string;
  feedImageUrl?: string;
  feedIndexPadding: number;
  defaultCutoff: { day: string; month: string; year: string };
  feeds: FeedEntry[];
  coverMode: CoverMode;
  publicBaseUrl: string;
  feedType: FeedType;
  outputFilename: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
Read a text field from FormData; ignore File values.
*/
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
Normalize coverMode from form/KV/unknown input.
*/
export function parseCoverMode(value: unknown): CoverMode {
  if (value === 'main') {
    return 'main';
  }
  return value === 'per_feed_main' ? 'per_feed_main' : 'source';
}

/**
Unknown or missing values stay on podcast output.
*/
export function parseFeedType(value: unknown): FeedType {
  return typeof value === 'string' && value.trim().toLowerCase() === 'generic'
    ? 'generic'
    : 'podcast';
}

export function isValidOutputFilename(value: string): boolean {
  return OUTPUT_FILENAME_PATTERN.test(value);
}

/**
Missing or invalid names become `feed.xml`. Used when reading KV or wrangler vars.
*/
export function parseOutputFilename(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_OUTPUT_FILENAME;
  }
  const name = value.trim();
  return isValidOutputFilename(name) ? name : DEFAULT_OUTPUT_FILENAME;
}

/**
Reject a non-empty admin/form value that is not a single `*.xml` file name.
*/
export function assertOutputFilename(value: string): string {
  const name = value.trim();
  if (!isValidOutputFilename(name)) {
    throw new Error(
      'Output filename must be a single name ending in .xml, using letters, numbers, dots, hyphens, or underscores.',
    );
  }
  return name;
}

export function feedPublicPath(outputFilename: string): string {
  return `/${parseOutputFilename(outputFilename)}`;
}

/**
`/` always serves the combined feed. The named path must match the configured file.
*/
export function isCombinedFeedRequest(
  pathname: string,
  outputFilename: string,
): boolean {
  const path = pathname.replace(/\/$/, '') || '/';
  return path === '/' || path === feedPublicPath(outputFilename);
}

export function isValidFeedEntry(x: unknown): x is FeedEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return isNonEmptyString(o.url);
}

/**
Parse and validate feeds from admin form fields: feed_0_url, feed_0_cutoffYear, …
*/
export function parseFeedsFromFormData(form: FormData): FeedEntry[] {
  const feeds: FeedEntry[] = [];
  for (let index = 0; index < 100; index++) {
    const url = formText(form, `feed_${index}_url`);
    if (!url) continue;
    const entry: FeedEntry = { url };
    const y = formText(form, `feed_${index}_cutoffYear`);
    const m = formText(form, `feed_${index}_cutoffMonth`);
    const d = formText(form, `feed_${index}_cutoffDay`);
    if (y) entry.cutoffYear = y;
    if (m) entry.cutoffMonth = m;
    if (d) entry.cutoffDay = d;
    if (
      form.get(`feed_${index}_mergeTimeline`) === 'on' ||
      form.get(`feed_${index}_dateSync`) === 'on'
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
  return (
    o.version === 1 &&
    Array.isArray(o.feeds) &&
    o.feeds.length > 0 &&
    o.feeds.every(isValidFeedEntry)
  );
}

/**
Build config from wrangler [vars] / Env only (local scripts, first deploy).
*/
export function envToAppConfig(environment: Environment): AppConfig {
  const padding = Math.trunc(Number(environment.FEED_INDEX_PADDING || '2'));
  const feeds: FeedEntry[] = [];
  const pad = Number.isFinite(padding) ? padding : 2;

  for (let index = 1; index <= 99; index++) {
    const paddedIndex = index.toString().padStart(pad, '0');
    const url = environment[`FEED_${paddedIndex}_URL`];
    if (!isNonEmptyString(url)) {
      break;
    }
    feeds.push({
      url: url,
      cutoffYear: environment[`FEED_${paddedIndex}_CUTOFF_YEAR`] as
        string | undefined,
      cutoffMonth: environment[`FEED_${paddedIndex}_CUTOFF_MONTH`] as
        string | undefined,
      cutoffDay: environment[`FEED_${paddedIndex}_CUTOFF_DAY`] as
        string | undefined,
      mergeTimeline:
        environment[`FEED_${paddedIndex}_MERGE_TIMELINE`] === 'true' ||
        environment[`FEED_${paddedIndex}_DATE_SYNC`] === 'true',
    });
  }

  const base =
    (environment.PUBLIC_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
    '';
  const feedType = parseFeedType(environment.FEED_TYPE);

  return {
    feedTitle:
      (environment.FEED_TITLE as string) ||
      (feedType === 'generic'
        ? 'My Combined Feed'
        : 'My Combined Podcast Feed'),
    feedImageUrl: environment.FEED_IMAGE_URL,
    feedIndexPadding: pad,
    defaultCutoff: {
      day: environment.DEFAULT_CUTOFF_DATE_DAY || '1',
      month: environment.DEFAULT_CUTOFF_DATE_MONTH || '1',
      year: environment.DEFAULT_CUTOFF_DATE_YEAR || '2024',
    },
    feeds,
    coverMode: 'source',
    publicBaseUrl:
      base || 'https://your-worker-name.your-subdomain.workers.dev',
    feedType,
    outputFilename: parseOutputFilename(environment.OUTPUT_FILENAME),
  };
}

function mergeStored(
  stored: StoredConfig,
  environment: Environment,
): AppConfig {
  const fallback = envToAppConfig(environment);
  const pad = stored.feedIndexPadding
    ? Math.trunc(Number(stored.feedIndexPadding))
    : fallback.feedIndexPadding;

  return {
    feedTitle: stored.feedTitle ?? fallback.feedTitle,
    feedImageUrl: stored.feedImageUrl ?? fallback.feedImageUrl,
    feedIndexPadding: Number.isFinite(pad) ? pad : fallback.feedIndexPadding,
    defaultCutoff: stored.defaultCutoff
      ? {
          day: stored.defaultCutoff.day,
          month: stored.defaultCutoff.month,
          year: stored.defaultCutoff.year,
        }
      : fallback.defaultCutoff,
    feeds: (stored.feeds ?? []).map((f) => {
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
    feedType: parseFeedType(stored.feedType ?? environment.FEED_TYPE),
    outputFilename: parseOutputFilename(
      stored.outputFilename ?? environment.OUTPUT_FILENAME,
    ),
  };
}

/**
If KV contains valid v1 JSON, use it (merged with env for missing optional fields).
Otherwise use env-only config.
*/
export async function resolveConfig(
  environment: Environment,
  kv?: KVNamespace,
): Promise<AppConfig> {
  if (!kv) {
    return envToAppConfig(environment);
  }

  try {
    const raw = await kv.get(CONFIG_KV_KEY);
    if (!raw) {
      return envToAppConfig(environment);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (isValidStoredConfig(parsed)) {
      return mergeStored(parsed, environment);
    }
  } catch {
    // fall through
  }

  return envToAppConfig(environment);
}

export function appConfigToStored(config: AppConfig): StoredConfig {
  return {
    version: 1,
    feedTitle: config.feedTitle,
    feedImageUrl: config.feedImageUrl,
    defaultCutoff: { ...config.defaultCutoff },
    feeds: config.feeds.map((f) => ({
      url: f.url,
      ...(f.cutoffYear != undefined &&
        f.cutoffYear !== '' && { cutoffYear: f.cutoffYear }),
      ...(f.cutoffMonth != undefined &&
        f.cutoffMonth !== '' && { cutoffMonth: f.cutoffMonth }),
      ...(f.cutoffDay != undefined &&
        f.cutoffDay !== '' && { cutoffDay: f.cutoffDay }),
      ...(f.mergeTimeline && { mergeTimeline: true }),
    })),
    coverMode: config.coverMode,
    publicBaseUrl: config.publicBaseUrl,
    feedType: config.feedType,
    outputFilename: config.outputFilename,
  };
}
