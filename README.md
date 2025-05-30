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
- 🚀 **GitHub Actions Deployment**: Deploy entirely through GitHub (no local setup required!)
- 🛠️ **Local Development**: Test and preview feeds locally before deployment

## 🚀 Quick Start (Recommended)

### GitHub Actions Deployment (No Local Setup Required)

The easiest way to deploy your RSS combiner is entirely through GitHub Actions:

**👉 [Follow the GitHub Actions Setup Guide](docs/github-actions-setup.md)**

**Summary:**

1. Use this template to create your repository
2. Add your Cloudflare API token to GitHub Secrets
3. Edit `wrangler.toml` directly in GitHub to configure your feeds
4. Optionally upload a `cover.jpg` image
5. Commit changes to automatically deploy!

Your feed will be available at: `https://your-worker-name.workers.dev/podcasts.xml`

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

1. **Create an R2 bucket**:

   ```bash
   wrangler r2 bucket create your-podcasts-xml
   ```

2. **Upload your cover image** (if you have one):

   ```bash
   bun run upload-cover
   ```

3. **Deploy the worker**:

   ```bash
   bun run deploy
   ```

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
- `FEED_XX_DATE_SYNC`: Set to "true" to sync episode dates (optional)

Where `XX` is a zero-padded number (01, 02, 03, etc.).

### Global Settings

- `DEFAULT_CUTOFF_DATE_*`: Default cutoff date for feeds without specific cutoffs
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
- `POST /deploy-trigger`: Manually triggers feed regeneration (called automatically after deployment)

## Customization

### Feed Metadata

The easiest way to customize your feed is through environment variables in `wrangler.toml`:

```toml
[vars]
FEED_TITLE = "John's Tech Podcasts"
FEED_IMAGE_URL = "https://your-bucket.r2.dev/cover.jpg"  # Uploaded via 'bun run upload-cover'
```

For more advanced customization, edit the feed metadata in `src/xmlBuilder.ts`:

```typescript
const feed = new RSS({
  title: feedTitle || 'My Combined Podcast Feed',
  description: 'A combined feed of all my favorite podcasts',
  feed_url: 'https://your-worker.workers.dev/podcasts.xml',
  site_url: 'https://your-worker.workers.dev',
  generator: 'Cloudflare Worker RSS Combiner',
  language: 'en',
  // Custom image will be automatically included if FEED_IMAGE_URL is set
});
```

### Episode Filtering

The combiner supports:

- **Date-based filtering**: Only include episodes after a certain date
- **Future episode filtering**: Automatically excludes episodes with future dates
- **Date synchronization**: Adjust episode publication dates for chronological ordering

## Deployment

### GitHub Actions (Recommended)

See the **[GitHub Actions Setup Guide](docs/github-actions-setup.md)** for complete instructions.

### Local Deployment

The project includes automatic deployment on feed updates:

```bash
bun run deploy
```

This command:

1. Deploys the worker to Cloudflare
2. Triggers an initial feed generation
3. Sets up the hourly cron job for updates

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

**Note**: This template includes example podcast feeds in the configuration. Make sure to replace them with your own feeds before deploying.
