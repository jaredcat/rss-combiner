import { adminForm, escapeHtml, type Field } from 'workers-mini-admin';
import type { AppConfig, FeedEntry } from './config';

/**
Shown on admin GET when we have the incoming request (deployed URL + upload eligibility).
*/
export interface AdminPageContext {
  deployedOrigin: string;
  deployedFeedUrl: string;
  coverUploadEnabled: boolean;
}

export const ADMIN_PAGE_HINT =
  'Values are stored in Workers KV and override <code>wrangler.toml</code> <code>[vars]</code> when present. Preview updates as you edit; source RSS is cached (~15 minutes per URL). Use “Refresh feed sources” for the latest upstream episodes.';

/**
App-specific styles on top of `workers-mini-admin` shared CSS.
*/
export const ADMIN_APP_CSS = `
    .layout { display: grid; gap: 1rem; }
    @media (min-width: 960px) {
      .layout { grid-template-columns: minmax(300px, 1fr) minmax(280px, 1fr); gap: 1.25rem; align-items: start; }
    }
    .panel { min-width: 0; }
    .panel-card { padding: 1rem 1rem 1.25rem; }
    @media (min-width: 640px) { .panel-card { padding: 1.15rem 1.25rem 1.35rem; } }
    .list-item-heading { margin: 0 0 0.35rem 0; font-weight: 700; font-size: 0.95rem; }
    .feed-merge-timeline-oneline { font-size: 0.8rem; color: #666; font-weight: normal; margin: 0.3rem 0 0 0; line-height: 1.3; }
    .feed-merge-timeline-explainer { margin: 0.75rem 0 1rem 0; font-size: 0.88rem; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.5rem 0.75rem; background: #fff; }
    .feed-merge-timeline-explainer summary { cursor: pointer; font-weight: 600; color: #2d3748; }
    .feed-merge-timeline-explainer .hint { margin: 0.65rem 0 0 0; }
    .feed-merge-timeline-explainer .hint p { margin: 0.45rem 0 0 0; }
    .feed-merge-timeline-explainer .hint p:first-child { margin-top: 0.35rem; }
    .list-field > .list-add { margin-top: 0.5rem; }
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
`;

const FEED_LIST_HINT_HTML = `Add one row per RSS 2.0 URL. Use the cutoff fields to only include items published <em>after</em> that date (leave blank to use the default cutoff from the top of the form). After preview, each row’s heading shows that source’s RSS channel title (not stored; updates when you preview).
<details class="feed-merge-timeline-explainer">
  <summary>How cutoffs &amp; timeline merge work</summary>
  <div class="hint">
    <p><strong>Two separate controls</strong></p>
    <p><strong>1. Cutoff</strong> — Which episodes to include. Only items published <em>after</em> the cutoff (original RSS date) are kept. Blank fields use the default cutoff above.</p>
    <p><strong>2. Merge this feed’s timeline</strong> — How those episodes are dated in the combined feed. Off = real dates. On + an older per-feed cutoff year = add years so that cutoff year lines up with the default year (e.g. cutoff <code>2014</code>, default <code>2024</code> → a 2014 episode becomes 2024; a 2015 episode becomes 2025). Without an older cutoff year, the checkbox does nothing.</p>
    <p><strong>Why?</strong> Cutoff alone can pull in years of backlog that all sort before your other shows. Merge interleaves that history into your recent timeline. See <code>README.md</code> for the full walkthrough.</p>
  </div>
</details>`;

const MERGE_TIMELINE_ONELINE_HTML =
  '<p class="feed-merge-timeline-oneline">Rewrites this show’s years to line up with the default (needs an <strong>older</strong> cutoff year)—details in <strong>How cutoffs &amp; timeline merge work</strong>.</p>';

// Apple's podcast namespace URI is an identifier, not a request.
// eslint-disable-next-line sonarjs/no-clear-text-protocols, unicorn/prefer-https
const ITUNES_NAMESPACE = 'http://www.itunes.com/dtds/podcast-1.0.dtd';

