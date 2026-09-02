# Testing CI before merge, and migrating an existing Worker

## Why deploy does not run on `jaredcat/rss-combiner`

The **Deploy RSS Combiner** workflow is skipped when `github.repository` is exactly `jaredcat/rss-combiner` (the template source). There is no Cloudflare token on that repo by design.

To exercise the **same YAML + scripts** as production, use one of the options below.

## Option A — Fork (closest to real CI)

1. Fork this repository to your GitHub account (your fork’s name becomes e.g. `yourname/rss-combiner`).
2. In the fork: **Settings → Secrets and variables → Actions**, add `CLOUDFLARE_API_TOKEN`, `ADMIN_SECRET`, and optionally `CLOUDFLARE_ACCOUNT_ID`.
3. Push your branch to the fork (or merge into the fork’s `main`). The workflow runs because `github.repository` is **not** `jaredcat/rss-combiner`.
4. Or open **Actions → Deploy RSS Combiner → Run workflow** and pick your branch.

Use a **non-production** Worker name and bucket in `wrangler.toml` while testing if you want zero risk to the live worker.

## Option B — Second repo from “Use this template”

Create a throwaway repo from the template, add the same secrets, push. Same behavior as a fork.

## Option C — Local dry run (script + Wrangler only)

From a clone with your branch checked out:

```bash
export CLOUDFLARE_API_TOKEN="..."   # Workers + KV + R2
export CLOUDFLARE_ACCOUNT_ID="..."  # if your token sees multiple accounts

bun install
bun run ensure-kv-ci
```

That patches `wrangler.toml` **on disk** if the KV id is still the placeholder (same as CI). Then:

```bash
bunx wrangler deploy
# Optional: pipe your admin password into the Worker secret
printf '%s' 'your-password' | bunx wrangler secret put ADMIN_SECRET
```

**Git note:** If you run `ensure-kv-ci` locally, you either commit the new KV `id` line or restore `wrangler.toml` from git. For the **template**, keeping the placeholder in git is fine because CI patches each run. For a **migration**, you usually **commit the real KV id** once (see below).

---

## Migrating an existing Cloudflare Worker

Goal: deploy this project so it **replaces** your current Worker (same URL) and keeps **R2** and **KV admin config** where possible.

### 1. Worker name (script name)

In `wrangler.toml`, set:

```toml
name = "your-existing-worker-name"
```

A deploy with the same `name` **updates** that Worker in place. If you use a **new** name, you get a new `*.workers.dev` URL until you change routes/custom domains.

### 2. R2 bucket

Set `bucket_name` to your **existing** bucket name so the Worker keeps using the same `podcasts.xml` and cover objects:

```toml
[[r2_buckets]]
binding = "XML_BUCKET"
bucket_name = "your-existing-bucket"
```

The GitHub Action only **creates** the bucket if it is missing; an existing bucket is left as-is.

### 3. KV (admin config)

- If your old setup already used a KV namespace bound as `CONFIG_KV` (or you are okay pointing at that namespace):

  1. In the dashboard: **Workers & Pages → KV**, open the namespace that holds your admin data.
  2. Copy its **ID**.
  3. In `wrangler.toml`, set that id and **do not** leave the placeholder:

  ```toml
  [[kv_namespaces]]
  binding = "CONFIG_KV"
  id = "paste-the-real-namespace-id-here"
  ```

  With a **real** id, `ensure-kv-ci` does **not** create a new namespace or overwrite your config.

- If you leave the **placeholder** id, CI will create a **new** namespace named like `rss-combiner-kv-<worker-name>`. Your old `config:v1` data would **not** move automatically — only use the placeholder when you want a fresh admin state.

### 4. Secret `ADMIN_SECRET`

Match production by setting the same password:

- **GitHub Actions:** repository secret `ADMIN_SECRET` (workflow runs `wrangler secret put ADMIN_SECRET` after deploy).
- **Local:** `printf '%s' 'password' | wrangler secret put ADMIN_SECRET`

### 5. Vars and cron

Copy `[vars]` and `[triggers]` from your old `wrangler.toml` or from the Worker **Settings → Variables** in the dashboard so behavior (cutoffs, feed list, cron) matches what you expect.

### 6. Custom domain / routes

If the old Worker used a **custom domain** or **routes**, re-check **Workers & Pages → your Worker → Triggers / Custom domains** after deploy; replacing the script usually keeps the same bindings, but verify DNS and routes still point at this Worker.

### 7. Order of operations (safe migration)

1. Test on a **fork** or **staging** Worker name first (optional but recommended).
2. When ready, set `name`, `bucket_name`, and **real KV `id`** in `wrangler.toml`, align `[vars]`, merge, and let Actions deploy (or deploy locally).
3. Confirm `https://<worker>/admin` and `https://<worker>/podcasts.xml`.

---

## Quick checklist

| Item | Action |
|------|--------|
| Same Worker URL | `name` = existing Worker name |
| Same RSS file / cover in R2 | `bucket_name` = existing bucket |
| Keep admin settings | Real KV `id` in `wrangler.toml`, not placeholder |
| Same `/admin` password | `ADMIN_SECRET` in GitHub + workflow, or `wrangler secret put` |
