import type {
  ExecutionContext,
  KVNamespace,
  MessageBatch,
  Queue,
  R2Bucket,
  ScheduledEvent,
} from '@cloudflare/workers-types';
import {
  createAdmin,
  formText,
  isAuthenticated,
  type AdminRouteContext,
} from 'workers-mini-admin';
import {
  ADMIN_APP_CSS,
  ADMIN_PAGE_HINT,
  adminSettingsBody,
  type AdminPageContext,
} from './admin';
import {
  CONFIG_KV_KEY,
  DEFAULT_OUTPUT_FILENAME,
  appConfigToStored,
  assertOutputFilename,
  isCombinedFeedRequest,
  parseCoverMode,
  parseFeedType,
  parseFeedsFromFormData,
  resolveConfig,
  type AppConfig,
} from './config';
import { clearPreviewFeedMemoryCache } from './feed-fetch';
import {
  getPublishedFeedObject,
  getRebuildStatus,
  handleRebuildQueueBatch,
  headPublishedFeedObject,
  rebuildStatusFlash,
  startRebuild,
  type RebuildMessage,
} from './rebuild';
import { XMLBuilder } from './xml-builder';

export interface Env {
  XML_BUCKET: R2Bucket;
  CONFIG_KV?: KVNamespace;
  REBUILD_QUEUE: Queue<RebuildMessage>;
  /**
  Required for /admin UI; set with `wrangler secret put ADMIN_SECRET`
  */
  ADMIN_SECRET?: string;
  /**
  Public base for R2 object URLs, e.g. https://your-bucket.r2.dev (no trailing slash). Used for cover upload + FEED_IMAGE_URL hint.
  */
  R2_PUBLIC_BASE_URL?: string;
  /**
  Default channel image from wrangler [vars]; if it points at *.r2.dev, cover upload can derive the public URL.
  */
  FEED_IMAGE_URL?: string;
  DEFAULT_CUTOFF_DATE_DAY: string;
  DEFAULT_CUTOFF_DATE_MONTH: string;
  DEFAULT_CUTOFF_DATE_YEAR: string;
  FEED_INDEX_PADDING: string;
  /**
  `podcast` (default) or `generic`. Used when KV has no feedType.
  */
  FEED_TYPE?: string;
  /**
  Public feed filename, e.g. feed.xml. Used when KV has no outputFilename.
  */
  OUTPUT_FILENAME?: string;
  [key: string]:
    string | R2Bucket | KVNamespace | Queue<RebuildMessage> | undefined;
}

/**
Public URL for cover.jpg after upload; undefined if we cannot derive an R2 public URL.
*/
function resolveCoverPublicUrl(environment: Env): string | undefined {
  const base = environment.R2_PUBLIC_BASE_URL?.trim();
  if (base) {
    return `${base.replace(/\/$/, '')}/cover.jpg`;
  }
  const feedImg = environment.FEED_IMAGE_URL?.trim();
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
  return undefined;
}

function adminPageContext(
  request: Request,
  environment: Env,
  outputFilename: string,
): AdminPageContext {
  const url = new URL(request.url);
  const deployedOrigin = `${url.protocol}//${url.host}`;
  return {
    deployedOrigin,
    deployedFeedUrl: `${deployedOrigin}/${outputFilename}`,
    coverUploadEnabled: resolveCoverPublicUrl(environment) !== undefined,
  };
}

const COVER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const COVER_ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function appConfigFromFormData(form: FormData, environment: Env): AppConfig {
  const feedTitle = formText(form, 'feedTitle');
  const feedImageUrl = formText(form, 'feedImageUrl');
  const publicBaseUrl = formText(form, 'publicBaseUrl');
  const coverMode = parseCoverMode(formText(form, 'coverMode'));
  const feedType = parseFeedType(formText(form, 'feedType'));
  const outputFilenameRaw = formText(form, 'outputFilename');
  const outputFilename = outputFilenameRaw
    ? assertOutputFilename(outputFilenameRaw)
    : DEFAULT_OUTPUT_FILENAME;
  const pad = Number(environment.FEED_INDEX_PADDING || '2');

  const feeds = parseFeedsFromFormData(form);

  return {
    feedTitle:
      feedTitle ||
      (feedType === 'generic' ? 'Combined Feed' : 'Combined Podcast Feed'),
    feedImageUrl: feedImageUrl || undefined,
    feedIndexPadding: Number.isFinite(pad) && pad >= 1 ? pad : 2,
    defaultCutoff: {
      day:
        formText(form, 'defaultCutoffDay') ||
        environment.DEFAULT_CUTOFF_DATE_DAY ||
        '1',
      month:
        formText(form, 'defaultCutoffMonth') ||
        environment.DEFAULT_CUTOFF_DATE_MONTH ||
        '1',
      year:
        formText(form, 'defaultCutoffYear') ||
        environment.DEFAULT_CUTOFF_DATE_YEAR ||
        '2024',
    },
    feeds,
    coverMode,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
    feedType,
    outputFilename,
  };
}

interface RequestContext {
  url: URL;
  secureCookie: boolean;
  executionCtx: ExecutionContext;
}

type RouteHandler = (
  request: Request,
  environment: Env,
  context: RequestContext,
) => Promise<Response>;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/$/, '') || '/';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE },
  });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse({ ok: false, error }, status);
}

function parseCoverFile(
  file: FormDataEntryValue | undefined,
): { error: string } | { file: File } {
  if (typeof file === 'string' || file === undefined) {
    return { error: 'Missing file' };
  }
  if (!COVER_ALLOWED_TYPES.has(file.type)) {
    return { error: 'Use JPEG, PNG, WebP, or GIF.' };
  }
  return file.size > COVER_UPLOAD_MAX_BYTES
    ? { error: 'File too large (max 5 MB).' }
    : { file };
}

