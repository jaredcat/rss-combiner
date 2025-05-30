#!/usr/bin/env bun

import { parse } from '@iarna/toml';
import fs from 'fs/promises';

async function setupTemplate() {
  console.log('🚀 Setting up your RSS Combiner...\n');

  // Check if this looks like it's still the template (has example feeds)
  const wranglerPath = 'wrangler.toml';
  const wranglerContent = await fs.readFile(wranglerPath, 'utf-8');

  if (wranglerContent.includes('feeds.example.com')) {
    console.log(
      '⚠️  Warning: Your wrangler.toml still contains example feeds.',
    );
    console.log(
      '   Make sure to replace them with your actual RSS feed URLs.\n',
    );
  }

  // Basic validation
  const config = parse(wranglerContent);
  const workerName = config.name as string;
  const bucketName = (config.r2_buckets as any)?.[0]?.bucket_name as string;
  const feedTitle = (config.vars as any)?.FEED_TITLE as string;
  const feedImageUrl = (config.vars as any)?.FEED_IMAGE_URL as string;

  console.log('Current configuration:');
  console.log(`  Worker name: ${workerName}`);
  console.log(`  R2 bucket: ${bucketName}`);
  console.log(`  Feed title: ${feedTitle || 'Not set'}`);
  console.log(`  Feed image: ${feedImageUrl ? 'Configured' : 'Not set'}\n`);

  // Check for local cover images
  const possibleFiles = ['cover.jpg', 'cover.jpeg', 'cover.png'];
  let localCoverFile: string | null = null;

  for (const file of possibleFiles) {
    try {
      await fs.access(file);
      localCoverFile = file;
      break;
    } catch {
      // File doesn't exist, continue
    }
  }

  if (localCoverFile && !feedImageUrl?.includes(bucketName)) {
    console.log(`🎨 Found local cover image: ${localCoverFile}`);
    console.log('   You can upload it to R2 with: bun run upload-cover\n');
  } else if (localCoverFile && feedImageUrl?.includes(bucketName)) {
    console.log(`✅ Local cover image found and already uploaded to R2!`);
  }

  if (workerName?.includes('your-') || bucketName?.includes('your-')) {
    console.log('🔧 Next steps:');
    console.log('1. Update worker name and bucket name in wrangler.toml');
    console.log('2. Customize FEED_TITLE and optionally set FEED_IMAGE_URL');
    if (localCoverFile) {
      console.log('3. Upload your cover image: bun run upload-cover');
      console.log('4. Replace example feeds with your actual RSS feed URLs');
      console.log(
        '5. Create your R2 bucket: wrangler r2 bucket create YOUR_BUCKET_NAME',
      );
      console.log('6. Deploy your worker: bun run deploy\n');
    } else {
      console.log(
        '3. Optionally add a cover.jpg/cover.png file and run: bun run upload-cover',
      );
      console.log('4. Replace example feeds with your actual RSS feed URLs');
      console.log(
        '5. Create your R2 bucket: wrangler r2 bucket create YOUR_BUCKET_NAME',
      );
      console.log('6. Deploy your worker: bun run deploy\n');
    }
  }

  // Validate image URL if provided
  if (feedImageUrl && !feedImageUrl.includes('example.com')) {
    if (!feedImageUrl.startsWith('https://')) {
      console.log(
        '⚠️  Warning: Feed image URL should use HTTPS for best compatibility.',
      );
    }
    if (feedImageUrl.includes('.r2.dev')) {
      console.log('✅ Using R2-hosted image - great for performance!');
    } else {
      console.log('✅ Custom feed image configured!');
      console.log(
        '💡 Tip: You can also host images directly in R2 with: bun run upload-cover',
      );
    }
  } else if (feedImageUrl?.includes('example.com')) {
    console.log('⚠️  Warning: Feed image URL is still set to example.com');
  }

  // Count configured feeds
  const feedCount = Object.keys(config.vars || {}).filter(
    (key) => key.startsWith('FEED_') && key.endsWith('_URL'),
  ).length;

  console.log(`📡 Configured feeds: ${feedCount}`);

  if (feedCount === 0) {
    console.log(
      '⚠️  No feeds configured yet. Add some FEED_XX_URL variables to wrangler.toml',
    );
  } else if (wranglerContent.includes('feeds.example.com')) {
    console.log(
      '⚠️  Found example feed URLs. Replace them with real RSS feeds.',
    );
  } else {
    console.log('✅ Feeds look configured!');
  }

  console.log(
    '\n📚 Documentation: Check README.md for detailed setup instructions',
  );
  console.log('🐛 Issues? Open an issue on GitHub');
}

setupTemplate().catch(console.error);
