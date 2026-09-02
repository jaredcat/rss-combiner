import type {
  ExecutionContext,
  KVNamespace,
  R2Bucket,
  ScheduledEvent,
} from '@cloudflare/workers-types';
import { adminFormHtml, loginHtml, type AdminPageContext } from './admin';
import {
  CONFIG_KV_KEY,
  appConfigToStored,
  parseCoverMode,
  parseFeedsFromFormData,
  resolveConfig,
  type AppConfig,
} from './config';
import { clearPreviewFeedMemoryCache } from './feedFetch';
import { XMLBuilder } from './xmlBuilder';

export interface Env {
  XML_BUCKET: R2Bucket;
  CONFIG_KV?: KVNamespace;
  /** Required for /admin UI; set with `wrangler secret put ADMIN_SECRET` */
  ADMIN_SECRET?: string;
  /** Public base for R2 object URLs, e.g. https://your-bucket.r2.dev (no trailing slash). Used for cover upload + FEED_IMAGE_URL hint. */
  R2_PUBLIC_BASE_URL?: string;
  /** Default channel image from wrangler [vars]; if it points at *.r2.dev, cover upload can derive the public URL. */
  FEED_IMAGE_URL?: string;
  DEFAULT_CUTOFF_DATE_DAY: string;
  DEFAULT_CUTOFF_DATE_MONTH: string;
  DEFAULT_CUTOFF_DATE_YEAR: string;
  FEED_INDEX_PADDING: string;
  [key: string]: string | R2Bucket | KVNamespace | undefined;
}

async function hexSha256(secret: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

async function isAdminAuthenticated(
  request: Request,
  env: Env,
): Promise<boolean> {
  const secret = env.ADMIN_SECRET;
  if (!secret) {
    return false;
  }

  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (timingSafeEqual(token, secret)) {
      return true;
    }
  }

  const cookie = request.headers.get('Cookie') || '';
  const match = /(?:^|;\s*)admin_auth=([^;]+)/.exec(cookie);
  if (!match) {
    return false;
  }
  const expected = await hexSha256(secret);
  return timingSafeEqual(match[1], expected);
}

