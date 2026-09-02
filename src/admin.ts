import type { AppConfig, FeedEntry } from './config';

/** Shown on admin GET when we have the incoming request (deployed URL + upload eligibility). */
export type AdminPageContext = {
  deployedOrigin: string;
  deployedFeedUrl: string;
  coverUploadEnabled: boolean;
};

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function loginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin login</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; min-height: 100vh; background: #e4e6eb; color: #1a1a1a; }
    .page-shell { max-width: 24rem; margin: 0 auto; padding: 1.25rem; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { width: 100%; background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    h1 { font-size: 1.35rem; margin: 0 0 1rem 0; }
    label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
    input[type="password"] { width: 100%; padding: 0.65rem 0.75rem; margin: 0.25rem 0 1rem; border: 1px solid #ccc; border-radius: 8px; font: inherit; min-height: 44px; }
    button { width: 100%; padding: 0.65rem 1rem; margin-top: 0.25rem; border: none; border-radius: 8px; background: #2d3748; color: #fff; font: inherit; font-weight: 600; cursor: pointer; min-height: 44px; }
    button:active { opacity: .92; }
    .err { color: #b00; margin-bottom: 1rem; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="page-shell">
  <div class="card">
  <h1>RSS Combiner admin</h1>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/admin/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
  </div>
  </div>
</body>
</html>`;
}

function feedFieldsetHtml(index: number, feed: FeedEntry): string {
  const url = feed.url ? escapeHtml(feed.url) : '';
  const cy = feed.cutoffYear ? escapeHtml(feed.cutoffYear) : '';
  const cm = feed.cutoffMonth ? escapeHtml(feed.cutoffMonth) : '';
  const cd = feed.cutoffDay ? escapeHtml(feed.cutoffDay) : '';
  const ds = feed.mergeTimeline ? ' checked' : '';

  return `<fieldset class="feed-row" data-feed-row>
    <legend>Source feed ${index + 1}</legend>
    <label>Feed URL</label>
    <input type="url" name="feed_${index}_url" value="${url}" placeholder="https://…">

    <div class="row feed-cutoffs">
      <label>Cutoff year <input type="number" name="feed_${index}_cutoffYear" min="1970" max="2100" placeholder="optional" value="${cy}"></label>
      <label>month <input type="number" name="feed_${index}_cutoffMonth" min="1" max="12" placeholder="optional" value="${cm}"></label>
      <label>day <input type="number" name="feed_${index}_cutoffDay" min="1" max="31" placeholder="optional" value="${cd}"></label>
    </div>
    <div class="feed-merge-timeline-block">
      <label class="feed-merge-timeline">
        <input type="checkbox" name="feed_${index}_mergeTimeline"${ds}>
        <span><strong>Merge this feed’s timeline</strong></span>
      </label>
      <p class="feed-merge-timeline-oneline">Turn on when this row’s cutoff year is <strong>older</strong> than the default cutoff year above—details in <strong>How cutoffs &amp; timeline merge work</strong>.</p>
    </div>
    <button type="button" class="feed-remove">Remove feed</button>
  </fieldset>`;
}

function buildFeedsSection(config: AppConfig): string {
  const list =
    config.feeds.length > 0 ? config.feeds : [{ url: '' } as FeedEntry];
  return list.map((f, i) => feedFieldsetHtml(i, f)).join('');
}

/** Template for JS: FEEDIDX replaced with row index (0, 1, …) */
const FEED_ROW_TEMPLATE = `<fieldset class="feed-row" data-feed-row>
    <legend>Source feed</legend>
    <label>Feed URL</label>
    <input type="url" name="feed_FEEDIDX_url" placeholder="https://…">
    <div class="row feed-cutoffs">
      <label>Cutoff year <input type="number" name="feed_FEEDIDX_cutoffYear" min="1970" max="2100" placeholder="optional"></label>
      <label>month <input type="number" name="feed_FEEDIDX_cutoffMonth" min="1" max="12" placeholder="optional"></label>
      <label>day <input type="number" name="feed_FEEDIDX_cutoffDay" min="1" max="31" placeholder="optional"></label>
    </div>
    <div class="feed-merge-timeline-block">
      <label class="feed-merge-timeline">
        <input type="checkbox" name="feed_FEEDIDX_mergeTimeline">
        <span><strong>Merge this feed’s timeline</strong></span>
      </label>
      <p class="feed-merge-timeline-oneline">Turn on when this row’s cutoff year is <strong>older</strong> than the default cutoff year above—details in <strong>How cutoffs &amp; timeline merge work</strong>.</p>
    </div>
    <button type="button" class="feed-remove">Remove feed</button>
  </fieldset>`;

export function adminFormHtml(
  config: AppConfig,
  flash?: string,
  ctx?: AdminPageContext,
): string {
  const mainChecked = config.coverMode === 'main' ? ' checked' : '';
  const perFeedMainChecked =
    config.coverMode === 'per_feed_main' ? ' checked' : '';
  const sourceChecked = config.coverMode === 'source' ? ' checked' : '';

  const deployedOrigin = ctx?.deployedOrigin ?? '';
  const deployedFeedUrl = ctx?.deployedFeedUrl ?? '';
  const showDeployHints = !!deployedOrigin;
  const coverUploadEnabled = ctx?.coverUploadEnabled ?? false;
  let flashClass = 'ok';
  if (flash?.startsWith('Error:')) {
    flashClass = 'flash-err';
  } else if (flash?.includes('failed')) {
    flashClass = 'warn';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Feed settings</title>
  <style>
    * { box-sizing: border-box; }
    .admin-body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; line-height: 1.45; color: #1a1a1a; background: #e4e6eb; min-height: 100vh; -webkit-text-size-adjust: 100%; }
    .page-shell { max-width: 1200px; margin: 0 auto; padding: 0.75rem 1rem 2rem; }
    @media (min-width: 640px) { .page-shell { padding: 1rem 1.25rem 2rem; } }
    .page-header { margin-bottom: 1rem; }
    .page-header h1 { font-size: clamp(1.25rem, 4vw, 1.5rem); margin: 0 0 0.5rem 0; }
    .panel-card { background: #fff; border-radius: 12px; padding: 1rem 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: 1rem; }
    @media (min-width: 640px) { .panel-card { padding: 1.15rem 1.25rem 1.35rem; } }
    .layout { display: grid; gap: 1rem; }
    @media (min-width: 960px) {
      .layout { grid-template-columns: minmax(300px, 1fr) minmax(280px, 1fr); gap: 1.25rem; align-items: start; }
    }
    .panel { min-width: 0; }
    label { display: block; margin-top: 1rem; font-weight: 600; font-size: 0.95rem; }
    label:first-of-type, .panel-card > label:first-child { margin-top: 0; }
    input[type="text"], input[type="url"], input[type="number"], textarea {
      width: 100%; padding: 0.55rem 0.65rem; font: inherit; border: 1px solid #c5c9d0; border-radius: 8px; background: #fafbfc;
    }
    input:focus { outline: 2px solid #90cdf4; outline-offset: 1px; border-color: #3182ce; }
    .row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .row label { flex: 1; min-width: min(100%, 5.5rem); margin-top: 0; }
    @media (max-width: 480px) { .row { flex-direction: column; } .row label { min-width: 100%; } }
    .hint { font-size: 0.82rem; color: #4a5568; font-weight: normal; }
    .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
    .btn-primary { padding: 0.6rem 1.1rem; border: none; border-radius: 8px; background: #2d3748; color: #fff; font: inherit; font-weight: 600; cursor: pointer; min-height: 44px; }
    .btn-primary:active { opacity: .94; }
    .btn-secondary { padding: 0.5rem 0.85rem; border: 1px solid #cbd5e0; border-radius: 8px; background: #f7fafc; font: inherit; cursor: pointer; min-height: 44px; font-size: 0.9rem; }
    .btn-secondary:active { background: #edf2f7; }
    .btn-ghost { padding: 0.5rem 0.75rem; border: none; background: transparent; color: #4a5568; font: inherit; cursor: pointer; text-decoration: underline; min-height: 44px; }
    .ok { color: #276749; margin: 0 0 0.75rem 0; font-weight: 600; }
    .warn { color: #c05600; margin: 0 0 0.75rem 0; font-weight: 600; }
    .flash-err { color: #c53030; margin: 0 0 0.75rem 0; font-weight: 600; }
    fieldset { border: 1px solid #d8dee6; padding: 0.75rem 1rem; margin-top: 1rem; border-radius: 8px; background: #fafbfc; }
    legend { padding: 0 0.35rem; font-weight: 600; }
    .feed-row { position: relative; }
    .feed-row .feed-remove { margin-top: 0.75rem; font-size: 0.9rem; }
    .feed-merge-timeline { font-weight: normal; margin-top: 0.5rem; display: flex; align-items: flex-start; gap: 0.35rem; }
    .feed-merge-timeline input { width: auto; margin: 0.2rem 0.35rem 0 0; flex-shrink: 0; }
    .feed-merge-timeline-block { margin-top: 0.75rem; }
    .feed-merge-timeline-oneline { font-size: 0.8rem; color: #666; font-weight: normal; margin: 0.3rem 0 0 0; line-height: 1.3; }
    .first-setup-guide { margin: 0.75rem 0 1rem 0; font-size: 0.88rem; border: 1px solid #cbd5e0; border-radius: 8px; padding: 0.5rem 0.75rem; background: #f7fafc; }
    .first-setup-guide summary { cursor: pointer; font-weight: 600; color: #2d3748; }
    .first-setup-guide .hint { margin: 0.65rem 0 0 0; }
    .first-setup-guide .hint p { margin: 0.45rem 0 0 0; }
    .first-setup-guide .hint p:first-child { margin-top: 0.35rem; }
    .feed-merge-timeline-explainer { margin: 0.75rem 0 1rem 0; font-size: 0.88rem; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.5rem 0.75rem; background: #fff; }
    .feed-merge-timeline-explainer summary { cursor: pointer; font-weight: 600; color: #2d3748; }
    .feed-merge-timeline-explainer .hint { margin: 0.65rem 0 0 0; }
    .feed-merge-timeline-explainer .hint p { margin: 0.45rem 0 0 0; }
    .feed-merge-timeline-explainer .hint p:first-child { margin-top: 0.35rem; }
    #feed-add { margin-top: 0.5rem; }
    .deployed-url-card { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.88rem; }
    .deployed-url-card .deployed-label { font-weight: 700; color: #2d3748; margin: 0 0 0.5rem 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .03em; }
    .deployed-line { margin: 0.35rem 0; word-break: break-all; }
    .deployed-line .k { color: #718096; margin-right: 0.35rem; }
    .deployed-url-card code { font-size: 0.8rem; background: #edf2f7; padding: 0.15rem 0.35rem; border-radius: 4px; }
    .deployed-url-card .btn-secondary { margin-top: 0.5rem; width: 100%; }
    @media (min-width: 480px) { .deployed-url-card .btn-secondary { width: auto; } }
    .cover-tools { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
    @media (min-width: 520px) { .cover-tools { flex-direction: row; flex-wrap: wrap; align-items: center; } }
    .cover-tools input[type="file"] { font: inherit; font-size: 0.85rem; max-width: 100%; }
    #cover-upload-msg { font-size: 0.82rem; }
    #preview-wrap { position: static; }
    @media (min-width: 960px) { #preview-wrap { position: sticky; top: 0.75rem; } }
    #preview-wrap h2 { margin-top: 0; font-size: 1.1rem; }
    #preview-status { font-size: 0.85rem; color: #555; min-height: 1.25em; margin-bottom: 0.35rem; }
    #preview-status.err { color: #c53030; }
    .preview-tabs { display: flex; gap: 0.35rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .preview-tabs button { font: inherit; padding: 0.45rem 0.75rem; border: 1px solid #cbd5e0; background: #f7fafc; cursor: pointer; border-radius: 8px; min-height: 40px; }
    .preview-tabs button.active { background: #2d3748; color: #fff; border-color: #2d3748; }
    #preview-rendered {
      border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; max-height: min(65vh, 42rem); overflow: auto;
      background: #fafbfc; font-size: 0.92rem;
    }
    #preview-rendered .ch-head { display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
    #preview-rendered .ch-head img { width: 120px; height: 120px; object-fit: cover; border-radius: 8px; flex-shrink: 0; background: #eee; max-width: 100%; }
    #preview-rendered .ch-meta { min-width: 0; flex: 1; }
    #preview-rendered .ch-meta h3 { margin: 0 0 0.35rem 0; font-size: 1.15rem; }
    #preview-rendered .ch-meta p { margin: 0; color: #444; font-size: 0.88rem; }
    #preview-rendered .ep { padding: 0.65rem 0; border-bottom: 1px solid #e8e8e8; display: flex; gap: 0.75rem; align-items: flex-start; }
    #preview-rendered .ep:last-child { border-bottom: none; }
    #preview-rendered .ep img { width: 56px; height: 56px; object-fit: cover; border-radius: 4px; flex-shrink: 0; background: #eee; }
    #preview-rendered .ep-body { min-width: 0; flex: 1; }
    #preview-rendered .ep-title { font-weight: 600; margin: 0 0 0.2rem 0; }
    #preview-rendered .ep-sub { font-size: 0.8rem; color: #666; margin: 0 0 0.35rem 0; }
    #preview-rendered .ep-desc { font-size: 0.85rem; color: #333; margin: 0; max-height: 4.5em; overflow: hidden; }
    #preview-xml {
      margin: 0; padding: 0.75rem; background: #f6f6f6; border: 1px solid #e2e8f0; border-radius: 8px;
      font-family: ui-monospace, monospace; font-size: 0.72rem; line-height: 1.35;
      white-space: pre-wrap; word-break: break-word; max-height: min(65vh, 42rem); overflow: auto;
    }
    #preview-xml.hidden { display: none; }
    #preview-rendered.hidden { display: none; }
    #preview-refresh-feeds { font: inherit; padding: 0.45rem 0.75rem; margin-top: 0.35rem; cursor: pointer; border-radius: 8px; border: 1px solid #cbd5e0; background: #f7fafc; min-height: 44px; }
  </style>
</head>
<body class="admin-body"${showDeployHints ? ` data-deployed-origin="${escapeHtml(deployedOrigin)}"` : ''}>
  <div class="page-shell">
  <header class="page-header">
    <h1>Feed settings</h1>
    <p class="hint">Values are stored in Workers KV and override <code>wrangler.toml</code> <code>[vars]</code> when present. Preview updates as you edit; source RSS is cached (~15 minutes per URL). Use “Refresh feed sources” for the latest upstream episodes.</p>
  </header>
  ${flash ? `<p class="${flashClass}">${escapeHtml(flash)}</p>` : ''}
  <div class="layout">
  <div class="panel">
  <form id="admin-settings-form" method="post" action="/admin">
    <div class="panel-card">
    ${
      showDeployHints
        ? `<div class="deployed-url-card">
      <p class="deployed-label">This deployment</p>
      <p class="deployed-line"><span class="k">Worker URL</span> <code>${escapeHtml(deployedOrigin)}</code></p>
      <p class="deployed-line"><span class="k">Combined RSS</span> <code>${escapeHtml(deployedFeedUrl)}</code></p>
      <button type="button" class="btn-secondary" id="use-deployed-base">Use worker URL as public base</button>
    </div>`
        : ''
    }

    <label for="feedTitle">Feed title</label>
    <input id="feedTitle" name="feedTitle" type="text" value="${escapeHtml(config.feedTitle)}" required>

    <label for="feedImageUrl">Main podcast image URL <span class="hint">(channel &amp; episode art when using “main cover” mode)</span></label>
    <input id="feedImageUrl" name="feedImageUrl" type="url" value="${escapeHtml(config.feedImageUrl || '')}" placeholder="https://…">
    ${
      coverUploadEnabled
        ? `<div class="cover-tools">
      <input type="file" id="cover-file-input" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Choose cover image file">
      <button type="button" class="btn-secondary" id="cover-upload-btn">Upload to R2</button>
      <span id="cover-upload-msg" class="hint" role="status"></span>
    </div><p class="hint">Uploads replace <code>cover.jpg</code> in your R2 bucket and fill the image URL above.</p>`
        : `<p class="hint">Browser upload needs your bucket’s public <code>*.r2.dev</code> URL: set <code>R2_PUBLIC_BASE_URL</code> or <code>FEED_IMAGE_URL</code> in <code>wrangler.toml</code>, then redeploy.</p>`
    }

    <label for="publicBaseUrl">Public base URL <span class="hint">(no trailing slash; RSS <code>link</code> / <code>atom:link</code> — usually your worker URL)</span></label>
    <input id="publicBaseUrl" name="publicBaseUrl" type="url" value="${escapeHtml(config.publicBaseUrl)}" required>

    <details class="first-setup-guide">
      <summary>First-time setup: cutoffs &amp; timeline merge</summary>
      <div class="hint">
        <p><strong>Default cutoff</strong> — Day/month/year for feeds that <em>don’t</em> use a per-row override. Only episodes published <em>after</em> this date are included. The default <strong>year</strong> is the target timeline when <strong>Merge this feed’s timeline</strong> applies year-shifting on a row (see below).</p>
        <p><strong>Per-feed cutoff</strong> — Optional year (and month/day) per row; blank fields use the default cutoff. This only controls <strong>which episodes are included</strong> (published after that date)—it does <strong>not</strong> reorder or shift dates by itself. You can set an older year (e.g. <code>2014</code> vs default <code>2024</code>) to include more of a show’s history; to <strong>interleave</strong> that show with your others you also need <strong>Merge this feed’s timeline</strong> checked on that row.</p>
        <p><strong>Merge this feed’s timeline</strong> — When checked and this row’s cutoff year is older than the default, <strong>year-shifting</strong> runs (episode dates move forward so the combined feed sorts as one mix). Leave it off to keep real published dates (only cutoff filtering applies). See <code>README.md</code> for the full walkthrough.</p>
      </div>
    </details>

    <div class="row">
      <label>Default cutoff — day <input name="defaultCutoffDay" type="number" min="1" max="31" value="${escapeHtml(config.defaultCutoff.day)}"></label>
      <label>month <input name="defaultCutoffMonth" type="number" min="1" max="12" value="${escapeHtml(config.defaultCutoff.month)}"></label>
      <label>year <input name="defaultCutoffYear" type="number" min="1970" max="2100" value="${escapeHtml(config.defaultCutoff.year)}"></label>
    </div>

    <fieldset>
      <legend>Episode artwork</legend>
      <label><input type="radio" name="coverMode" value="source"${sourceChecked}> Use source episode / feed artwork</label>
      <label><input type="radio" name="coverMode" value="per_feed_main"${perFeedMainChecked}> Use each source podcast’s channel (main) cover for all episodes from that feed</label>
      <label><input type="radio" name="coverMode" value="main"${mainChecked}> Use combined feed’s main image for every episode</label>
    </fieldset>

    <fieldset>
      <legend>Source feeds</legend>
      <p class="hint">Add one row per podcast RSS URL. Use the cutoff fields to only include episodes published <em>after</em> that date (leave blank to use the default cutoff from the top of the form). After preview, each row’s heading shows that source’s RSS channel title (not stored; updates when you preview).</p>
      <details class="feed-merge-timeline-explainer">
        <summary>How cutoffs &amp; timeline merge work</summary>
        <div class="hint">
          <p><strong>Why merge?</strong> In chronological listening, one podcast with a long history can otherwise dominate the queue. Cutoff fields alone only filter <em>which</em> episodes are included. To <strong>interleave</strong> a deep backlog with your other shows, set a <strong>per-feed cutoff year</strong> older than the default (so year-shifting can apply), <em>and</em> turn on <strong>Merge this feed’s timeline</strong>—then the app <strong>shifts years</strong> on that feed’s episodes so they sort alongside your other podcasts.</p>
          <p><strong>Cutoff date</strong> — Only episodes whose original publication date is <em>after</em> this row’s cutoff (per-feed fields, or the default at the top where blank) are candidates for the combined feed.</p>
          <p><strong>Merge this feed’s timeline</strong> — When checked <em>and</em> this row’s cutoff year is older than the default, episode dates are adjusted forward so sorting matches the mix you want. Unchecked: no year shift (only cutoff filtering). If there’s no older cutoff year on the row, leave the box off—nothing to merge.</p>
        </div>
      </details>
      <div id="feeds-container">${buildFeedsSection(config)}</div>
      <button type="button" id="feed-add">Add feed</button>
    </fieldset>

    <div class="actions">
      <button type="submit" class="btn-primary">Save to KV</button>
    </div>
    </div>
  </form>
  <form method="post" action="/admin/logout" style="margin-top:0.75rem">
    <button type="submit" class="btn-ghost">Sign out</button>
  </form>
  <p class="hint" style="margin-top:0.75rem">Saving updates <code>/podcasts.xml</code> right away. The hourly cron also refreshes the feed; use authenticated <code>/deploy-trigger</code> (Bearer token or admin cookie) for a manual rebuild.</p>
  </div>
  <div class="panel" id="preview-wrap">
    <div class="panel-card">
    <h2>Live preview</h2>
    <p id="preview-status" class="hint">Generating…</p>
    <p><button type="button" id="preview-refresh-feeds">Refresh feed sources</button>
    <span class="hint"> — full re-download of every source RSS (ignores preview cache).</span></p>
    <div class="preview-tabs">
      <button type="button" class="active" id="tab-rendered" data-panel="rendered">Rendered</button>
      <button type="button" id="tab-raw" data-panel="raw">Raw XML</button>
    </div>
    <div id="preview-rendered"></div>
    <pre id="preview-xml" class="hidden"></pre>
    </div>
  </div>
  </div>
  <template id="feed-row-template">${FEED_ROW_TEMPLATE}</template>
  <script>
  (function () {
    var ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
    var form = document.getElementById('admin-settings-form');
    var statusEl = document.getElementById('preview-status');
    var xmlEl = document.getElementById('preview-xml');
    var renderedEl = document.getElementById('preview-rendered');
    var feedsContainer = document.getElementById('feeds-container');
    var tpl = document.getElementById('feed-row-template');
    var feedAdd = document.getElementById('feed-add');
    if (!form || !statusEl || !xmlEl || !renderedEl || !feedsContainer || !tpl) return;

    function renumberFeedRows() {
      var rows = feedsContainer.querySelectorAll('[data-feed-row]');
      rows.forEach(function (row, i) {
        row.querySelectorAll('[name^="feed_"]').forEach(function (el) {
          var n = el.getAttribute('name');
          if (!n) return;
          var m = n.match(/^feed_\\d+_(.+)$/);
          if (m) el.setAttribute('name', 'feed_' + i + '_' + m[1]);
        });
        var ch = row.getAttribute('data-channel-title');
        var tn = ch && String(ch).trim();
        var leg = row.querySelector('legend');
        if (leg) {
          leg.textContent = tn
            ? 'Source feed ' + (i + 1) + ' — ' + tn
            : 'Source feed ' + (i + 1);
        }
      });
    }

    feedsContainer.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || !t.name || !/^feed_\\d+_url$/.test(t.name)) return;
      var row = t.closest && t.closest('[data-feed-row]');
      if (row) row.removeAttribute('data-channel-title');
      renumberFeedRows();
    });

    function bindRemove(row) {
      var btn = row.querySelector('.feed-remove');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var rows = feedsContainer.querySelectorAll('[data-feed-row]');
        if (rows.length <= 1) {
          row.querySelectorAll('input[type="url"], input[type="number"]').forEach(function (inp) { inp.value = ''; });
          row.removeAttribute('data-channel-title');
          row.querySelectorAll('input[type="checkbox"]').forEach(function (i) { i.checked = false; });
          return;
        }
        row.remove();
        renumberFeedRows();
        schedule();
      });
    }

    feedsContainer.querySelectorAll('[data-feed-row]').forEach(function (row) { bindRemove(row); });

    if (feedAdd) {
      feedAdd.addEventListener('click', function () {
        var n = feedsContainer.querySelectorAll('[data-feed-row]').length;
        var html = tpl.innerHTML.replace(/FEEDIDX/g, String(n));
        var wrap = document.createElement('div');
        wrap.innerHTML = html.trim();
        var row = wrap.firstElementChild;
        if (row) {
          feedsContainer.appendChild(row);
          bindRemove(row);
          renumberFeedRows();
          schedule();
        }
      });
    }

    function firstChildText(el, tag) {
      var ch = el.getElementsByTagName(tag)[0];
      return ch ? ch.textContent.trim() : '';
    }
    function itunesHref(parent, local) {
      var nodes = parent.getElementsByTagNameNS(ITUNES_NS, local);
      for (var i = 0; i < nodes.length; i++) {
        var h = nodes[i].getAttribute('href');
        if (h) return h;
      }
      var legacy = parent.getElementsByTagName('itunes:image');
      for (var j = 0; j < legacy.length; j++) {
        var h2 = legacy[j].getAttribute('href');
        if (h2) return h2;
      }
      return '';
    }
    function enclosureUrl(item) {
      var enc = item.getElementsByTagName('enclosure')[0];
      return enc ? enc.getAttribute('url') || '' : '';
    }

    function renderRssPreview(xmlText) {
      renderedEl.textContent = '';
      var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      if (doc.querySelector('parsererror')) {
        renderedEl.appendChild(document.createTextNode('Could not parse preview XML.'));
        return;
      }
      var channel = doc.querySelector('channel') || doc.getElementsByTagName('channel')[0];
      if (!channel) {
        renderedEl.appendChild(document.createTextNode('No channel in feed.'));
        return;
      }
      var chTitle = firstChildText(channel, 'title');
      var chDesc = firstChildText(channel, 'description');
      var imgEl = channel.getElementsByTagName('image')[0];
      var imgUrl = '';
      if (imgEl) {
        var iu = imgEl.getElementsByTagName('url')[0];
        if (iu) imgUrl = iu.textContent.trim();
      }
      if (!imgUrl) imgUrl = itunesHref(channel, 'image');

      var head = document.createElement('div');
      head.className = 'ch-head';
      if (imgUrl) {
        var im = document.createElement('img');
        im.src = imgUrl;
        im.alt = '';
        im.referrerPolicy = 'no-referrer';
        head.appendChild(im);
      }
      var meta = document.createElement('div');
      meta.className = 'ch-meta';
      var h3 = document.createElement('h3');
      h3.textContent = chTitle;
      meta.appendChild(h3);
      if (chDesc) {
        var p = document.createElement('p');
        p.textContent = chDesc.replace(/\\s+/g, ' ').slice(0, 280) + (chDesc.length > 280 ? '…' : '');
        meta.appendChild(p);
      }
      head.appendChild(meta);
      renderedEl.appendChild(head);

      var items = channel.querySelectorAll('item');
      if (!items.length) {
        items = channel.getElementsByTagName('item');
      }
      var max = Math.min(items.length, 80);
      for (var k = 0; k < max; k++) {
        var item = items[k];
        var ep = document.createElement('div');
        ep.className = 'ep';
        var art = itunesHref(item, 'image');
        if (art) {
          var aimg = document.createElement('img');
          aimg.src = art;
          aimg.alt = '';
          aimg.referrerPolicy = 'no-referrer';
          ep.appendChild(aimg);
        }
        var body = document.createElement('div');
        body.className = 'ep-body';
        var t = document.createElement('p');
        t.className = 'ep-title';
        t.textContent = firstChildText(item, 'title');
        body.appendChild(t);
        var pub = firstChildText(item, 'pubDate');
        var audio = enclosureUrl(item);
        var sub = document.createElement('p');
        sub.className = 'ep-sub';
        sub.textContent = pub + (audio ? ' · audio' : '');
        body.appendChild(sub);
        var desc = firstChildText(item, 'description') || '';
        if (!desc) {
          var summ = item.getElementsByTagNameNS(ITUNES_NS, 'summary')[0];
          if (summ) desc = summ.textContent.trim();
        }
        if (desc) {
          var d = document.createElement('p');
          d.className = 'ep-desc';
          d.textContent = desc.replace(/\\s+/g, ' ').slice(0, 220) + (desc.length > 220 ? '…' : '');
          body.appendChild(d);
        }
        ep.appendChild(body);
        renderedEl.appendChild(ep);
      }
      if (items.length > max) {
        var more = document.createElement('p');
        more.className = 'hint';
        more.style.marginTop = '0.5rem';
        more.textContent = 'Showing ' + max + ' of ' + items.length + ' episodes.';
        renderedEl.appendChild(more);
      }
    }

    var tabRendered = document.getElementById('tab-rendered');
    var tabRaw = document.getElementById('tab-raw');
    function showPanel(which) {
      var isRaw = which === 'raw';
      xmlEl.classList.toggle('hidden', !isRaw);
      renderedEl.classList.toggle('hidden', isRaw);
      if (tabRendered) tabRendered.classList.toggle('active', !isRaw);
      if (tabRaw) tabRaw.classList.toggle('active', isRaw);
    }
    if (tabRendered) tabRendered.addEventListener('click', function () { showPanel('rendered'); });
    if (tabRaw) tabRaw.addEventListener('click', function () { showPanel('raw'); });

    var t = null;
    var delay = 450;
    function schedule() {
      clearTimeout(t);
      statusEl.textContent = 'Waiting…';
      statusEl.className = 'hint';
      t = setTimeout(function () { runPreview(false); }, delay);
    }
    async function runPreview(bypassCache) {
      statusEl.textContent = bypassCache ? 'Re-fetching all source feeds…' : 'Fetching feeds & generating XML…';
      statusEl.className = 'hint';
      xmlEl.textContent = '';
      renderedEl.textContent = '';
      try {
        var fd = new FormData(form);
        if (bypassCache) fd.set('bypassFeedCache', '1');
        var r = await fetch('/admin/preview', { method: 'POST', body: fd, credentials: 'same-origin' });
        var j;
        try {
          j = await r.json();
        } catch (parseErr) {
          throw new Error(r.status === 401 ? 'Session expired — refresh the page' : 'Invalid response from server');
        }
        if (!r.ok || !j.ok) {
          throw new Error(j.error || r.statusText || 'Preview failed');
        }
        xmlEl.textContent = j.xml;
        renderRssPreview(j.xml);
        if (j.channelTitles && j.channelTitles.length) {
          var rows = feedsContainer.querySelectorAll('[data-feed-row]');
          j.channelTitles.forEach(function (t, i) {
            var row = rows[i];
            if (!row) return;
            var s = t != null ? String(t).trim() : '';
            row.setAttribute('data-channel-title', s);
          });
          for (var k = j.channelTitles.length; k < rows.length; k++) {
            rows[k].setAttribute('data-channel-title', '');
          }
          renumberFeedRows();
        }
        statusEl.textContent = 'Preview updated';
        statusEl.className = 'hint';
      } catch (e) {
        statusEl.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
        statusEl.className = 'hint err';
      }
    }
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    var refreshBtn = document.getElementById('preview-refresh-feeds');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { runPreview(true); });
    runPreview(false);

    var origin = document.body.getAttribute('data-deployed-origin');
    var useBase = document.getElementById('use-deployed-base');
    var pub = document.getElementById('publicBaseUrl');
    if (useBase && pub && origin) {
      useBase.addEventListener('click', function () {
        pub.value = origin;
        schedule();
      });
    }

    var coverBtn = document.getElementById('cover-upload-btn');
    var coverInput = document.getElementById('cover-file-input');
    var coverMsg = document.getElementById('cover-upload-msg');
    var feedImg = document.getElementById('feedImageUrl');
    if (coverBtn && coverInput && coverMsg && feedImg) {
      coverBtn.addEventListener('click', async function () {
        var f = coverInput.files && coverInput.files[0];
        if (!f) {
          coverMsg.textContent = 'Choose an image file first.';
          return;
        }
        coverMsg.textContent = 'Uploading…';
        var fd = new FormData();
        fd.append('file', f);
        try {
          var r = await fetch('/admin/upload-cover', { method: 'POST', body: fd, credentials: 'same-origin' });
          var j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error || r.statusText);
          feedImg.value = j.feedImageUrl;
          coverMsg.textContent = 'Uploaded. Save to KV when ready.';
          schedule();
        } catch (e) {
          coverMsg.textContent = (e && e.message) ? e.message : 'Upload failed';
        }
      });
    }
  })();
  </script>
  </div>
</body>
</html>`;
}