function feedListValues(config: AppConfig): Record<string, string | boolean>[] {
  const list =
    config.feeds.length > 0 ? config.feeds : [{ url: '' } as FeedEntry];
  return list.map((feed) => ({
    url: feed.url,
    cutoffYear: feed.cutoffYear ?? '',
    cutoffMonth: feed.cutoffMonth ?? '',
    cutoffDay: feed.cutoffDay ?? '',
    mergeTimeline: feed.mergeTimeline === true,
  }));
}

const EMPTY_ADMIN_CONTEXT: AdminPageContext = {
  deployedOrigin: '',
  deployedFeedUrl: '',
  coverUploadEnabled: false,
};

function deployedHintsHtml(context: AdminPageContext): string {
  if (!context.deployedOrigin) {
    return '';
  }
  return `<div class="deployed-url-card">
  <p class="deployed-label">This deployment</p>
  <p class="deployed-line"><span class="k">Worker URL</span> <code>${escapeHtml(context.deployedOrigin)}</code></p>
  <p class="deployed-line"><span class="k">Combined RSS</span> <code id="deployed-feed-url">${escapeHtml(context.deployedFeedUrl)}</code></p>
  <button type="button" class="btn-secondary" id="use-deployed-base">Use worker URL as public base</button>
</div>`;
}

function coverToolsHtml(isCoverUploadEnabled: boolean): string {
  if (isCoverUploadEnabled) {
    return `<div class="cover-tools">
  <input type="file" id="cover-file-input" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="Choose cover image file">
  <button type="button" class="btn-secondary" id="cover-upload-btn">Upload to R2</button>
  <span id="cover-upload-msg" class="hint" role="status"></span>
</div><p class="hint">Uploads replace <code>cover.jpg</code> in your R2 bucket and fill the image URL above.</p>`;
  }
  return `<p class="hint">Browser upload needs your bucket’s public <code>*.r2.dev</code> URL: set <code>R2_PUBLIC_BASE_URL</code> or <code>FEED_IMAGE_URL</code> in <code>wrangler.toml</code>, then redeploy.</p>`;
}

