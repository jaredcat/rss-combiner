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
  formText,
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
    out |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
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
  if (feedImg?.includes('.r2.dev')) {
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
  const feedTitle = formText(form, 'feedTitle');
  const feedImageUrl = formText(form, 'feedImageUrl');
  const publicBaseUrl = formText(form, 'publicBaseUrl');
  const coverMode = parseCoverMode(formText(form, 'coverMode'));
  const pad = Number.parseInt(String(env.FEED_INDEX_PADDING || '2'), 10);

  const feeds = parseFeedsFromFormData(form);

  return {
    feedTitle: feedTitle || 'My Combined Podcast Feed',
    feedImageUrl: feedImageUrl || undefined,
    feedIndexPadding: Number.isFinite(pad) && pad >= 1 ? pad : 2,
    defaultCutoff: {
      day:
        formText(form, 'defaultCutoffDay') ||
        env.DEFAULT_CUTOFF_DATE_DAY ||
        '1',
      month:
        formText(form, 'defaultCutoffMonth') ||
        env.DEFAULT_CUTOFF_DATE_MONTH ||
        '1',
      year:
        formText(form, 'defaultCutoffYear') ||
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

type RequestContext = {
  url: URL;
  secureCookie: boolean;
};

type RouteHandler = (
  request: Request,
  env: Env,
  ctx: RequestContext,
) => Promise<Response>;

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/$/, '') || '/';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': HTML_CONTENT_TYPE },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE },
  });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse({ ok: false, error }, status);
}

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { Location: location };
  if (cookie) {
    headers['Set-Cookie'] = cookie;
  }
  return new Response(null, { status: 302, headers });
}

