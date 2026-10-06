import type { KVNamespace } from '@cloudflare/workers-types';
import { describe, expect, test } from 'vitest';
import {
  assertOutputFilename,
  envToAppConfig,
  isCombinedFeedRequest,
  parseFeedType,
  parseOutputFilename,
  resolveConfig,
  type AppConfig,
} from './config.ts';
import {
  buildPodcastsXml,
  parseAndFilterFeed,
  type MergedEpisode,
} from './xml-builder.ts';
import type { Env } from './worker.ts';

function environment(overrides: Record<string, string> = {}): Env {
  return {
    DEFAULT_CUTOFF_DATE_DAY: '1',
    DEFAULT_CUTOFF_DATE_MONTH: '1',
    DEFAULT_CUTOFF_DATE_YEAR: '2024',
    FEED_INDEX_PADDING: '2',
    FEED_01_URL: 'https://example.com/a.xml',
    ...overrides,
  } as unknown as Env;
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    feedTitle: 'Mix',
    feedIndexPadding: 2,
    defaultCutoff: { day: '1', month: '1', year: '2020' },
    feeds: [{ url: 'https://example.com/a.xml' }],
    coverMode: 'source',
    publicBaseUrl: 'https://example.workers.dev',
    feedType: 'podcast',
    outputFilename: 'feed.xml',
    ...overrides,
  };
}

function episode(): MergedEpisode {
  const sortDate = new Date('2024-06-01T00:00:00.000Z');
  return {
    feedTitle: 'Source Show',
    feedUrl: 'https://example.com/a.xml',
    item: {
      title: 'Hello',
      link: 'https://example.com/hello',
      description: 'Short',
      contentEncoded: '<p>Body</p>',
      pubDate: sortDate.toUTCString(),
      pubDateOriginal: sortDate.toUTCString(),
      sortDate,
      enclosure: {
        url: 'https://example.com/a.mp3',
        type: 'audio/mpeg',
        length: '10',
      },
    },
  };
}

describe('feed type and output filename', () => {
  test('defaults missing values to podcast output at feed.xml', () => {
    expect(parseFeedType(undefined)).toBe('podcast');
    expect(parseOutputFilename(undefined)).toBe('feed.xml');
    expect(parseOutputFilename('not a file')).toBe('feed.xml');
    expect(parseOutputFilename('podcasts.xml')).toBe('podcasts.xml');
    expect(parseFeedType('generic')).toBe('generic');
  });

  test('rejects unsafe output names from the admin form', () => {
    expect(() => assertOutputFilename('../feed.xml')).toThrow(/\.xml/);
    expect(() => assertOutputFilename('feed.txt')).toThrow(/\.xml/);
    expect(assertOutputFilename('podcasts.xml')).toBe('podcasts.xml');
  });

  test('serves / and the configured filename only', () => {
    expect(isCombinedFeedRequest('/', 'feed.xml')).toBe(true);
    expect(isCombinedFeedRequest('/feed.xml', 'feed.xml')).toBe(true);
    expect(isCombinedFeedRequest('/feed.xml/', 'feed.xml')).toBe(true);
    expect(isCombinedFeedRequest('/podcasts.xml', 'feed.xml')).toBe(false);
    expect(isCombinedFeedRequest('/admin', 'feed.xml')).toBe(false);
  });

  test('keeps podcast shaping for an existing KV document and moves the public file', async () => {
    const kv = {
      get: async () =>
        JSON.stringify({
          version: 1,
          feedTitle: 'Old mix',
          feeds: [{ url: 'https://example.com/a.xml' }],
        }),
    } as unknown as KVNamespace;

    const config = await resolveConfig(environment(), kv);
    expect(config.feedType).toBe('podcast');
    expect(config.outputFilename).toBe('feed.xml');
    expect(config.feedTitle).toBe('Old mix');
  });

  test('reads feed type and filename from wrangler vars when KV omits them', () => {
    const config = envToAppConfig(
      environment({
        FEED_TYPE: 'generic',
        OUTPUT_FILENAME: 'podcasts.xml',
      }),
    );
    expect(config.feedType).toBe('generic');
    expect(config.outputFilename).toBe('podcasts.xml');
  });
});

describe('buildPodcastsXml feed types', () => {
  test('podcast output keeps iTunes episode tags and the configured URL', () => {
    const xml = buildPodcastsXml(appConfig(), [episode()]);
    expect(xml).toContain('https://example.workers.dev/feed.xml');
    expect(xml).toContain('Hello - Source Show');
    expect(xml).toContain('itunes:episode');
    expect(xml).toContain('https://example.com/a.mp3');
    expect(xml).toContain('<p>Body</p>');
    expect(xml).not.toContain('itunes:summary');
  });

  test('podcast output copies transcripts and chapters from the source item', async () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Show</title>
    <item>
      <title>Hello</title>
      <pubDate>Sat, 01 Jun 2024 00:00:00 GMT</pubDate>
      <podcast:transcript url="https://cdn.example/ep.vtt" type="text/vtt" language="en" rel="captions"/>
      <podcast:transcript url="https://cdn.example/ep.json" type="application/json" language="en"/>
      <podcast:chapters url="https://cdn.example/chapters.json" type="application/json+chapters"/>
      <podcast:transcript type="text/vtt"/>
    </item>
  </channel>
</rss>`;
    const { episodes } = await parseAndFilterFeed(
      { url: 'https://example.com/show.xml' },
      appConfig(),
      async () => source,
    );
    expect(episodes[0]?.item.transcripts).toEqual([
      {
        url: 'https://cdn.example/ep.vtt',
        type: 'text/vtt',
        language: 'en',
        rel: 'captions',
      },
      {
        url: 'https://cdn.example/ep.json',
        type: 'application/json',
        language: 'en',
      },
    ]);
    expect(episodes[0]?.item.chapters).toEqual([
      {
        url: 'https://cdn.example/chapters.json',
        type: 'application/json+chapters',
      },
    ]);

    const xml = buildPodcastsXml(appConfig(), episodes);
    expect(xml).toContain('https://podcastindex.org/namespace/1.0');
    expect(xml).toContain('https://cdn.example/ep.vtt');
    expect(xml).toContain('type="text/vtt"');
    expect(xml).toContain('rel="captions"');
    expect(xml).toContain('https://cdn.example/chapters.json');
    expect(xml).not.toContain('itunes:summary');

    const generic = buildPodcastsXml(
      appConfig({ feedType: 'generic' }),
      episodes,
    );
    expect(generic).not.toContain('podcast:');
  });

  test('generic output skips iTunes episode tags', () => {
    const xml = buildPodcastsXml(
      appConfig({ feedType: 'generic', outputFilename: 'podcasts.xml' }),
      [episode()],
    );
    expect(xml).toContain('https://example.workers.dev/podcasts.xml');
    expect(xml).toContain('Hello - Source Show');
    expect(xml).not.toContain('itunes:');
    expect(xml).toContain('https://example.com/a.mp3');
    expect(xml).toContain('<p>Body</p>');
    expect(xml).toContain('A combined RSS feed');
  });
});