/**
Declarative settings fields for `workers-mini-admin` (list / row / hintHtml / pattern).
*/
export function adminSettingsFields(
  config: AppConfig,
  context: AdminPageContext = EMPTY_ADMIN_CONTEXT,
): Field[] {
  const deployed = deployedHintsHtml(context);
  return [
    ...(deployed ? [{ type: 'html' as const, html: deployed }] : []),
    {
      type: 'text',
      name: 'feedTitle',
      label: 'Feed title',
      value: config.feedTitle,
      required: true,
    },
    {
      type: 'select',
      name: 'feedType',
      label: 'Feed type',
      value: config.feedType,
      options: [
        { value: 'podcast', label: 'Podcast' },
        { value: 'generic', label: 'Generic RSS' },
      ],
    },
    {
      type: 'html',
      html: `<p class="hint">One type for the whole combined feed. <strong>Podcast</strong> adds iTunes season, episode, and artwork tags (use this for podcast apps). <strong>Generic RSS</strong> keeps titles, links, descriptions, enclosures, and <code>content:encoded</code> without those tags. Item titles include the source feed name in both modes.</p>`,
    },
    {
      type: 'text',
      name: 'outputFilename',
      label: 'Output filename',
      value: config.outputFilename,
      pattern: String.raw`[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.xml`,
      required: true,
      spellcheck: false,
      hintHtml: '(public path; also served at <code>/</code>)',
    },
    {
      type: 'html',
      html: `<p class="hint">Default is <code>feed.xml</code>. If subscribers already use the version 1 URL, set this to <code>podcasts.xml</code> and save.</p>`,
    },
    {
      type: 'url',
      name: 'feedImageUrl',
      label: 'Main image URL',
      value: config.feedImageUrl || '',
      placeholder: 'https://…',
      hintHtml:
        '(channel image; episode art in podcast mode when using “main cover”)',
    },
    {
      type: 'html',
      html: coverToolsHtml(context.coverUploadEnabled),
    },
    {
      type: 'url',
      name: 'publicBaseUrl',
      label: 'Public base URL',
      value: config.publicBaseUrl,
      required: true,
      hintHtml:
        '(no trailing slash; RSS <code>link</code> / <code>atom:link</code> — usually your worker URL)',
    },
    {
      type: 'html',
      html: `<p class="hint">Default cutoff applies to any source row that leaves its cutoff blank. Per-feed overrides and <strong>Merge this feed’s timeline</strong> are on each source row — open <strong>How cutoffs &amp; timeline merge work</strong> there, or see <code>README.md</code>.</p>`,
    },
    {
      type: 'row',
      fields: [
        {
          type: 'number',
          name: 'defaultCutoffDay',
          label: 'Default cutoff — day',
          value: config.defaultCutoff.day,
          min: 1,
          max: 31,
        },
        {
          type: 'number',
          name: 'defaultCutoffMonth',
          label: 'month',
          value: config.defaultCutoff.month,
          min: 1,
          max: 12,
        },
        {
          type: 'number',
          name: 'defaultCutoffYear',
          label: 'year',
          value: config.defaultCutoff.year,
          min: 1970,
          max: 2100,
        },
      ],
    },
    {
      type: 'radio',
      name: 'coverMode',
      label: 'Item artwork',
      value: config.coverMode,
      hintHtml:
        'Podcast mode writes these as <code>itunes:image</code> on each item. Generic RSS uses the main image as the channel image only.',
      options: [
        {
          value: 'source',
          label: 'Use source episode / feed artwork',
        },
        {
          value: 'per_feed_main',
          label:
            'Use each source podcast’s channel (main) cover for all episodes from that feed',
        },
        {
          value: 'main',
          label: 'Use combined feed’s main image for every episode',
        },
      ],
    },
    {
      type: 'list',
      name: 'feed',
      legend: 'Source feeds',
      hintHtml: FEED_LIST_HINT_HTML,
      minItems: 1,
      addLabel: 'Add feed',
      removeLabel: 'Remove feed',
      itemFields: [
        {
          type: 'html',
          html: '<p class="list-item-heading" data-channel-heading>Source feed</p>',
        },
        {
          type: 'url',
          name: 'url',
          label: 'Feed URL',
          placeholder: 'https://…',
        },
        {
          type: 'row',
          fields: [
            {
              type: 'number',
              name: 'cutoffYear',
              label: 'Cutoff year',
              min: 1970,
              max: 2100,
              placeholder: 'optional',
            },
            {
              type: 'number',
              name: 'cutoffMonth',
              label: 'month',
              min: 1,
              max: 12,
              placeholder: 'optional',
            },
            {
              type: 'number',
              name: 'cutoffDay',
              label: 'day',
              min: 1,
              max: 31,
              placeholder: 'optional',
            },
          ],
        },
        {
          type: 'checkbox',
          name: 'mergeTimeline',
          label: 'Merge this feed’s timeline',
        },
        {
          type: 'html',
          html: MERGE_TIMELINE_ONELINE_HTML,
        },
      ],
      values: feedListValues(config),
    },
  ];
}

function previewPanelHtml(): string {
  return `<div class="panel" id="preview-wrap">
    <div class="panel-card">
    <h2>Live preview</h2>
    <p id="preview-status" class="hint">Generating…</p>
    <p><button type="button" id="preview-refresh-feeds">Refresh feed sources</button>
    <span class="hint"> — full re-download of every source RSS (ignores preview cache).</span></p>
    <div class="preview-tabs" role="group" aria-label="Preview episode slice">
      <button type="button" class="active" id="preview-slice-newest" data-slice="newest">Newest 40</button>
      <button type="button" id="preview-slice-oldest" data-slice="oldest">Oldest 40</button>
    </div>
    <p class="hint" style="margin:0.35rem 0 0.75rem">Preview only shows 40 episodes so large feeds stay under Worker limits. Save / cron still write the full feed.</p>
    <div class="preview-tabs">
      <button type="button" class="active" id="tab-rendered" data-panel="rendered">Rendered</button>
      <button type="button" id="tab-raw" data-panel="raw">Raw XML</button>
    </div>
    <div id="preview-rendered"></div>
    <pre id="preview-xml" class="hidden"></pre>
    </div>
  </div>`;
}

