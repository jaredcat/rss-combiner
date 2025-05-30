import type {
  ExecutionContext,
  R2Bucket,
  ScheduledEvent,
} from '@cloudflare/workers-types';
import { XMLBuilder } from './xmlBuilder';

export interface Env {
  XML_BUCKET: R2Bucket;
  // Core settings
  DEFAULT_CUTOFF_DATE_DAY: string;
  DEFAULT_CUTOFF_DATE_MONTH: string;
  DEFAULT_CUTOFF_DATE_YEAR: string;
  FEED_INDEX_PADDING: string;
  // Dynamic feed variables
  [key: string]: string | R2Bucket; // Allows any string key with string or R2Bucket value
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      const xml = await generateXml(env, { quiet: false });
      await env.XML_BUCKET.put('podcasts.xml', xml, {
        httpMetadata: {
          contentType: 'application/xml',
        },
      });
      console.log('XML file updated successfully');
    } catch (error) {
      console.error('Error in scheduled task:', error);
    }
  },

  // Handle HTTP requests
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Add deployment trigger
    if (url.pathname === '/deploy-trigger') {
      try {
        const xml = await generateXml(env, { quiet: false });
        await env.XML_BUCKET.put('podcasts.xml', xml, {
          httpMetadata: {
            contentType: 'application/xml',
          },
        });
        return new Response('XML generated successfully', { status: 200 });
      } catch (error) {
        return new Response(
          `Failed to generate XML: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
          { status: 500 },
        );
      }
    }

    if (
      !url.pathname ||
      url.pathname === '/' ||
      url.pathname === '/podcasts.xml'
    ) {
      try {
        const obj = await env.XML_BUCKET.get('podcasts.xml');
        if (!obj) {
          return new Response('File not found', { status: 404 });
        }

        return new Response(obj.body as unknown as BodyInit, {
          headers: {
            'content-type': 'application/xml',
            'cache-control': 'public, max-age=3600', // 1 hours
          },
        });
      } catch (error) {
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    if (url.pathname === '/healthcheck') {
      try {
        const obj = await env.XML_BUCKET.head('podcasts.xml');
        return new Response(
          JSON.stringify({
            status: 'healthy',
            lastModified: obj?.uploaded,
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

const generateXml = XMLBuilder.fetchXml;