function adminDisabledResponse(): Response {
  return new Response(
    'Admin UI is disabled. Set the ADMIN_SECRET secret (wrangler secret put ADMIN_SECRET).',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}

/** Public URL for cover.jpg after upload; null if we cannot derive an R2 public URL. */
function resolveCoverPublicUrl(env: Env): string | null {
  const base = env.R2_PUBLIC_BASE_URL?.trim();
  if (base) {
    return `${base.replace(/\/$/, '')}/cover.jpg`;
  }
  const feedImg = env.FEED_IMAGE_URL?.trim();
  if (feedImg && feedImg.includes('.r2.dev')) {
    try {
      const u = new URL(feedImg);
      if (u.hostname.endsWith('.r2.dev')) {
        return `${u.origin}/cover.jpg`;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function adminPageContext(request: Request, env: Env): AdminPageContext {
  const url = new URL(request.url);
  const deployedOrigin = `${url.protocol}//${url.host}`;
  return {
    deployedOrigin,
    deployedFeedUrl: `${deployedOrigin}/podcasts.xml`,
    coverUploadEnabled: resolveCoverPublicUrl(env) !== null,
  };
}

const COVER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const COVER_ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function appConfigFromFormData(form: FormData, env: Env): AppConfig {
  const feedTitle = form.get('feedTitle')?.toString().trim() || '';
  const feedImageUrl = form.get('feedImageUrl')?.toString().trim() || '';
  const publicBaseUrl = form.get('publicBaseUrl')?.toString().trim() || '';
  const coverMode = parseCoverMode(form.get('coverMode')?.toString());
  const pad = parseInt(String(env.FEED_INDEX_PADDING || '2'), 10);

  const feeds = parseFeedsFromFormData(form);

  return {
    feedTitle: feedTitle || 'My Combined Podcast Feed',
    feedImageUrl: feedImageUrl || undefined,
    feedIndexPadding: Number.isFinite(pad) && pad >= 1 ? pad : 2,
    defaultCutoff: {
      day:
        form.get('defaultCutoffDay')?.toString().trim() ||
        env.DEFAULT_CUTOFF_DATE_DAY ||
        '1',
      month:
        form.get('defaultCutoffMonth')?.toString().trim() ||
        env.DEFAULT_CUTOFF_DATE_MONTH ||
        '1',
      year:
        form.get('defaultCutoffYear')?.toString().trim() ||
        env.DEFAULT_CUTOFF_DATE_YEAR ||
        '2024',
    },
    feeds,
    coverMode,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
  };
}

async function generateXml(
  env: Env,
  options?: { quiet?: boolean },
): Promise<string> {
  const config = await resolveConfig(env, env.CONFIG_KV);
  return XMLBuilder.fetchXml(config, options);
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
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

  // Admin + public routing lives in one handler; complexity is mostly sequential path checks.
  // eslint-disable-next-line sonarjs/cognitive-complexity -- route table, not nested logic
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const secureCookie = url.protocol === 'https:';

    // --- Admin routes ---
    if (path === '/admin/login' && request.method === 'POST') {
      if (!env.ADMIN_SECRET) {
        return adminDisabledResponse();
      }
      const form = await request.formData();
      const password = form.get('password')?.toString() ?? '';
      if (timingSafeEqual(password, env.ADMIN_SECRET)) {
        const token = await hexSha256(env.ADMIN_SECRET);
        const sec = secureCookie ? 'Secure; ' : '';
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/admin',
            'Set-Cookie': `admin_auth=${token}; HttpOnly; ${sec}SameSite=Lax; Max-Age=86400; Path=/`,
          },
        });
      }
      return new Response(loginHtml('Invalid password'), {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (path === '/admin/logout' && request.method === 'POST') {
      const sec = secureCookie ? 'Secure; ' : '';
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/admin',
          'Set-Cookie': `admin_auth=; HttpOnly; ${sec}SameSite=Lax; Max-Age=0; Path=/`,
        },
      });
    }

    if (path === '/admin/preview' && request.method === 'POST') {
      if (!env.ADMIN_SECRET) {
        return adminDisabledResponse();
      }
      if (!(await isAdminAuthenticated(request, env))) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Unauthorized' }),
          {
            status: 401,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }

      const form = await request.formData();
      try {
        const bypass = form.get('bypassFeedCache') === '1';
        if (bypass) {
          clearPreviewFeedMemoryCache();
        }
        const config = appConfigFromFormData(form, env);
        const { xml, channelTitles } = await XMLBuilder.fetchXml(config, {
          quiet: true,
          cacheFeedBodies: !bypass,
          includeFeedChannelTitles: true,
        });
        return new Response(JSON.stringify({ ok: true, xml, channelTitles }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Preview failed';
        return new Response(JSON.stringify({ ok: false, error: msg }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    }

    if (path === '/admin/upload-cover' && request.method === 'POST') {
      if (!env.ADMIN_SECRET) {
        return adminDisabledResponse();
      }
      if (!(await isAdminAuthenticated(request, env))) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Unauthorized' }),
          {
            status: 401,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }

      const feedImageUrl = resolveCoverPublicUrl(env);
      if (!feedImageUrl) {
        return new Response(
          JSON.stringify({
            ok: false,
            error:
              'Set R2_PUBLIC_BASE_URL or FEED_IMAGE_URL to a *.r2.dev URL in wrangler [vars], then redeploy.',
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }

      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return new Response(
          JSON.stringify({ ok: false, error: 'Missing file' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }

      const blob = file as File;
      const type = blob.type || '';
      if (!COVER_ALLOWED_TYPES.has(type)) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'Use JPEG, PNG, WebP, or GIF.',
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }
      if (blob.size > COVER_UPLOAD_MAX_BYTES) {
        return new Response(
          JSON.stringify({ ok: false, error: 'File too large (max 5 MB).' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      }

      try {
        await env.XML_BUCKET.put('cover.jpg', await blob.arrayBuffer(), {
          httpMetadata: { contentType: type },
        });
        return new Response(JSON.stringify({ ok: true, feedImageUrl }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Upload failed';
        return new Response(JSON.stringify({ ok: false, error: msg }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    }

    if (path === '/admin' && request.method === 'POST') {
      if (!env.ADMIN_SECRET) {
        return adminDisabledResponse();
      }
      if (!(await isAdminAuthenticated(request, env))) {
        return new Response(loginHtml('Sign in required'), {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (!env.CONFIG_KV) {
        return new Response('CONFIG_KV binding missing', { status: 500 });
      }

      const form = await request.formData();

      try {
        if (!form.get('publicBaseUrl')?.toString().trim()) {
          throw new Error('Public base URL is required');
        }

        const config = appConfigFromFormData(form, env);

        const stored = appConfigToStored(config);
        await env.CONFIG_KV.put(CONFIG_KV_KEY, JSON.stringify(stored));

        try {
          const xml = await generateXml(env, { quiet: true });
          await env.XML_BUCKET.put('podcasts.xml', xml, {
            httpMetadata: { contentType: 'application/xml' },
          });
        } catch (e) {
          console.error('Regenerate after admin save failed:', e);
          const detail =
            e instanceof Error ? e.message : 'Unknown regeneration error';
          return new Response(
            adminFormHtml(
              config,
              `Saved to KV, but feed regeneration failed: ${detail}. /podcasts.xml may still serve the previous feed until cron runs or you save again successfully.`,
              adminPageContext(request, env),
            ),
            {
              status: 502,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          );
        }

        return new Response(null, {
          status: 302,
          headers: { Location: '/admin?saved=1' },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Invalid input';
        const current = await resolveConfig(env, env.CONFIG_KV);
        return new Response(
          adminFormHtml(
            current,
            `Error: ${msg}`,
            adminPageContext(request, env),
          ),
          {
            status: 400,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        );
      }
    }

    if (path === '/admin' && request.method === 'GET') {
      if (!env.ADMIN_SECRET) {
        return adminDisabledResponse();
      }
      if (!(await isAdminAuthenticated(request, env))) {
        return new Response(loginHtml(), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const config = await resolveConfig(env, env.CONFIG_KV);
      const saved = url.searchParams.get('saved') === '1';
      return new Response(
        adminFormHtml(
          config,
          saved ? 'Saved to KV.' : undefined,
          adminPageContext(request, env),
        ),
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    if (path === '/deploy-trigger') {
      if (!env.ADMIN_SECRET) {
        return adminDisabledResponse();
      }
      if (!(await isAdminAuthenticated(request, env))) {
        return new Response(
          'Unauthorized. Sign in at /admin or send Authorization: Bearer <ADMIN_SECRET>.',
          { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
        );
      }
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

    if (path === '/' || path === '/podcasts.xml') {
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
        console.error('Failed to serve podcasts.xml:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    if (path === '/healthcheck') {
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
