# GitHub Actions Setup Guide

Deploy your RSS combiner entirely through GitHub without any local setup required!

## 🚀 Quick Start (No Local Setup Required)

### 1. Use This Template

1. Click **"Use this template"** on the GitHub repository
2. Create your new repository (can be public or private)
3. Clone or navigate to your new repository

### 2. Get Your Cloudflare API Token

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. Click **"Create Token"**
3. Use the **"Custom token"** template with these permissions:
   - **Account**: `Cloudflare Workers:Edit`
   - **Zone Resources**: `Include - All zones` (or specific zone if you have one)
   - **Account Resources**: `Include - All accounts`
4. Copy the generated API token

### 3. Add Cloudflare API Token to GitHub Secrets

1. In your GitHub repository, go to **Settings** → **Secrets and variables** → **Actions**
2. Click **"New repository secret"**
3. Name: `CLOUDFLARE_API_TOKEN`
4. Value: Paste your Cloudflare API token
5. Click **"Add secret"**

### 4. Customize Your Configuration

Edit the `wrangler.toml` file directly in GitHub:

1. Click on `wrangler.toml` in your repository
2. Click the pencil icon (✏️) to edit
3. Update these values:

```toml
name = "my-podcast-combiner"  # Choose a unique name
bucket_name = "my-podcast-feed-bucket"  # Choose a unique bucket name

[vars]
FEED_TITLE = "My Personal Podcast Feed"
FEED_IMAGE_URL = "https://my-podcast-feed-bucket.r2.dev/cover.jpg"

# Replace example feeds with your actual RSS feeds
FEED_01_URL = "https://feeds.example.com/your-first-podcast"
FEED_02_URL = "https://feeds.example.com/your-second-podcast"
# Add more feeds as needed...
```

4. Commit the changes (this will trigger a deployment)

### 5. Add Cover Image (Optional)

If you want a custom cover image:

1. In your repository, click **"Add file"** → **"Upload files"**
2. Upload your cover image named exactly `cover.jpg` or `cover.png`
3. Commit the file
4. The next deployment will automatically upload it to R2

### 6. Deploy

Deployment happens automatically when you commit changes to the `main` branch, or you can trigger it manually:

1. Go to **Actions** tab in your repository
2. Click **"Deploy RSS Combiner"** workflow
3. Click **"Run workflow"**
4. Click the green **"Run workflow"** button

### 7. Access Your Feed

After deployment completes (usually 2-3 minutes):

- **RSS Feed**: `https://your-worker-name.workers.dev/podcasts.xml`
- **Health Check**: `https://your-worker-name.workers.dev/healthcheck`

## 📱 Add to Pocket Casts (Mobile Listening)

To listen to your combined feed on your phone or tablet:

### Option 1: Pocket Casts (Recommended)

