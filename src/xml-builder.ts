import { XMLParser } from 'fast-xml-parser';
import RSS from 'rss';
import type { AppConfig, CoverMode, FeedEntry } from './config';
import { defaultFetchFeedText, getPreviewFeedText } from './feed-fetch';

/**
RSS `pubDate` may be a string or `{ '#text': string }` from fast-xml-parser.
*/
function normalizeRssText(value: unknown): string {
  if (value == undefined) return '';
  if (typeof value === 'string') return value;
  return typeof value === 'object' && value !== null && '#text' in value ? String((value as { '#text': unknown })['#text']) : '';
}

/**
Episode after parse + timeline shift (in-memory).
*/
export type CustomItem = {
  title: string;
  link?: string;
  guid?: {
    value: string;
    isPermaLink?: boolean;
  };
  description?: string;
  summary?: string;
  pubDate: string;
  enclosure?: {
    url: string;
    type: string;
    length: string;
  };
  'itunes:duration'?: string;
  'itunes:image'?: string;
  'itunes:explicit'?: string;
  'itunes:season'?: number;
  'itunes:episode'?: number;
  'itunes:episodeType'?: string;
  pubDateOriginal: string;
  sortDate: Date;
};

/**
One episode bound to its source feed (for merge + R2 shards).
*/
export type MergedEpisode = {
  item: CustomItem;
  feedTitle: string;
  feedUrl: string;
  feedImage?: string;
};

/**
JSON-safe shard stored in R2 during queue rebuild.
*/
export type SerializedMergedEpisode = {
  item: Omit<CustomItem, 'sortDate'> & { sortDate: string };
  feedTitle: string;
  feedUrl: string;
  feedImage?: string;
};

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareSortTimes(a: Date, b: Date): number {
  const aTime = a.getTime();
  const bTime = b.getTime();
  const isAInvalid = Number.isNaN(aTime);
  const isBInvalid = Number.isNaN(bTime);
  if (isAInvalid && isBInvalid) return 0;
  if (isAInvalid) return 1;
  return isBInvalid ? -1 : aTime - bTime;
}

