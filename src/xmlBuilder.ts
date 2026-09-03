import { XMLParser } from 'fast-xml-parser';
import RSS from 'rss';
import type { AppConfig, CoverMode } from './config';
import { defaultFetchFeedText, getPreviewFeedText } from './feedFetch';

/** RSS `pubDate` may be a string or `{ '#text': string }` from fast-xml-parser. */
function normalizeRssText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && '#text' in value) {
    return String((value as { '#text': unknown })['#text']);
  }
  return '';
}

type CustomItem = {
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

async function parseFeed(
  url: string,
  feedConfig: {
    cutoffYear?: string;
    yearCutoff?: number;
    defaultCutoffYear: number;
    mergeTimeline?: boolean;
  },
  fetchFeedText: (url: string) => Promise<string>,
): Promise<{ title: string; items: CustomItem[]; image?: string }> {
  const text = await fetchFeedText(url);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Large podcast feeds (e.g. HTML in descriptions) can exceed the default 1000 entity expansions.
    processEntities: {
      maxTotalExpansions: 50_000,
      maxExpandedLength: 5_000_000,
    },
  });
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
                value: item.guid['#text'] || item.guid,
                isPermaLink: item.guid['@_isPermaLink'] === 'true',
              }
            : undefined,
          description: item.description || '',
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
    .sort(
      (ep1: CustomItem, ep2: CustomItem) =>
        ep1.sortDate.getTime() - ep2.sortDate.getTime(),
    );

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
): { 'itunes:image': { _attr: { href: string } } } | false {
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

export class XMLBuilder {
  static async fetchXml(
    config: AppConfig,
    options: {
      quiet?: boolean;
      cacheFeedBodies?: boolean;
      fetchFeedText?: (url: string) => Promise<string>;
      /** Cap episodes in the output. Used by admin preview. */
      maxItems?: number;
      /** Which end of the sorted timeline to keep when maxItems is set. Default newest. */
      itemSlice?: 'newest' | 'oldest';
      includeFeedChannelTitles: true;
    },
  ): Promise<{
    xml: string;
    channelTitles: string[];
    previewTruncated?: boolean;
    previewTotalItems?: number;
    previewSlice?: 'newest' | 'oldest';
  }>;
  static async fetchXml(
    config: AppConfig,
    options?: {
      quiet?: boolean;
      /** When true (admin preview), reuse in-memory + edge-cached source RSS bodies. */
      cacheFeedBodies?: boolean;
      /** Override how feed XML is loaded (tests). */
      fetchFeedText?: (url: string) => Promise<string>;
      maxItems?: number;
      itemSlice?: 'newest' | 'oldest';
      includeFeedChannelTitles?: false;
    },
  ): Promise<string>;
  static async fetchXml(
    config: AppConfig,
    options?: {
      quiet?: boolean;
      cacheFeedBodies?: boolean;
      fetchFeedText?: (url: string) => Promise<string>;
      maxItems?: number;
      itemSlice?: 'newest' | 'oldest';
      includeFeedChannelTitles?: boolean;
    },
  ): Promise<
    | string
    | {
        xml: string;
        channelTitles: string[];
        previewTruncated?: boolean;
        previewTotalItems?: number;
        previewSlice?: 'newest' | 'oldest';
      }
  > {
    if (!options?.quiet) {
      console.log('Collecting feed configs...');
    }
    const feedImageUrl = config.feedImageUrl;
    const feedTitle = config.feedTitle;
    const base = config.publicBaseUrl.replace(/\/$/, '');
    const feedUrl = `${base}/podcasts.xml`;

    const feed = new RSS({
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
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- XML namespace identifiers
        itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
        content: 'http://purl.org/rss/1.0/modules/content/',
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

    const feeds = config.feeds;
    const defaultYear = config.defaultCutoff.year;
    const defaultMonth = config.defaultCutoff.month;
    const defaultDay = config.defaultCutoff.day;

    if (!options?.quiet) {
      console.log(`Found ${feeds.length} feeds to process`);
    }

    const fetchFeedText =
      options?.fetchFeedText ??
      (options?.cacheFeedBodies ? getPreviewFeedText : defaultFetchFeedText);

    const allItems: {
      item: CustomItem;
      feedTitle: string;
      feedImage?: string;
    }[] = [];

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
            const parsedFeed = await parseFeed(
              feedConfig.url,
              {
                yearCutoff: feedConfig.cutoffYear
                  ? Number.parseInt(feedConfig.cutoffYear, 10)
                  : undefined,
                defaultCutoffYear: Number.parseInt(defaultYear, 10),
                mergeTimeline: feedConfig.mergeTimeline,
              },
              fetchFeedText,
            );

            const chTitle =
              typeof parsedFeed.title === 'string'
                ? parsedFeed.title
                : String(parsedFeed.title ?? '');
            channelTitles[feedIndex] = chTitle.trim();

            parsedFeed.items.forEach((item) => {
              if (item.pubDate) {
                const pubDate = new Date(item.pubDateOriginal || '');
                const cutoffDate = new Date(
                  Number.parseInt(feedConfig.cutoffYear || defaultYear, 10),
                  Number.parseInt(feedConfig.cutoffMonth || defaultMonth, 10) -
                    1,
                  Number.parseInt(feedConfig.cutoffDay || defaultDay, 10),
                );
                cutoffDate.setHours(0, 0, 0, 0);

                if (cutoffDate >= pubDate) {
                  return;
                }
                allItems.push({
                  item,
                  feedTitle: parsedFeed.title || '',
                  feedImage: parsedFeed.image,
                });
              }
            });
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

      allItems.sort(
        (a, b) => a.item.sortDate.getTime() - b.item.sortDate.getTime(),
      );

      // Sorted ascending by sortDate: oldest first, newest last.
      const itemSlice = options?.itemSlice === 'oldest' ? 'oldest' : 'newest';
      previewMeta.total = allItems.length;
      previewMeta.slice = itemSlice;
      const selected = selectPreviewItems(allItems, options?.maxItems, itemSlice);
      previewMeta.truncated = selected.truncated;
      const itemsForOutput = selected.items;

      if (itemsForOutput.length === 0) {
        const emptyXml = feed.xml({ indent: true });
        if (options?.includeFeedChannelTitles) {
          return { xml: emptyXml, channelTitles };
        }
        return emptyXml;
      }

      let episode = 0;
      let season = 1;
      let currentSeasonMonth = new Date(
        itemsForOutput[0].item.pubDate,
      ).getUTCMonth();
      itemsForOutput.forEach(({ item, feedTitle: srcFeedTitle, feedImage }) => {
        const itemTitle = `${item.title || ''} - ${srcFeedTitle}`;
        episode++;

        const itemMonth = new Date(item.pubDate).getUTCMonth();
        if (itemMonth !== currentSeasonMonth) {
          season++;
          currentSeasonMonth = itemMonth;
        }

        const imgEl = episodeItunesImageElements(
          config.coverMode,
          feedImageUrl,
          item['itunes:image'] || '',
          feedImage,
        );

        feed.item({
          title: itemTitle,
          description: item.description || item.summary || '',
          url: item.link || '',
          guid: item.guid?.value || item.link || '',
          date: new Date(item.pubDate || ''),
          enclosure: item.enclosure,
          custom_elements: [
            { 'itunes:title': itemTitle },
            { 'itunes:duration': item['itunes:duration'] || '' },
            { 'itunes:summary': item.description || item.summary || '' },
            { 'itunes:episodeType': item['itunes:episodeType'] || 'full' },
            { 'itunes:explicit': item['itunes:explicit'] || 'false' },
            { 'itunes:season': item['itunes:season'] || season },
            { 'itunes:episode': item['itunes:episode'] || episode },
            { pubDateOriginal: item.pubDateOriginal },
            imgEl,
          ].filter(Boolean),
        });
      });
    } catch (error) {
      console.error('Error processing feeds:', error);
      throw error;
    }

    const xmlOut = feed.xml({ indent: !previewMeta.truncated });
    if (options?.includeFeedChannelTitles) {
      return {
        xml: xmlOut,
        channelTitles,
        ...(previewMeta.truncated
          ? {
              previewTruncated: true,
              previewTotalItems: previewMeta.total,
              previewSlice: previewMeta.slice,
            }
          : {}),
      };
    }
    return xmlOut;
  }
}
