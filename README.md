# RSS Combiner

A Cloudflare Worker-based RSS feed combiner that allows you to merge multiple podcast feeds into a single, unified feed. Perfect for consolidating your favorite podcasts or creating custom podcast collections.

## Features

- 🔄 **Automatic Updates**: Hourly feed updates via Cloudflare Cron Triggers
- 📡 **Multiple Feed Support**: Combine unlimited RSS feeds into one
- 📅 **Date Filtering**: Set cutoff dates for each feed to control which episodes are included
- 🎨 **Custom Branding**: Set your own feed title and artwork image
- 📦 **R2 Image Hosting**: Upload cover images directly to your R2 bucket
- ☁️ **Cloudflare R2 Storage**: Fast, global content delivery
- 🎯 **Health Checks**: Built-in monitoring endpoints
- ⚙️ **Web admin** (`/admin`): Password-protected UI backed by Workers KV (feed title, artwork, feed list, episode cover mode) — the intended way to configure feeds after deploy
- 🚀 **GitHub Actions Deployment**: Deploy entirely through GitHub (no local setup required!)
- 🛠️ **Local Development**: Test and preview feeds locally before deployment

## 🚀 Quick Start (Recommended)

### GitHub Actions Deployment (No Local Setup Required)

The easiest way to deploy your RSS combiner is entirely through GitHub Actions:

**👉 [Follow the GitHub Actions Setup Guide](docs/github-actions-setup.md)**

**Summary:**

