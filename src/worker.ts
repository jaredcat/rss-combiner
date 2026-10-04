import {
  createAdmin,
  formText,
  isAuthenticated,
  type AdminRouteContext,
} from '@codekitties/workers-mini-admin';
import type {
  ExecutionContext,
  KVNamespace,
  MessageBatch,
  Queue,
  R2Bucket,
  ScheduledEvent,
} from '@cloudflare/workers-types';
import {
  ADMIN_APP_CSS,
  ADMIN_PAGE_HINT,
  adminSettingsBody,
  type AdminPageContext,
} from './admin';
import {
  CONFIG_KV_KEY,
  appConfigToStored,
  parseCoverMode,
  parseFeedsFromFormData,
  resolveConfig,
  type AppConfig,
} from './config';
import { clearPreviewFeedMemoryCache } from './feedFetch';
import {
  getPublishedFeedObject,
  getRebuildStatus,
  handleRebuildQueueBatch,
  headPublishedFeedObject,
  rebuildStatusFlash,
  startRebuild,
  type RebuildMessage,
} from './rebuild';
import { XMLBuilder } from './xmlBuilder';

export interface Env {
  XML_BUCKET: R2Bucket;
  CONFIG_KV?: KVNamespace;
  REBUILD_QUEUE: Queue<RebuildMessage>;
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
  [key: string]: string | R2Bucket | KVNamespace | Queue<RebuildMessage> | undefined;
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

type RequestContext = {
  url: URL;
  secureCookie: boolean;
  executionCtx: ExecutionContext;
};

type RouteHandler = (
  request: Request,
  env: Env,
  ctx: RequestContext,
) => Promise<Response>;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/$/, '') || '/';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

async function renderAdminPage(request: Request, env: Env, url: URL) {
  const config = await resolveConfig(env, env.CONFIG_KV);
  const saved = url.searchParams.get('saved') === '1';
  const rebuild = await getRebuildStatus(env);
  const flash = rebuildStatusFlash(rebuild, { saved });
  const ctx = adminPageContext(request, env);
  return {
    hint: ADMIN_PAGE_HINT,
    flash,
    shellMaxWidth: '1200px',
    wrapBody: false,
    extraCss: ADMIN_APP_CSS,
    bodyAttrs: ctx.deployedOrigin
      ? { 'data-deployed-origin': ctx.deployedOrigin }
      : undefined,
    body: adminSettingsBody(config, ctx),
  };
}

async function handleAdminPreview(
  ctx: AdminRouteContext<Env>,
): Promise<Response> {
  if (!(await isAuthenticated(ctx.request, ctx.secret))) {
    return jsonError('Unauthorized', 401);
  }

  const form = await ctx.request.formData();
  try {
    const bypass = form.get('bypassFeedCache') === '1';
    if (bypass) {
      clearPreviewFeedMemoryCache();
    }
    const config = appConfigFromFormData(form, ctx.env);
    // Full feeds can be multi‑MB; returning that as JSON OOMs / exceeds limits.
    // Preview returns a 40-episode slice (cron/save still build the full feed).
    const PREVIEW_MAX_ITEMS = 40;
    const itemSlice =
      formText(form, 'previewSlice') === 'oldest' ? 'oldest' : 'newest';
    const result = await XMLBuilder.fetchXml(config, {
      quiet: true,
      cacheFeedBodies: !bypass,
      includeFeedChannelTitles: true,
      maxItems: PREVIEW_MAX_ITEMS,
      itemSlice,
      lightweight: true,
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
  ctx: AdminRouteContext<Env>,
): Promise<Response> {
  if (!(await isAuthenticated(ctx.request, ctx.secret))) {
    return jsonError('Unauthorized', 401);
  }

  const feedImageUrl = resolveCoverPublicUrl(ctx.env);
  if (!feedImageUrl) {
    return jsonError(
      'Set R2_PUBLIC_BASE_URL or FEED_IMAGE_URL to a *.r2.dev URL in wrangler [vars], then redeploy.',
      400,
    );
  }

  const parsed = parseCoverFile((await ctx.request.formData()).get('file'));
  if ('error' in parsed) {
    return jsonError(parsed.error, 400);
  }

  try {
    await ctx.env.XML_BUCKET.put(
      'cover.jpg',
      await parsed.file.arrayBuffer(),
      {
        httpMetadata: { contentType: parsed.file.type },
      },
    );
    return jsonResponse({ ok: true, feedImageUrl });
  } catch (error) {
    return jsonError(errorMessage(error, 'Upload failed'), 500);
  }
}

const admin = createAdmin<Env>({
  basePath: '/admin',
  title: 'Feed settings',
  getSecret: (env) => env.ADMIN_SECRET,
  render: ({ request, env, url }) => renderAdminPage(request, env, url),
  async save({ form, env }) {
    if (!env.CONFIG_KV) {
      throw new Error('CONFIG_KV binding missing');
    }
    if (!formText(form, 'publicBaseUrl')) {
      throw new Error('Public base URL is required');
    }

    const config = appConfigFromFormData(form, env);
    await env.CONFIG_KV.put(
      CONFIG_KV_KEY,
      JSON.stringify(appConfigToStored(config)),
    );
    // Full rebuild runs as a chain of queue jobs (one feed per invocation).
    await startRebuild(env);
    const rebuild = await getRebuildStatus(env);
    return { flash: rebuildStatusFlash(rebuild, { saved: true }) };
  },
  routes: {
    'POST /preview': handleAdminPreview,
    'POST /upload-cover': handleUploadCover,
  },
});

async function handleDeployTrigger(
  request: Request,
  env: Env,
): Promise<Response> {
  const secret = env.ADMIN_SECRET;
  if (!secret) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!(await isAuthenticated(request, secret))) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const status = await startRebuild(env);
    return new Response(
      `Rebuild queued (job ${status.jobId}). /podcasts.xml updates when the job finishes.`,
      { status: 200 },
    );
  } catch (error) {
    return new Response(
      `Failed to queue rebuild: ${errorMessage(error, 'Unknown error')}`,
      { status: 500 },
    );
  }
}

async function handlePodcastsXml(
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const obj = await getPublishedFeedObject(env);
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
    const obj = await headPublishedFeedObject(env);
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

const PATH_ROUTES: Record<string, RouteHandler> = {
  '/deploy-trigger': handleDeployTrigger,
  '/': handlePodcastsXml,
  '/podcasts.xml': handlePodcastsXml,
  '/healthcheck': handleHealthcheck,
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      const status = await startRebuild(env);
      console.log(`Rebuild queued (job ${status.jobId})`);
    } catch (error) {
      console.error('Error queueing scheduled rebuild:', error);
    }
  },

  async queue(batch: MessageBatch<RebuildMessage>, env: Env) {
    await handleRebuildQueueBatch(batch, env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const adminResponse = await admin.fetch(request, env);
    if (adminResponse) {
      return adminResponse;
    }

    const url = new URL(request.url);
    const handler = PATH_ROUTES[normalizePath(url.pathname)];
    if (!handler) {
      return new Response('Not found', { status: 404 });
    }
    return handler(request, env, {
      url,
      secureCookie: url.protocol === 'https:',
      executionCtx: ctx,
    });
  },
};