function guidSortKey(item: CustomItem): string {
  const value = item.guid?.value;
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
Date first; ties use guid/link/title/source so Promise.all finish order cannot reshuffle.
*/
export function compareItems(
  a: CustomItem,
  b: CustomItem,
  aSource = '',
  bSource = '',
): number {
  const byDate = compareSortTimes(a.sortDate, b.sortDate);
  if (byDate !== 0) return byDate;

  const byGuid = compareStrings(guidSortKey(a), guidSortKey(b));
  if (byGuid !== 0) return byGuid;

  const byLink = compareStrings(a.link || '', b.link || '');
  if (byLink !== 0) return byLink;

  const byTitle = compareStrings(a.title || '', b.title || '');
  return byTitle === 0 ? compareStrings(aSource, bSource) : byTitle;
}

export function serializeMergedEpisodes(
  episodes: MergedEpisode[],
): SerializedMergedEpisode[] {
  return episodes.map((ep) => ({
    feedTitle: ep.feedTitle,
    feedUrl: ep.feedUrl,
    feedImage: ep.feedImage,
    item: {
      ...ep.item,
      sortDate: ep.item.sortDate.toISOString(),
    },
  }));
}

export function deserializeMergedEpisodes(
  episodes: SerializedMergedEpisode[],
): MergedEpisode[] {
  return episodes.map((ep) => ({
    feedTitle: ep.feedTitle,
    feedUrl: ep.feedUrl,
    feedImage: ep.feedImage,
    item: {
      ...ep.item,
      sortDate: new Date(ep.item.sortDate),
    },
  }));
}

async function parseFeed(
  url: string,
  feedConfig: {
    cutoffYear?: string;
    yearCutoff?: number;
    defaultCutoffYear: number;
    mergeTimeline?: boolean;
  },
  fetchFeedText: (url: string) => Promise<string>,
  options?: { lightweight?: boolean },
): Promise<{ title: string; items: CustomItem[]; image?: string }> {
  const text = await fetchFeedText(url);
  const isLightweight = options?.lightweight === true;
  const parser = new XMLParser(
    isLightweight
      ? {
          // Preview: skip giant HTML blobs — they dominate CPU/memory and aren't needed for a 40-ep slice.
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          processEntities: false,
          stopNodes: [
            'description',
            'content:encoded',
            'itunes:summary',
            'itunes:subtitle',
            'summary',
          ],
        }
      : {
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          // Large podcast feeds (e.g. HTML in descriptions) can exceed the default 1000 entity expansions.
          processEntities: {
            maxTotalExpansions: 50_000,
            maxExpandedLength: 5_000_000,
          },
        },
  );
  const result = parser.parse(text);
  const channel = result.rss.channel;

  const today = new Date();
  today.setHours(23, 59, 59);

  const rawItems = channel.item;
  let itemList: any[] = [];
  if (Array.isArray(rawItems)) {
    itemList = rawItems;
  } else if (rawItems) {
    itemList = [rawItems];
  }

  const items: CustomItem[] = itemList
    .flatMap((item: any): CustomItem[] => {
      const originalDate = new Date(normalizeRssText(item.pubDate));
      const sortDate = new Date(originalDate);

      // When mergeTimeline is on for this feed: shift years forward so an
      // older per-feed cutoff year lines up with the default timeline
      // (mixed chronological feed across shows).
      if (feedConfig.mergeTimeline) {
        const pseudoNow = new Date();
        pseudoNow.setHours(23, 59, 59);
        pseudoNow.setDate(pseudoNow.getDate() + 1);
        if (sortDate.getTime() > pseudoNow.getTime()) {
          return [];
        }

        if (
          feedConfig.yearCutoff &&
          feedConfig.yearCutoff < feedConfig.defaultCutoffYear
        ) {
          const yearDiff = feedConfig.defaultCutoffYear - feedConfig.yearCutoff;
          sortDate.setFullYear(sortDate.getFullYear() + yearDiff);
        }
      }

      // Skip future dates because this causes issues with some feed reader or podcast players that don't support future dates
      if (sortDate > today) {
        return [];
      }

      return [
        {
          title: item.title || '',
          link: item.link || '',
          guid: item.guid
            ? {
                value: normalizeRssText(item.guid),
                isPermaLink: item.guid['@_isPermaLink'] === 'true',
              }
            : undefined,
          description: isLightweight ? '' : item.description || '',
          pubDate: sortDate.toUTCString(), // Use adjusted date
          pubDateOriginal: originalDate.toUTCString(), // Keep original date
          enclosure: item.enclosure
            ? {
                url: item.enclosure['@_url'] || '',
                type: item.enclosure['@_type'] || '',
                length: item.enclosure['@_length'] || '',
              }
            : undefined,
          'itunes:duration': item['itunes:duration'] || '',
          'itunes:image': item['itunes:image']?.['@_href'] || '',
          'itunes:explicit': item['itunes:explicit'] || '',
          'itunes:episodeType': item['itunes:episodeType'] || '',
          sortDate,
        },
      ];
    })
    .toSorted((ep1: CustomItem, ep2: CustomItem) => compareItems(ep1, ep2));

  return {
    title: channel.title || '',
    items,
    image: channel['itunes:image']?.['@_href'] || channel.image?.url,
  };
}

function episodeItunesImageElements(
  coverMode: CoverMode,
  feedImageUrl: string | undefined,
  itemItunesImage: string,
  feedImage: string | undefined,
): false | { 'itunes:image': { _attr: { href: string } } } {
  if (coverMode === 'main') {
    if (!feedImageUrl) {
      return false;
    }
    return {
      'itunes:image': { _attr: { href: feedImageUrl } },
    };
  }
  if (coverMode === 'per_feed_main') {
    if (!feedImage) {
      return false;
    }
    return {
      'itunes:image': { _attr: { href: feedImage } },
    };
  }
  const href = itemItunesImage || feedImage;
  if (!href) {
    return false;
  }
  return {
    'itunes:image': { _attr: { href } },
  };
}

function selectPreviewItems<T>(
  items: T[],
  maxItems: number | undefined,
  itemSlice: 'newest' | 'oldest',
): { items: T[]; truncated: boolean } {
  if (
    typeof maxItems !== 'number' ||
    !Number.isFinite(maxItems) ||
    maxItems <= 0 ||
    items.length <= maxItems
  ) {
    return { items, truncated: false };
  }
  return {
    truncated: true,
    items:
      itemSlice === 'oldest'
        ? items.slice(0, maxItems)
        : items.slice(-maxItems),
  };
}

function createRssChannel(config: AppConfig): RSS {
  const feedImageUrl = config.feedImageUrl;
  const feedTitle = config.feedTitle;
  const base = config.publicBaseUrl.replace(/\/$/, '');
  const feedUrl = `${base}/podcasts.xml`;

  return new RSS({
    title: feedTitle || 'My Combined Podcast Feed',
    description: 'A combined feed of all my favorite podcasts',
    feed_url: feedUrl,
    site_url: base,
    generator: 'Cloudflare Worker RSS Combiner',
    language: 'en',
    ...(feedImageUrl && {
      image_url: feedImageUrl,
      image: {
        url: feedImageUrl,
        title: feedTitle || 'My Combined Podcast Feed',
        link: base,
      },
    }),
    custom_namespaces: {
      // Podcast namespace URIs are historically http:// (not fetch URLs).
       
      itunes: 'https://www.itunes.com/dtds/podcast-1.0.dtd',
      content: 'https://purl.org/rss/1.0/modules/content/',
    },
    custom_elements: [
      { 'itunes:author': 'RSS Feed Combiner' },
      { 'itunes:explicit': 'false' },
      { 'itunes:type': 'episodic' },
      { 'itunes:category': { _attr: { text: 'Technology' } } },
      ...(feedImageUrl
        ? [{ 'itunes:image': { _attr: { href: feedImageUrl } } }]
        : []),
    ],
  });
}

function appendEpisodesToRss(
  feed: RSS,
  config: AppConfig,
  itemsForOutput: MergedEpisode[],
  options?: { lightweight?: boolean },
): void {
  if (itemsForOutput.length === 0) {
    return;
  }

  let episode = 0;
  let season = 1;
  let currentSeasonMonth = new Date(
    itemsForOutput[0].item.pubDate,
  ).getUTCMonth();

  for (const { item, feedTitle: sourceFeedTitle, feedImage } of itemsForOutput) {
    const itemTitle = `${item.title || ''} - ${sourceFeedTitle}`;
    episode++;

    const itemMonth = new Date(item.pubDate).getUTCMonth();
    if (itemMonth !== currentSeasonMonth) {
      season++;
      currentSeasonMonth = itemMonth;
    }

    const imgElement = episodeItunesImageElements(
      config.coverMode,
      config.feedImageUrl,
      item['itunes:image'] || '',
      feedImage,
    );

    const body =
      options?.lightweight === true
        ? ''
        : item.description || item.summary || '';
    feed.item({
      title: itemTitle,
      description: body,
      url: item.link || '',
      guid: item.guid?.value || item.link || '',
      date: new Date(item.pubDate || ''),
      enclosure: item.enclosure,
      custom_elements: [
        { 'itunes:title': itemTitle },
        { 'itunes:duration': item['itunes:duration'] || '' },
        { 'itunes:summary': body },
        { 'itunes:episodeType': item['itunes:episodeType'] || 'full' },
        { 'itunes:explicit': item['itunes:explicit'] || 'false' },
        { 'itunes:season': item['itunes:season'] || season },
        { 'itunes:episode': item['itunes:episode'] || episode },
        { pubDateOriginal: item.pubDateOriginal },
        imgElement,
      ].filter(Boolean),
    });
  }
}

/**
Fetch, parse, and cutoff-filter a single source feed into merged episodes.
Used by queue rebuild (one feed per invocation) and by fetchXml.
*/
export async function parseAndFilterFeed(
  feedConfig: FeedEntry,
  config: AppConfig,
  fetchFeedText: (url: string) => Promise<string> = defaultFetchFeedText,
  options?: { lightweight?: boolean },
): Promise<{ channelTitle: string; episodes: MergedEpisode[] }> {
  const defaultYear = config.defaultCutoff.year;
  const defaultMonth = config.defaultCutoff.month;
  const defaultDay = config.defaultCutoff.day;

  const parsedFeed = await parseFeed(
    feedConfig.url,
    {
      yearCutoff: feedConfig.cutoffYear
        ? Number(feedConfig.cutoffYear)
        : undefined,
      defaultCutoffYear: Number(defaultYear),
      mergeTimeline: feedConfig.mergeTimeline,
    },
    fetchFeedText,
    { lightweight: options?.lightweight === true },
  );

  const channelTitle =
    typeof parsedFeed.title === 'string'
      ? parsedFeed.title.trim()
      : String(parsedFeed.title ?? '').trim();

  const episodes: MergedEpisode[] = [];
  for (const item of parsedFeed.items) {
    if (!item.pubDate) continue;
    const pubDate = new Date(item.pubDateOriginal || '');
    const cutoffDate = new Date(
      Number(feedConfig.cutoffYear || defaultYear),
      Number(feedConfig.cutoffMonth || defaultMonth) - 1,
      Number(feedConfig.cutoffDay || defaultDay),
    );
    cutoffDate.setHours(0, 0, 0, 0);
    if (cutoffDate >= pubDate) continue;

    episodes.push({
      item,
      feedTitle: parsedFeed.title || '',
      feedUrl: feedConfig.url,
      feedImage: parsedFeed.image,
    });
  }

  return { channelTitle, episodes };
}

/**
Merge episode lists, sort deterministically, and build podcasts.xml.
*/
export function buildPodcastsXml(
  config: AppConfig,
  allItems: MergedEpisode[],
  options?: { indent?: boolean; lightweight?: boolean },
): string {
  const feed = createRssChannel(config);
  const sorted = allItems.toSorted((a, b) =>
    compareItems(a.item, b.item, a.feedUrl, b.feedUrl),
  );
  appendEpisodesToRss(feed, config, sorted, {
    lightweight: options?.lightweight,
  });
  return feed.xml({ indent: options?.indent !== false });
}

type FetchXmlOptions = {
  quiet?: boolean;
  /**
  When true (admin preview), reuse in-memory + edge-cached source RSS bodies.
  */
  cacheFeedBodies?: boolean;
  /**
  Override how feed XML is loaded (tests).
  */
  fetchFeedText?: (url: string) => Promise<string>;
  /**
  Cap episodes in the output. Used by admin preview.
  */
  maxItems?: number;
  /**
  Which end of the sorted timeline to keep when maxItems is set. Default newest.
  */
  itemSlice?: 'newest' | 'oldest';
  /**
  Drop episode HTML bodies while parsing (admin preview).
  */
  lightweight?: boolean;
};

type FetchXmlWithTitles = {
  xml: string;
  channelTitles: string[];
  previewTruncated?: boolean;
  previewTotalItems?: number;
  previewSlice?: 'newest' | 'oldest';
};

async function fetchXml(
  config: AppConfig,
  options: FetchXmlOptions & { includeFeedChannelTitles: true },
): Promise<FetchXmlWithTitles>;
async function fetchXml(
  config: AppConfig,
  options?: FetchXmlOptions & { includeFeedChannelTitles?: false },
): Promise<string>;
async function fetchXml(
  config: AppConfig,
  options?: FetchXmlOptions & { includeFeedChannelTitles?: boolean },
): Promise<string | FetchXmlWithTitles> {
  if (!options?.quiet) {
    console.log('Collecting feed configs...');
  }

  const feeds = config.feeds;
  if (!options?.quiet) {
    console.log(`Found ${feeds.length} feeds to process`);
  }

  const fetchFeedText =
    options?.fetchFeedText ??
    (options?.cacheFeedBodies ? getPreviewFeedText : defaultFetchFeedText);

  const collectedItems: MergedEpisode[] = [];
  const channelTitles: string[] = feeds.map(() => '');
  const previewMeta: {
    truncated: boolean;
    total: number;
    slice: 'newest' | 'oldest';
  } = { truncated: false, total: 0, slice: 'newest' };

  try {
    await Promise.all(
      feeds.map(async (feedConfig, feedIndex) => {
        try {
          const { channelTitle, episodes } = await parseAndFilterFeed(
            feedConfig,
            config,
            fetchFeedText,
            { lightweight: options?.lightweight === true },
          );
          channelTitles[feedIndex] = channelTitle;
          collectedItems.push(...episodes);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Failed to process feed ${feedConfig.url}: ${message}`,
            { cause: error },
          );
        }
      }),
    );

    const allItems = collectedItems.toSorted((a, b) =>
      compareItems(a.item, b.item, a.feedUrl, b.feedUrl),
    );

    // Sorted ascending by sortDate: oldest first, newest last.
    const itemSlice = options?.itemSlice === 'oldest' ? 'oldest' : 'newest';
    previewMeta.total = allItems.length;
    previewMeta.slice = itemSlice;
    const selected = selectPreviewItems(
      allItems,
      options?.maxItems,
      itemSlice,
    );
    previewMeta.truncated = selected.truncated;
    const itemsForOutput = selected.items;

    const feed = createRssChannel(config);
    appendEpisodesToRss(feed, config, itemsForOutput, {
      lightweight: options?.lightweight,
    });

    const xmlOut = feed.xml({ indent: !previewMeta.truncated });
    if (options?.includeFeedChannelTitles) {
      return {
        xml: xmlOut,
        channelTitles,
        ...(previewMeta.truncated && {
          previewTruncated: true,
          previewTotalItems: previewMeta.total,
          previewSlice: previewMeta.slice,
        }),
      };
    }
    return xmlOut;
  } catch (error) {
    console.error('Error processing feeds:', error);
    throw error;
  }
}

export const XMLBuilder = { fetchXml };
