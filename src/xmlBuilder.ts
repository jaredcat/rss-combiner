import { XMLParser } from 'fast-xml-parser';
import RSS from 'rss';
import type { Env } from './worker';

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
  'itunes:season': number;
  'itunes:episode': number;
  'itunes:episodeType': string;
  pubDateOriginal: string;
  sortDate: Date;
};

async function parseFeed(
  url: string,
  feedConfig: {
    cutoffYear?: string;
    yearCutoff?: number;
    defaultCutoffYear: number;
    dateSync?: boolean;
  },
): Promise<{ title: string; items: CustomItem[]; image?: string }> {
  const response = await fetch(url);
  const text = await response.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const result = parser.parse(text);
  const channel = result.rss.channel;

  const today = new Date();
  today.setHours(23, 59, 59);

  const items = (channel.item || [])
    .map((item: any) => {
      const originalDate = new Date(item.pubDate || '');
      let sortDate = new Date(originalDate);

      // Add dateSync logic
      if (feedConfig.dateSync) {
        const pseudoNow = new Date();
        pseudoNow.setHours(23, 59, 59);
        pseudoNow.setDate(pseudoNow.getDate() + 1);
        if (feedConfig.yearCutoff) {
          pseudoNow.setFullYear(feedConfig.yearCutoff);
        }
        if (sortDate.getTime() > pseudoNow.getTime()) {
          return null;
        }
      }

      // Adjust year if needed
      if (
        feedConfig.yearCutoff &&
        feedConfig.yearCutoff < feedConfig.defaultCutoffYear
      ) {
        const yearDiff = feedConfig.defaultCutoffYear - feedConfig.yearCutoff;
        sortDate.setFullYear(sortDate.getFullYear() + yearDiff);
      }

      // Skip future dates
      if (sortDate > today) {
        return null;
      }

      return {
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
      };
    })
    .filter(Boolean) // Remove null items
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

export class XMLBuilder {
  static async fetchXml(
    env: Env,
    options?: { quiet?: boolean },
  ): Promise<string> {
    if (!options?.quiet) {
      console.log('Collecting feed configs...');
    }
    const feedImageUrl = env.FEED_IMAGE_URL as string | undefined;
    const feedTitle = env.FEED_TITLE as string | undefined;

    const feed = new RSS({
      title: feedTitle || 'My Combined Podcast Feed',
      description: 'A combined feed of all my favorite podcasts',
      feed_url:
        'https://your-worker-name.your-subdomain.workers.dev/podcasts.xml',
      site_url: 'https://your-worker-name.your-subdomain.workers.dev',
      generator: 'Cloudflare Worker RSS Combiner',
      language: 'en',
      ...(feedImageUrl && {
        image_url: feedImageUrl,
        image: {
          url: feedImageUrl,
          title: feedTitle || 'My Combined Podcast Feed',
          link: 'https://your-worker-name.your-subdomain.workers.dev',
        },
      }),
      custom_namespaces: {
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

    // Get all feed URLs from environment variables
    const feeds: {
      url: string;
      cutoffYear?: string;
      cutoffMonth?: string;
      cutoffDay?: string;
      dateSync?: boolean;
    }[] = [];
    const padding = parseInt(env.FEED_INDEX_PADDING);

    for (let i = 1; i <= 99; i++) {
      const paddedIndex = i.toString().padStart(padding, '0');
      const urlKey = `FEED_${paddedIndex}_URL`;

      if (urlKey in env) {
        if (!options?.quiet) {
          console.log(`Found feed ${urlKey}:`, env[urlKey]);
        }
        feeds.push({
          url: env[urlKey] as string,
          cutoffYear: env[`FEED_${paddedIndex}_CUTOFF_YEAR`] as string,
          cutoffMonth: env[`FEED_${paddedIndex}_CUTOFF_MONTH`] as string,
          cutoffDay: env[`FEED_${paddedIndex}_CUTOFF_DAY`] as string,
          dateSync: env[`FEED_${paddedIndex}_DATE_SYNC`] === 'true',
        });
      } else {
        break;
      }
    }

    if (!options?.quiet) {
      console.log(`Found ${feeds.length} feeds to process`);
    }

    // Store all items to sort them together
    const allItems: {
      item: CustomItem;
      feedTitle: string;
      feedImage?: string;
    }[] = [];

    try {
      await Promise.all(
        feeds.map(async (feedConfig) => {
          try {
            const parsedFeed = await parseFeed(feedConfig.url, {
              yearCutoff: feedConfig.cutoffYear
                ? parseInt(feedConfig.cutoffYear)
                : undefined,
              defaultCutoffYear: parseInt(env.DEFAULT_CUTOFF_DATE_YEAR),
              dateSync: feedConfig.dateSync,
            });

            parsedFeed.items.forEach((item) => {
              if (item.pubDate) {
                const pubDate = new Date(item.pubDateOriginal || '');
                const cutoffDate = new Date(
                  parseInt(
                    feedConfig.cutoffYear || env.DEFAULT_CUTOFF_DATE_YEAR,
                  ),
                  parseInt(
                    feedConfig.cutoffMonth || env.DEFAULT_CUTOFF_DATE_MONTH,
                  ) - 1,
                  parseInt(feedConfig.cutoffDay || env.DEFAULT_CUTOFF_DATE_DAY),
                );
                cutoffDate.setHours(0, 0, 0, 0); // Set to midnight

                if (cutoffDate >= pubDate) {
                  return; // Skip this episode
                }
                allItems.push({
                  item,
                  feedTitle: parsedFeed.title || '',
                  feedImage: parsedFeed.image,
                });
              }
            });
          } catch (error) {
            throw new Error(
              `Failed to process feed ${feedConfig.url}: ${error}`,
            );
          }
        }),
      );

      // Sort all items by date, oldest first
      allItems.sort(
        (a, b) => a.item.sortDate.getTime() - b.item.sortDate.getTime(),
      );

      let episode = 0;
      let season = 1;
      let currentSeasonMonth = new Date(allItems[0].item.pubDate).getUTCMonth();
      allItems.forEach(({ item, feedTitle, feedImage }) => {
        const itemTitle = `${item.title || ''} - ${feedTitle}`;
        episode++;

        // Use UTC methods for comparison
        const itemMonth = new Date(item.pubDate).getUTCMonth();
        if (itemMonth !== currentSeasonMonth) {
          season++;
          currentSeasonMonth = itemMonth;
        }

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
            (item['itunes:image'] || feedImage) && {
              'itunes:image': {
                _attr: { href: item['itunes:image'] || feedImage },
              },
            },
          ].filter(Boolean),
        });
      });
    } catch (error) {
      console.error('Error processing feeds:', error);
      throw error;
    }

    return feed.xml({ indent: true });
  }
}