1. [Create a Cloudflare account](https://dash.cloudflare.com/sign-up) and an API token (Workers + KV + R2).
2. Use this template to create **your** repository (not the template source — that name is special; see the setup guide).
3. Add GitHub secrets: `CLOUDFLARE_API_TOKEN`, and **`ADMIN_SECRET`** (password for `/admin`).
4. Edit `wrangler.toml` once: unique **`name`** (Worker URL) and **`bucket_name`** (R2), then push to `main`.
5. Open **`https://<your-worker-name>.workers.dev/admin`**, add podcast RSS URLs, save — your feed is at **`/podcasts.xml`** (KV and R2 are set up by the workflow).

Optional: upload `cover.jpg` in the repo, or set `R2_PUBLIC_BASE_URL` for in-admin cover upload (see [GitHub Actions setup](docs/github-actions-setup.md)).

---

## 🛠️ Local Development Setup

If you prefer to develop locally or need advanced customization:

### Prerequisites

- [Bun](https://bun.sh) runtime
- [A free Cloudflare account](https://cloudflare.com) with Workers and R2 enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 1. Use This Template

Click "Use this template" on GitHub to create your own repository.

### 2. Install Dependencies

```bash
bun install
```

### 3. Add Your Cover Image (Optional)

Place a cover image in your project root as `cover.jpg`, `cover.jpeg`, or `cover.png`:

```bash
# Copy your image file to the project root
cp /path/to/your/artwork.jpg cover.jpg
```

**Image Requirements:**

- Formats: JPEG or PNG
- Recommended size: 1400x1400px or larger
- Square aspect ratio works best for podcast players

### 4. Configure Your Feeds

Edit `wrangler.toml` to configure your RSS feeds:

```toml
name = "your-podcast-feed-generator"  # Change this to your worker name
main = "src/worker.ts"
compatibility_date = "2025-05-05"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "XML_BUCKET"
bucket_name = "your-podcasts-xml"  # Change this to your bucket name

[triggers]
crons = ["0 */1 * * *"]  # Updates every hour

[vars]
# Customize your feed metadata
FEED_TITLE = "My Combined Podcast Feed"
FEED_IMAGE_URL = "https://your-podcasts-xml.r2.dev/cover.jpg"  # Will be auto-updated when you upload

DEFAULT_CUTOFF_DATE_DAY = "1"
DEFAULT_CUTOFF_DATE_MONTH = "1"
DEFAULT_CUTOFF_DATE_YEAR = "2024"
FEED_INDEX_PADDING = "2"

# Add your feeds here (up to 99 feeds supported)
FEED_01_URL = "https://example.com/feed1.xml"
FEED_01_CUTOFF_YEAR = "2023"  # Optional: only include episodes from this year onwards

FEED_02_URL = "https://example.com/feed2.xml"
# No cutoff = includes all episodes

# Add more feeds as needed...
```

### 5. Set Up Cloudflare Resources

1. **R2 bucket** — If you use **GitHub Actions**, the deploy workflow creates the bucket from `bucket_name` in `wrangler.toml` when missing. Locally: `wrangler r2 bucket create your-podcasts-xml`.

2. **KV for `/admin`** — If you use **GitHub Actions**, the workflow creates a KV namespace and patches the placeholder id for that run. For **local** `wrangler dev`, create a namespace and paste its id into `[[kv_namespaces]]` → `id`, or copy the id from a successful Actions log after one deploy.

3. **Upload your cover image** (optional):

   ```bash
   bun run upload-cover
   ```

4. **Deploy the worker**:

   ```bash
   bun run deploy
   ```

5. **Admin password** — Set `wrangler secret put ADMIN_SECRET` (or add `ADMIN_SECRET` as a GitHub Actions secret so CI applies it). Then open `/admin`.

### 6. Access Your Combined Feed

Your combined RSS feed will be available at:
`https://your-worker-name.your-subdomain.workers.dev/podcasts.xml`

## 📱 Adding to Podcast Apps

### Pocket Casts (Recommended)

To listen to your combined feed on mobile devices, you can add it to Pocket Casts as a private feed:

1. **Go to [Pocket Casts Submit](https://pocketcasts.com/submit/)**
2. **Enter your RSS feed URL**: `https://your-worker-name.workers.dev/podcasts.xml`
3. **Select "Private"**: This ensures your personal combined feed won't appear in public searches
4. **Click "Submit"**
5. **Access via private link**: Pocket Casts will provide a private link to add the feed to all your devices

**Why use "Private"?**

- Your combined feed is personal and not meant for public discovery
- Prevents your feed from appearing in Pocket Casts search results
- Gives you a convenient private link to share across your devices

### Other Podcast Apps

Most podcast apps support adding custom RSS feeds:

- **Apple Podcasts**: Use the "Add a Show by URL" option
- **Spotify**: Currently limited custom RSS support
- **Overcast**: Use "Add URL" in the app
- **Castro**: Add via URL in the app settings

## Cover Image Management

### Uploading Your Cover Image

The easiest way to add a cover image is to use the built-in upload tool:

1. **Place your image** in the project root as `cover.jpg`, `cover.jpeg`, or `cover.png`
2. **Upload to R2**:

   ```bash
   bun run upload-cover
   ```

This command will:

- ✅ Find your local cover image
- 📦 Upload it to your R2 bucket as `cover.jpg`
- 🔗 Automatically update `FEED_IMAGE_URL` in `wrangler.toml`
- 🚀 Prepare your worker for deployment

### Manual Image Configuration

You can also use external image hosting by directly setting the URL in `wrangler.toml`:

```toml
[vars]
FEED_IMAGE_URL = "https://example.com/my-custom-artwork.jpg"
```

### Image Best Practices

- **Use HTTPS URLs** for maximum compatibility
- **Square images** (1:1 aspect ratio) work best
- **High resolution**: 1400x1400px minimum, 3000x3000px recommended
- **File size**: Keep under 1MB for faster loading
- **Formats**: JPEG or PNG (JPEG recommended for smaller file sizes)

## Configuration Options

### Feed Metadata

Configure your combined feed's appearance:

- `FEED_TITLE`: The title of your combined feed (optional, defaults to "My Combined Podcast Feed")
- `FEED_IMAGE_URL`: URL to artwork image for your feed (optional, should be HTTPS for best compatibility)

### Feed Configuration

Each feed can be configured with the following environment variables:

- `FEED_XX_URL`: The RSS feed URL (required)
- `FEED_XX_CUTOFF_YEAR`: Only include episodes from this year onwards (optional)
- `FEED_XX_CUTOFF_MONTH`: Cutoff month (optional)
- `FEED_XX_CUTOFF_DAY`: Cutoff day (optional)
- `FEED_XX_MERGE_TIMELINE`: Set to `"true"` to enable **Merge this feed’s timeline** (same as the admin checkbox): when on, applies **year-shifting** for an older per-feed cutoff year (mixes that show into the shared timeline).

Where `XX` is a zero-padded number (01, 02, 03, etc.).

### Global Settings

- `DEFAULT_CUTOFF_DATE_DAY`, `DEFAULT_CUTOFF_DATE_MONTH`, `DEFAULT_CUTOFF_DATE_YEAR`: Default cutoff calendar date for feeds that do not set per-feed cutoffs (same semantics as main: `bun run generate` and first deploy before KV).
- `FEED_INDEX_PADDING`: Number of digits for feed indexing (default: 2)

## Available Commands

```bash
# Setup and validation
bun run setup              # Check configuration and show setup status

# Cover image management
bun run upload-cover       # Upload cover.jpg/cover.png to R2 bucket

# Development
bun run dev               # Start local development server
bun run generate          # Generate feed locally for testing
bun run test-local        # Generate and preview first 50 lines

# Deployment
bun run build             # Build the worker
bun run deploy            # Deploy to Cloudflare Workers
```

## Local Development

### Generate Feed Locally

```bash
# Generate and preview the combined XML feed
bun run generate
```

### Test the Worker Locally

```bash
# Start local development server
bun run dev
```

Then visit `http://localhost:8787` to test your worker.

## API Endpoints

- `GET /` or `GET /podcasts.xml`: Returns the combined RSS feed
- `GET /healthcheck`: Returns health status and last update time
- `POST /deploy-trigger`: Manually triggers feed regeneration (hourly cron also runs this)
- `GET /admin`: Web admin (requires `ADMIN_SECRET`; disabled until the secret is set)
- `POST /admin`: Save settings to KV (same auth as above; also accepts `Authorization: Bearer <ADMIN_SECRET>`)
- `POST /admin/preview`: Returns JSON `{ ok, xml }` for the current form values (same auth as `POST /admin`). Preview reuses cached source RSS bodies (~15 minutes per URL in memory, plus Cloudflare cache on subrequests) so metadata edits do not re-download feeds every time. Send form field `bypassFeedCache=1` (the admin “Refresh feed sources” button does this) to force a full re-fetch.
- `POST /admin/login` / `POST /admin/logout`: Session cookie sign-in and sign-out

## Customization

### Feed metadata and public URLs

You can configure the feed in either of two ways:

1. **Environment variables** in `wrangler.toml` (`[vars]`) — used when no valid config exists in KV, and by `bun run generate` locally.
2. **Workers KV** via the web admin — once saved, KV overrides `[vars]` for generation (each save regenerates `podcasts.xml`, plus hourly cron and `/deploy-trigger`).

Optional `PUBLIC_BASE_URL` in `[vars]` sets the RSS `feed_url`, `site_url`, and related links (defaults to a placeholder until you set it or save the admin form):

```toml
[vars]
FEED_TITLE = "John's Tech Podcasts"
FEED_IMAGE_URL = "https://your-bucket.r2.dev/cover.jpg"  # Uploaded via 'bun run upload-cover'
# PUBLIC_BASE_URL = "https://your-worker.workers.dev"
```

Channel title, image, and per-episode artwork behavior are implemented in [`src/xmlBuilder.ts`](src/xmlBuilder.ts) using [`src/config.ts`](src/config.ts) (`AppConfig`, `coverMode`).

### Web admin and Workers KV

Apache `.htaccess` files are **not** applied to Cloudflare Workers. To restrict the admin UI you can:

- Set a shared **`ADMIN_SECRET`** with `wrangler secret put ADMIN_SECRET` (the worker checks it for the HTML form, cookie session, and `Authorization: Bearer` requests), and/or
- Put the worker on a custom hostname and use **[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)** to protect `/admin` at the edge.

**One-time setup**

1. **KV** — With GitHub Actions, the deploy workflow creates the namespace while `id` in `wrangler.toml` is still the placeholder. Locally, create a namespace and paste its id, or deploy once via Actions and copy the id from the log.
2. **Admin password** — `wrangler secret put ADMIN_SECRET`, or set the `ADMIN_SECRET` GitHub Actions secret so CI syncs it on deploy.
3. Open `https://<your-worker>.workers.dev/admin`, sign in, and save your settings. Saving updates `podcasts.xml` immediately. Expand **First-time setup: cutoffs & timeline merge** (above the default cutoff fields) for a short guide; for a full tutorial see [First-time setup: cutoffs and timeline merge](#first-time-cutoffs) below. Configuration is stored as JSON under the KV key `config:v1` (you edit feeds with add/remove rows in the UI—no raw JSON). The page includes a **rendered** preview (channel + episodes) and a **raw XML** tab, both updated as you edit.

`FEED_INDEX_PADDING` in `wrangler.toml` only applies when loading feeds from numbered `FEED_01_URL`–style vars (e.g. `bun run generate`); the admin UI uses a feed list and does not expose padding.

### Episode artwork

- **Source episode / feed artwork** (`coverMode: source`): each item uses the source episode’s `itunes:image` if present, otherwise the source podcast’s channel image (previous default).
- **Per source feed channel cover** (`coverMode: per_feed_main`): every episode from a given source feed uses that podcast’s **channel** artwork only (episode-specific art is ignored).
- **Combined feed main image for every episode** (`coverMode: main`): every item’s `itunes:image` uses your combined feed’s main image URL; requires `FEED_IMAGE_URL` / admin “Main podcast image URL”.

### Episode Filtering

The combiner supports:

- **Date-based filtering**: Only include episodes **after** a per-feed or default cutoff date (same rules as `main`: each of year / month / day falls back to the default cutoff when omitted on a feed row; cutoff is midnight **local** time on that calendar day, compared to each episode’s original `pubDate`).
- **Merge this feed’s timeline** (`FEED_XX_MERGE_TIMELINE` / admin checkbox): Optional per feed. When **checked**, enables **year-shifting** (moves that feed’s episode dates forward when its cutoff year is older than the default—this is what interleaves deep back catalogs). When **unchecked**, episode dates stay on their original calendar (no shift), aside from normal cutoff filtering—see the admin UI explainer

<a id="first-time-cutoffs"></a>

### First-time setup: cutoffs and timeline merge

Use this when configuring **Default cutoff** at the top of the admin form (or `DEFAULT_CUTOFF_DATE_*` in `wrangler.toml`), **per-feed** cutoff fields on each source row, and **Merge this feed’s timeline** on each row where you want a merged timeline.

#### What each control does

| Control | What it is |
| --------|------------|
| **Default cutoff** (day / month / year) | The calendar date used for any source row where you leave the per-feed cutoff **blank**. Only episodes published **after** this date (on the original RSS `pubDate`) are candidates for that row. The default **year** is the target timeline when **Merge this feed’s timeline** applies year-shifting on a row. Set via admin/KV or `DEFAULT_CUTOFF_DATE_*` in `wrangler.toml` `[vars]`. |
| **Per-feed cutoff** (year, optional month/day) | Overrides the default **for that podcast only**—it controls **which episodes are included** (after that date). It does **not** shift or interleave dates by itself. Leaving everything blank uses the default cutoff. |
| **Merge this feed’s timeline** (checkbox) | **Enables** year-shifting when this row’s cutoff **year** is older than the default: episode dates move forward so that show can sort with your others. Unchecked: no merge—only cutoff filtering. |

#### Choosing values (recommended workflow)

1. **Pick your default cutoff**
   Set it to the **start of the period you care about** for *most* shows—often **January 1** of a year (e.g. `1 / 1 / 2024`). Everything below assumes episodes must be **newer than** that date unless you override a row.

2. **Simple case: only recent episodes**
   For a podcast where you only want episodes from the last year or two, either leave the row’s cutoff **blank** (inherits the default) or set a **per-feed cutoff year** (e.g. `2023`) so only episodes after that date count.

3. **Chronological mix across shows (long back catalog)**
   If you add a podcast with **many years** of old episodes, use the **per-feed cutoff** to choose **which** episodes are in scope (e.g. an older cutoff year to include more history). That **only filters** by date—it does **not** mix timelines by itself.
   To **interleave** that show with your others, also turn on **Merge this feed’s timeline** on that row. With merge on and a per-feed cutoff **year** older than the default, the combiner **adds years** to that feed’s episode dates so they sort alongside your other podcasts. **Oh No**-style deep catalogs are a common example.

4. **When to use “Merge this feed’s timeline” on a row**
   - **Check it** when you want **year-shifting** for that row: the row’s cutoff year must be **older** than the default (step 3), and merge must be **on**—otherwise no interleaving. With merge **off**, episodes keep their real calendar dates (subject only to cutoff filtering).
   - Leave it **off** for a feed where you only want real dates (no merge), or when the row’s cutoff year matches the default (nothing to shift anyway).

5. **Preview**
   Use **Live preview** on the admin page after changing cutoffs; row headings show each source’s channel title after a successful preview.

The admin UI also has an expandable **First-time setup: cutoffs & timeline merge** section above the default cutoff fields with the same ideas in short form.

## Deployment

### GitHub Actions (Recommended)

See the **[GitHub Actions Setup Guide](docs/github-actions-setup.md)** for complete instructions.

### Manual Updates

Force a feed update:

```bash
curl https://your-worker.workers.dev/deploy-trigger
```

## Monitoring

Check your feed health:

```bash
curl https://your-worker.workers.dev/healthcheck
```

## Troubleshooting

### Cover Image Issues

- **Image not showing**: Ensure the R2 bucket has public access enabled
- **Upload fails**: Check that your R2 bucket exists and you have write permissions
- **Wrong image URL**: The upload script automatically updates `wrangler.toml` with the correct R2 URL

### Common Setup Issues

- **Worker deployment fails**: Ensure your bucket name is unique and exists
- **Feed not updating**: Check the cron trigger is enabled and worker logs in Cloudflare dashboard
- **Invalid feed**: Test locally with `bun run generate` to debug feed issues

### Local Deployment

The project includes automatic deployment on feed updates:

```bash
bun run deploy
```

This command deploys the worker to Cloudflare. The hourly cron (and `/admin` saves) regenerate `podcasts.xml`. Use `curl https://<your-worker>.workers.dev/deploy-trigger` if you want a manual rebuild without opening the admin.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `bun run dev`
5. Submit a pull request

## License

This project is open source and available under the [AGPL-3.0 License](LICENSE).

## Support

If you encounter issues:

1. Check the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
2. Verify your R2 bucket configuration
3. Check the worker logs in the Cloudflare dashboard
4. Open an issue on GitHub

---

**Note**: The default `wrangler.toml` includes demo podcast feeds so the Worker has something to merge before you use `/admin`. You can clear them in the admin UI after you set `ADMIN_SECRET`, or edit `wrangler.toml` before the first deploy.