async function renderAdminPage(request: Request, environment: Env, url: URL) {
  const config = await resolveConfig(environment, environment.CONFIG_KV);
  const isSaved = url.searchParams.get('saved') === '1';
  const rebuild = await getRebuildStatus(environment);
  const flash = rebuildStatusFlash(rebuild, {
    saved: isSaved,
    outputFilename: config.outputFilename,
  });
  const context = adminPageContext(request, environment, config.outputFilename);
  return {
    hint: ADMIN_PAGE_HINT,
    flash,
    shellMaxWidth: '1200px',
    wrapBody: false,
    extraCss: ADMIN_APP_CSS,
    bodyAttrs: context.deployedOrigin
      ? { 'data-deployed-origin': context.deployedOrigin }
      : undefined,
    body: adminSettingsBody(config, context),
  };
}

async function handleAdminPreview(
  context: AdminRouteContext<Env>,
): Promise<Response> {
  if (!(await isAuthenticated(context.request, context.secret))) {
    return jsonError('Unauthorized', 401);
  }

  const form = await context.request.formData();
  try {
    const isBypass = form.get('bypassFeedCache') === '1';
    if (isBypass) {
      clearPreviewFeedMemoryCache();
    }
    const config = appConfigFromFormData(form, context.env);
    // Full feeds can be multi‑MB; returning that as JSON OOMs / exceeds limits.
    // Preview returns a 40-episode slice (cron/save still build the full feed).
    const PREVIEW_MAX_ITEMS = 40;
    const itemSlice =
      formText(form, 'previewSlice') === 'oldest' ? 'oldest' : 'newest';
    const result = await XMLBuilder.fetchXml(config, {
      quiet: true,
      cacheFeedBodies: !isBypass,
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
  context: AdminRouteContext<Env>,
): Promise<Response> {
  if (!(await isAuthenticated(context.request, context.secret))) {
    return jsonError('Unauthorized', 401);
  }

  const feedImageUrl = resolveCoverPublicUrl(context.env);
  if (!feedImageUrl) {
    return jsonError(
      'Set R2_PUBLIC_BASE_URL or FEED_IMAGE_URL to a *.r2.dev URL in wrangler [vars], then redeploy.',
      400,
    );
  }

  const formData = await context.request.formData();
  const parsed = parseCoverFile(formData.get('file') ?? undefined);
  if ('error' in parsed) {
    return jsonError(parsed.error, 400);
  }

  try {
    await context.env.XML_BUCKET.put(
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
  getSecret: (environment) => environment.ADMIN_SECRET,
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
    return {
      flash: rebuildStatusFlash(rebuild, {
        saved: true,
        outputFilename: config.outputFilename,
      }),
    };
  },
  routes: {
    'POST /preview': handleAdminPreview,
    'POST /upload-cover': handleUploadCover,
  },
});

async function handleDeployTrigger(
  request: Request,
  environment: Env,
): Promise<Response> {
  const secret = environment.ADMIN_SECRET;
  if (!secret) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!(await isAuthenticated(request, secret))) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const status = await startRebuild(environment);
    const config = await resolveConfig(environment, environment.CONFIG_KV);
    return new Response(
      `Rebuild queued (job ${status.jobId}). /${config.outputFilename} updates when the job finishes.`,
      { status: 200 },
    );
  } catch (error) {
    return new Response(
      `Failed to queue rebuild: ${errorMessage(error, 'Unknown error')}`,
      { status: 500 },
    );
  }
}

async function handleFeedXml(
  _request: Request,
  environment: Env,
): Promise<Response> {
  try {
    const object = await getPublishedFeedObject(environment);
    if (!object) {
      return new Response('File not found', { status: 404 });
    }

    return new Response(object.body as unknown as BodyInit, {
      headers: {
        'content-type': 'application/xml',
        'cache-control': 'public, max-age=3600', // 1 hours
      },
    });
  } catch (error) {
    console.error('Failed to serve combined feed:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleHealthcheck(
  _request: Request,
  environment: Env,
): Promise<Response> {
  try {
    const object = await headPublishedFeedObject(environment);
    return jsonResponse({
      status: 'healthy',
      lastModified: object?.uploaded,
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
  '/healthcheck': handleHealthcheck,
};

export default {
  async scheduled(
    _event: ScheduledEvent,
    environment: Env,
    _context: ExecutionContext,
  ) {
    try {
      const status = await startRebuild(environment);
      console.log(`Rebuild queued (job ${status.jobId})`);
    } catch (error) {
      console.error('Error queueing scheduled rebuild:', error);
    }
  },

  async queue(batch: MessageBatch<RebuildMessage>, environment: Env) {
    await handleRebuildQueueBatch(batch, environment);
  },

  async fetch(request: Request, environment: Env, context: ExecutionContext) {
    const adminResponse = await admin.fetch(request, environment);
    if (adminResponse) {
      return adminResponse;
    }

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const requestContext = {
      url,
      secureCookie: url.protocol === 'https:',
      executionCtx: context,
    };
    if (Object.hasOwn(PATH_ROUTES, path)) {
      return PATH_ROUTES[path](request, environment, requestContext);
    }

    const config = await resolveConfig(environment, environment.CONFIG_KV);
    return isCombinedFeedRequest(path, config.outputFilename)
      ? handleFeedXml(request, environment)
      : new Response('Not found', { status: 404 });
  },
};