1. **Go to [Pocket Casts Submit](https://pocketcasts.com/submit/)**
2. **Enter your RSS feed URL**: `https://your-worker-name.workers.dev/podcasts.xml`
3. **Select "Private"**: This keeps your personal feed private
4. **Click "Submit"**
5. **Use the private link**: Pocket Casts will give you a link to add the feed to all your devices

**Why "Private"?** Your combined feed is personal - you don't want it appearing in public podcast searches.

### Option 2: Other Podcast Apps

- **Apple Podcasts**: Use "Add a Show by URL"
- **Overcast**: Use "Add URL" option
- **Castro**: Add via URL in settings

## 📋 Configuration Options

### Feed Settings

Edit these in `wrangler.toml` under the `[vars]` section:

```toml
[vars]
# Basic feed metadata
FEED_TITLE = "Your Feed Title"
FEED_IMAGE_URL = "https://your-bucket.r2.dev/cover.jpg"

# Feed filtering
DEFAULT_CUTOFF_DATE_YEAR = "2024"  # Only episodes from this year onwards

# Individual feed configuration
FEED_01_URL = "https://example.com/feed1.xml"
FEED_01_CUTOFF_YEAR = "2023"  # Optional: override default cutoff for this feed

FEED_02_URL = "https://example.com/feed2.xml"
# No cutoff = includes all episodes

# Add up to 99 feeds (FEED_01 through FEED_99)
```

### Advanced Feed Options

For each feed (replace `XX` with zero-padded numbers like `01`, `02`, etc.):

- `FEED_XX_URL`: RSS feed URL (required)
- `FEED_XX_CUTOFF_YEAR`: Only episodes from this year onwards
- `FEED_XX_CUTOFF_MONTH`: Combined with year for precise filtering
- `FEED_XX_CUTOFF_DAY`: Combined with year/month for exact date filtering
- `FEED_XX_DATE_SYNC`: Set to `"true"` to adjust episode dates for chronological ordering

## 🔄 Automatic Updates

Your feed updates automatically every hour via Cloudflare Cron Triggers. No maintenance required!

## 🛠️ Managing Your Feed

### Updating Configuration

1. Edit `wrangler.toml` directly in GitHub
2. Commit changes
3. GitHub Actions will automatically redeploy

### Adding New Feeds

1. Edit `wrangler.toml`
2. Add new `FEED_XX_URL` entries with the next available number
3. Commit changes

### Changing Cover Image

1. Delete the old `cover.jpg`/`cover.png` file (if it exists)
2. Upload your new image with the same name
3. Commit changes
4. The new image will be automatically uploaded to R2

### Manual Deployment

1. Go to **Actions** tab
2. Select **"Deploy RSS Combiner"**
3. Click **"Run workflow"**

## 📊 Monitoring

### Check Deployment Status

1. Go to **Actions** tab
2. View the latest workflow run
3. Check logs for any errors

### Validate Your Feed

After deployment, check:

- **Feed XML**: Visit `https://your-worker-name.workers.dev/podcasts.xml`
- **Health Status**: Visit `https://your-worker-name.workers.dev/healthcheck`
- **Cloudflare Dashboard**: Check your Workers and R2 sections

## 🔧 Troubleshooting

### Deployment Fails

**Common Issues:**

1. **Invalid API Token**: Make sure your `CLOUDFLARE_API_TOKEN` secret is correct
2. **Name Conflicts**: Worker or bucket names must be globally unique
3. **Invalid Feed URLs**: Ensure your RSS feed URLs are accessible

**Check Logs:**

1. Go to **Actions** tab
2. Click on the failed workflow run
3. Expand the failed step to see error details

### Feed Not Updating

1. Check the **Actions** tab for failed deployments
2. Verify your RSS feed URLs are still valid
3. Manually trigger a deployment to force an update

### Cover Image Not Showing

1. Ensure the image file is named exactly `cover.jpg` or `cover.png`
2. Check that the deployment completed successfully
3. Verify the `FEED_IMAGE_URL` was updated in `wrangler.toml`

### Pocket Casts Issues

1. **Feed not appearing**: Wait up to 12 hours for indexing (as noted on [Pocket Casts Submit](https://pocketcasts.com/submit/))
2. **Make sure you selected "Private"**: Public feeds may get rejected if they're personal combinations
3. **Check feed URL**: Ensure your worker URL is accessible and returns valid XML

## 🎯 Benefits of GitHub Actions Deployment

- **✅ No Local Setup**: Everything runs in the cloud
- **🔄 Automatic Deployments**: Changes deploy automatically
- **📊 Built-in Monitoring**: View deployment status and logs
- **🔒 Secure**: API tokens stored as encrypted secrets
- **🌍 Global CDN**: Powered by Cloudflare's edge network
- **💰 Cost Effective**: Free GitHub Actions + Cloudflare's generous free tier

## 🆘 Getting Help

If you encounter issues:

1. Check the **Actions** logs for detailed error messages
2. Validate your configuration with the **"Validate Configuration"** workflow
3. Open an issue on the repository with deployment logs
4. Check [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)

---

**🎉 That's it!** Your RSS combiner is now running entirely in the cloud with automatic updates and no maintenance required.
