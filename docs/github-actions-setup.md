# Deploy with GitHub Actions (easiest path)

You can run this project **without installing anything on your computer**: GitHub builds and deploys to **Cloudflare Workers**, and the **web admin** at `/admin` is the normal way to add podcast feeds after the first deploy.

## What you need

1. A **GitHub account** (free).
2. A **Cloudflare account** (free tier is enough): [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). You do not need your own domain name.
3. A few minutes to create an **API token** and paste two **repository secrets** in GitHub.

## Why the “Deploy” workflow might not run on one specific repo

The workflow is **skipped** when `github.repository` is exactly `jaredcat/rss-combiner` — that is the **canonical template** repository used for **“Use this template”**. It has no Cloudflare token configured on purpose.

When you **create a repository from the template**, your repo has a **different name** (for example `yourname/rss-combiner`), so the deploy workflow **does run** for you.

## Step 1 — Create your repo from the template

1. Open the template on GitHub.
2. Click **Use this template** → **Create a new repository**.
3. Pick a name, public or private, and create it.

## Step 2 — Cloudflare API token

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. Open **My Profile** (avatar) → **API Tokens**.
3. Click **Create Token** → **Create Custom Token**.
4. Name it (e.g. `rss-combiner-github`).
5. Permissions — add:

   | Resource | Permission |
   |----------|------------|
   | Account — **Workers Scripts** | Edit |
   | Account — **Workers KV Storage** | Edit |
   | Account — **Workers R2 Storage** | Edit |
   | Account — **Account Settings** | Read (optional; helps some accounts resolve correctly) |

   Under **Account Resources**, choose **Include** → **All accounts** (or pick the account that should host the Worker).

6. **Continue to summary** → **Create Token** and copy the token once (you will not see it again).

If your token can access **more than one** Cloudflare account, also copy your **Account ID**: **Workers & Pages** (or any Workers overview) → right-hand summary → **Account ID**. You will add it as `CLOUDFLARE_ACCOUNT_ID` below.

## Step 3 — GitHub repository secrets

In your **new** repo (not the template source):

1. **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Add:

   | Name | Value |
   |------|--------|
   | `CLOUDFLARE_API_TOKEN` | The token from step 2 |
   | `ADMIN_SECRET` | A password you choose for `/admin` on your worker (`https://<worker-name>.workers.dev/admin`) |
   | `CLOUDFLARE_ACCOUNT_ID` | *(Only if the deploy log asks for it or you have multiple Cloudflare accounts)* Your Account ID from the dashboard |

Without `ADMIN_SECRET`, the Worker deploys but **`/admin` stays disabled** until you set the secret (locally: `wrangler secret put ADMIN_SECRET`).

## Step 4 — Name your Worker and bucket (required once)

Edit `wrangler.toml` in the GitHub editor (or clone locally):

- **`name`** — Globally unique Worker name (becomes `https://&lt;name&gt;.workers.dev`).
- **`bucket_name`** under `[[r2_buckets]]` — Globally unique R2 bucket name (often match your project).

Commit to the **`main`** branch. That push starts the **Deploy RSS Combiner** workflow.

The workflow will:

- Create or reuse a **KV namespace** for `/admin` (you can keep the placeholder `id` in git — CI patches it during the job).
- Create the **R2 bucket** if it does not exist.
- **Deploy** the Worker.
- Upload `cover.jpg` / `cover.png` from the repo root if present.
- Apply **`ADMIN_SECRET`** from GitHub to the Worker as the `ADMIN_SECRET` binding.

## Step 5 — Open the admin and add feeds

1. When the workflow finishes, open:

   `https://<your-worker-name>.workers.dev/admin`

2. Sign in with the password you stored in `ADMIN_SECRET`.
3. Set **Public base URL** to your Worker URL (same origin, e.g. `https://&lt;name&gt;.workers.dev`).
4. Add RSS URLs for your podcasts and **Save**. The combined feed is written to **`/podcasts.xml`** on save (and refreshed on the hourly cron).

### Cover image and R2

- To use **Upload to R2** in the admin UI, set **`R2_PUBLIC_BASE_URL`** in `wrangler.toml` `[vars]` to your bucket’s public URL, e.g. `https://&lt;bucket_name&gt;.r2.dev` (no trailing slash). You may need to enable public access for that bucket in **R2** → bucket → **Settings** as Cloudflare documents.
- Or commit a **`cover.jpg`** in the repo root; the next deploy uploads it.

## Manual deploy

**Actions** → **Deploy RSS Combiner** → **Run workflow**.

## Validate configuration

**Actions** → **Validate Configuration** runs on pushes and pull requests to `main` (also skipped on the canonical template repo). It typechecks the project and checks `wrangler.toml` for common mistakes.

## Troubleshooting

| Problem | What to try |
|--------|-------------|
| Deploy fails with auth / account errors | Confirm `CLOUDFLARE_API_TOKEN` permissions; add `CLOUDFLARE_ACCOUNT_ID` if you have multiple accounts. |
| `/admin` says disabled | Add `ADMIN_SECRET` in GitHub secrets and re-run deploy, or run `wrangler secret put ADMIN_SECRET` after a local deploy. |
| Bucket or Worker name taken | Change `name` / `bucket_name` in `wrangler.toml` to something unique. |

For local development (Wrangler, `bun run dev`), create a KV namespace once and put its id in `wrangler.toml`, or copy the id from a successful GitHub Actions log after the first deploy.