function adminAuthCookie(
  token: string,
  secure: boolean,
  maxAge: number,
): string {
  const secureFlag = secure ? 'Secure; ' : '';
  return `admin_auth=${token}; HttpOnly; ${secureFlag}SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

async function requireAdmin(
  request: Request,
  env: Env,
  unauthorized: Response,
): Promise<Response | undefined> {
  if (!env.ADMIN_SECRET) {
    return adminDisabledResponse();
  }
  if (!(await isAdminAuthenticated(request, env))) {
    return unauthorized;
  }
}

async function putPodcastsXml(env: Env, xml: string): Promise<void> {
  await env.XML_BUCKET.put('podcasts.xml', xml, {
    httpMetadata: { contentType: 'application/xml' },
  });
}

async function regeneratePodcastsXmlQuiet(env: Env): Promise<void> {
  try {
    const xml = await generateXml(env, { quiet: true });
    await putPodcastsXml(env, xml);
  } catch (error) {
    console.error('Regenerate after admin save failed:', error);
  }
}

function formPassword(form: FormData): string {
  const value = form.get('password');
  return typeof value === 'string' ? value : '';
}

function parseCoverFile(
  file: FormDataEntryValue | null,
): { error: string } | { file: File } {
  if (file == null || typeof file === 'string') {
    return { error: 'Missing file' };
  }
  if (!COVER_ALLOWED_TYPES.has(file.type)) {
    return { error: 'Use JPEG, PNG, WebP, or GIF.' };
  }
  if (file.size > COVER_UPLOAD_MAX_BYTES) {
    return { error: 'File too large (max 5 MB).' };
  }
  return { file };
}

async function handleAdminLogin(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  if (!env.ADMIN_SECRET) {
    return adminDisabledResponse();
  }
  const password = formPassword(await request.formData());
  if (!timingSafeEqual(password, env.ADMIN_SECRET)) {
    return htmlResponse(loginHtml('Invalid password'), 401);
  }
  const token = await hexSha256(env.ADMIN_SECRET);
  return redirect('/admin', adminAuthCookie(token, ctx.secureCookie, 86400));
}

async function handleAdminLogout(
  _request: Request,
  _env: Env,
  ctx: RequestContext,
): Promise<Response> {
  return redirect('/admin', adminAuthCookie('', ctx.secureCookie, 0));
}

async function handleAdminPreview(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireAdmin(
    request,
    env,
    jsonError('Unauthorized', 401),
  );
  if (denied) {
    return denied;
  }

  const form = await request.formData();
  try {
    const bypass = form.get('bypassFeedCache') === '1';
    if (bypass) {
      clearPreviewFeedMemoryCache();
    }
    const config = appConfigFromFormData(form, env);
    // Full feeds can be multi‑MB; returning that as JSON OOMs / exceeds limits.
    // Preview returns a 40-episode slice (cron/save still build the full feed).
    const PREVIEW_MAX_ITEMS = 40;
    const itemSlice =
      form.get('previewSlice')?.toString() === 'oldest' ? 'oldest' : 'newest';
    const result = await XMLBuilder.fetchXml(config, {
      quiet: true,
      cacheFeedBodies: !bypass,
      includeFeedChannelTitles: true,
      maxItems: PREVIEW_MAX_ITEMS,
      itemSlice,
    });
    return jsonResponse({
      ok: true,
      xml: result.xml,
      channelTitles: result.channelTitles,
      previewTruncated: result.previewTruncated === true,
      previewTotalItems: result.previewTotalItems,
      previewMaxItems: PREVIEW_MAX_ITEMS,
      previewSlice: result.previewSlice ?? itemSlice,
    });
  } catch (error) {
    return jsonError(errorMessage(error, 'Preview failed'), 400);
  }
}

async function handleUploadCover(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireAdmin(
    request,
    env,
    jsonError('Unauthorized', 401),
  );
  if (denied) {
    return denied;
  }

  const feedImageUrl = resolveCoverPublicUrl(env);
  if (!feedImageUrl) {
    return jsonError(
      'Set R2_PUBLIC_BASE_URL or FEED_IMAGE_URL to a *.r2.dev URL in wrangler [vars], then redeploy.',
      400,
    );
  }

  const parsed = parseCoverFile((await request.formData()).get('file'));
  if ('error' in parsed) {
    return jsonError(parsed.error, 400);
  }

  try {
    await env.XML_BUCKET.put('cover.jpg', await parsed.file.arrayBuffer(), {
      httpMetadata: { contentType: parsed.file.type },
    });
    return jsonResponse({ ok: true, feedImageUrl });
  } catch (error) {
    return jsonError(errorMessage(error, 'Upload failed'), 500);
  }
}

async function handleAdminSave(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireAdmin(
    request,
    env,
    htmlResponse(loginHtml('Sign in required'), 401),
  );
  if (denied) {
    return denied;
  }
  if (!env.CONFIG_KV) {
    return new Response('CONFIG_KV binding missing', { status: 500 });
  }

  const form = await request.formData();
  try {
    if (!formText(form, 'publicBaseUrl')) {
      throw new Error('Public base URL is required');
    }

    const config = appConfigFromFormData(form, env);
    await env.CONFIG_KV.put(
      CONFIG_KV_KEY,
      JSON.stringify(appConfigToStored(config)),
    );
    await regeneratePodcastsXmlQuiet(env);
    return redirect('/admin?saved=1');
  } catch (error) {
    const current = await resolveConfig(env, env.CONFIG_KV);
    return htmlResponse(
      adminFormHtml(
        current,
        `Error: ${errorMessage(error, 'Invalid input')}`,
        adminPageContext(request, env),
      ),
      400,
    );
  }
}

async function handleAdminGet(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const denied = await requireAdmin(request, env, htmlResponse(loginHtml()));
  if (denied) {
    return denied;
  }
  const config = await resolveConfig(env, env.CONFIG_KV);
  const saved = ctx.url.searchParams.get('saved') === '1';
  return htmlResponse(
    adminFormHtml(
      config,
      saved ? 'Saved to KV.' : undefined,
      adminPageContext(request, env),
    ),
  );
}

async function handleDeployTrigger(
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const xml = await generateXml(env, { quiet: false });
    await putPodcastsXml(env, xml);
    return new Response('XML generated successfully', { status: 200 });
  } catch (error) {
    return new Response(
      `Failed to generate XML: ${errorMessage(error, 'Unknown error')}`,
      { status: 500 },
    );
  }
}

async function handlePodcastsXml(
  _request: Request,
  env: Env,
): Promise<Response> {
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

async function handleHealthcheck(
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const obj = await env.XML_BUCKET.head('podcasts.xml');
    return jsonResponse({
      status: 'healthy',
      lastModified: obj?.uploaded,
    });
  } catch (error) {
    return jsonResponse(
      {
        status: 'unhealthy',
        error: errorMessage(error, 'Unknown error'),
      },
      500,
    );
  }
}

const METHOD_ROUTES: Record<string, RouteHandler> = {
  'POST /admin/login': handleAdminLogin,
  'POST /admin/logout': handleAdminLogout,
  'POST /admin/preview': handleAdminPreview,
  'POST /admin/upload-cover': handleUploadCover,
  'POST /admin': handleAdminSave,
  'GET /admin': handleAdminGet,
};

const PATH_ROUTES: Record<string, RouteHandler> = {
  '/deploy-trigger': handleDeployTrigger,
  '/': handlePodcastsXml,
  '/podcasts.xml': handlePodcastsXml,
  '/healthcheck': handleHealthcheck,
};

function getRouteHandler(method: string, path: string): RouteHandler | undefined {
  const byMethod = METHOD_ROUTES[`${method} ${path}`];
  if (byMethod) {
    return byMethod;
  }
  return PATH_ROUTES[path];
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      const xml = await generateXml(env, { quiet: false });
      await putPodcastsXml(env, xml);
      console.log('XML file updated successfully');
    } catch (error) {
      console.error('Error in scheduled task:', error);
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);
    const handler = getRouteHandler(
      request.method,
      normalizePath(url.pathname),
    );
    if (!handler) {
      return new Response('Not found', { status: 404 });
    }
    return handler(request, env, {
      url,
      secureCookie: url.protocol === 'https:',
    });
  },
};