function adminClientScript(): string {
  return String.raw`
  <script>
  (function () {
    var ITUNES_NS = '${ITUNES_NAMESPACE}';
    var form = document.getElementById('admin-settings-form');
    var statusEl = document.getElementById('preview-status');
    var xmlEl = document.getElementById('preview-xml');
    var renderedEl = document.getElementById('preview-rendered');
    var feedsList = form && form.querySelector('[data-list-name="feed"]');
    if (!form || !statusEl || !xmlEl || !renderedEl || !feedsList) return;

    function feedRows() {
      return feedsList.querySelectorAll(':scope > .list-item');
    }

    function updateFeedHeadings() {
      feedRows().forEach(function (row, i) {
        var ch = row.getAttribute('data-channel-title');
        var tn = ch && String(ch).trim();
        var heading = row.querySelector('[data-channel-heading]');
        if (heading) {
          heading.textContent = tn
            ? 'Source feed ' + (i + 1) + ' — ' + tn
            : 'Source feed ' + (i + 1);
        }
      });
    }

    feedsList.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || !t.name || !/^feed_\d+_url$/.test(t.name)) return;
      var row = t.closest && t.closest('.list-item');
      if (row) row.removeAttribute('data-channel-title');
      updateFeedHeadings();
    });

    form.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!(t && t.closest)) return;
      if (t.closest('.list-add') || t.closest('.list-item-remove')) {
        setTimeout(function () {
          updateFeedHeadings();
          schedule();
        }, 0);
      }
    });

    updateFeedHeadings();

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
        p.textContent = chDesc.replace(/\s+/g, ' ').slice(0, 280) + (chDesc.length > 280 ? '…' : '');
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
        if (desc) {
          var d = document.createElement('p');
          d.className = 'ep-desc';
          d.textContent = desc.replace(/\s+/g, ' ').slice(0, 220) + (desc.length > 220 ? '…' : '');
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

    var debounceTimer = undefined;
    // Heavy previews: wait for typing/edits to settle before hitting the Worker again.
    var debounceMs = 1200;
    var previewSlice = 'newest';
    var previewAbort = undefined;
    var previewSeq = 0;
    var sliceNewestBtn = document.getElementById('preview-slice-newest');
    var sliceOldestBtn = document.getElementById('preview-slice-oldest');
    function setPreviewSlice(slice) {
      previewSlice = slice === 'oldest' ? 'oldest' : 'newest';
      if (sliceNewestBtn) sliceNewestBtn.classList.toggle('active', previewSlice === 'newest');
      if (sliceOldestBtn) sliceOldestBtn.classList.toggle('active', previewSlice === 'oldest');
    }
    if (sliceNewestBtn) {
      sliceNewestBtn.addEventListener('click', function () {
        if (previewSlice === 'newest') return;
        setPreviewSlice('newest');
        runPreview(false);
      });
    }
    if (sliceOldestBtn) {
      sliceOldestBtn.addEventListener('click', function () {
        if (previewSlice === 'oldest') return;
        setPreviewSlice('oldest');
        runPreview(false);
      });
    }
    function schedule() {
      clearTimeout(debounceTimer);
      statusEl.textContent = 'Waiting for edits to settle…';
      statusEl.className = 'hint';
      debounceTimer = setTimeout(function () { runPreview(false); }, debounceMs);
    }
    async function runPreview(bypassCache) {
      clearTimeout(debounceTimer);
      if (previewAbort) {
        try { previewAbort.abort(); } catch (e) {}
      }
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      previewAbort = controller;
      var seq = ++previewSeq;
      statusEl.textContent = bypassCache ? 'Re-fetching all source feeds…' : 'Fetching feeds & generating XML…';
      statusEl.className = 'hint';
      try {
        var fd = new FormData(form);
        if (bypassCache) fd.set('bypassFeedCache', '1');
        fd.set('previewSlice', previewSlice);
        var fetchOpts = { method: 'POST', body: fd, credentials: 'same-origin' };
        if (controller) fetchOpts.signal = controller.signal;
        var r = await fetch('/admin/preview', fetchOpts);
        if (seq !== previewSeq) return;
        var rawText = await r.text();
        if (seq !== previewSeq) return;
        var j;
        try {
          j = JSON.parse(rawText);
        } catch (parseErr) {
          if (r.status === 401) {
            throw new Error('Session expired — refresh the page');
          }
          var looksLikeCfHtml =
            /<!DOCTYPE html/i.test(rawText || '') ||
            /no-js ie6 oldie/i.test(rawText || '');
          if (r.status === 503 || r.status === 1102 || looksLikeCfHtml) {
            throw new Error(
              'Preview hit Cloudflare Worker resource limits (HTTP ' +
              r.status +
              '). Save still works; try fewer feeds, a newer cutoff, or wait and retry.'
            );
          }
          var snippet = (rawText || '').replace(/\s+/g, ' ').slice(0, 120);
          throw new Error(
            'Invalid response from server (HTTP ' + r.status + ')' +
            (snippet ? ': ' + snippet : '')
          );
        }
        if (!r.ok || !j.ok) {
          throw new Error(j.error || r.statusText || 'Preview failed');
        }
        if (seq !== previewSeq) return;
        xmlEl.textContent = j.xml;
        renderRssPreview(j.xml);
        if (j.channelTitles && j.channelTitles.length) {
          var rows = feedRows();
          j.channelTitles.forEach(function (t, i) {
            var row = rows[i];
            if (!row) return;
            var s = t != undefined ? String(t).trim() : '';
            row.setAttribute('data-channel-title', s);
          });
          for (var k = j.channelTitles.length; k < rows.length; k++) {
            rows[k].setAttribute('data-channel-title', '');
          }
          updateFeedHeadings();
        }
        if (j.previewTruncated) {
          var which = (j.previewSlice || previewSlice) === 'oldest' ? 'oldest' : 'newest';
          statusEl.textContent =
            'Preview updated (showing ' +
            which +
            ' ' +
            (j.previewMaxItems || '?') +
            ' of ' +
            (j.previewTotalItems || '?') +
            ' episodes — full feed still builds on Save / cron)';
        } else {
          statusEl.textContent = 'Preview updated';
        }
        statusEl.className = 'hint';
      } catch (e) {
        if (seq !== previewSeq) return;
        if (e && (e.name === 'AbortError' || e.message === 'The user aborted a request.')) {
          return;
        }
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
    var outputName = document.getElementById('outputFilename');
    var outputLabel = document.getElementById('output-path-label');
    var deployedFeed = document.getElementById('deployed-feed-url');
    function syncOutputPath() {
      var name = outputName && outputName.value.trim() ? outputName.value.trim() : 'feed.xml';
      if (outputLabel) outputLabel.textContent = '/' + name;
      if (deployedFeed && origin) {
        deployedFeed.textContent = origin.replace(/\/$/, '') + '/' + name;
      }
    }
    if (outputName) outputName.addEventListener('input', syncOutputPath);

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
`;
}

/**
Inner admin UI for `createAdmin` (`wrapBody: false`).
Settings form is declarative Fields; preview panel + client JS stay BYO.
Chrome (title, flash, logout) comes from workers-mini-admin.
*/
export function adminSettingsBody(
  config: AppConfig,
  context?: AdminPageContext,
): string {
  const pageContext = context ?? EMPTY_ADMIN_CONTEXT;
  const formHtml = adminForm({
    id: 'admin-settings-form',
    action: '/admin',
    submitLabel: 'Save to KV',
    fields: adminSettingsFields(config, pageContext),
  });

  return `
  <div class="layout">
  <div class="panel">
  <div class="panel-card">
  ${formHtml}
  </div>
  <p class="hint" style="margin-top:0.75rem">Saving writes settings to KV and queues a rebuild (one source feed per job, then merge). Refresh this page for status; <code id="output-path-label">/${escapeHtml(config.outputFilename)}</code> updates when the job finishes. Hourly cron and authenticated <code>/deploy-trigger</code> also enqueue rebuilds.</p>
  </div>
  ${previewPanelHtml()}
  </div>
  ${adminClientScript()}
`;
}
