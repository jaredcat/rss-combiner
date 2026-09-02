#!/usr/bin/env bun

import { parse } from '@iarna/toml';
import fs from 'node:fs/promises';

const COVER_FILES = ['cover.jpg', 'cover.jpeg', 'cover.png'] as const;

function warnIfExampleFeeds(wranglerContent: string): void {
  if (!wranglerContent.includes('feeds.example.com')) return;
  console.log('⚠️  Warning: Your wrangler.toml still contains example feeds.');
  console.log('   Make sure to replace them with your actual RSS feed URLs.\n');
}

function logCurrentConfig(
  workerName: string,
  bucketName: string,
  feedTitle: string | undefined,
  feedImageUrl: string | undefined,
): void {
  console.log('Current configuration:');
  console.log(`  Worker name: ${workerName}`);
  console.log(`  R2 bucket: ${bucketName}`);
  console.log(`  Feed title: ${feedTitle || 'Not set'}`);
  console.log(`  Feed image: ${feedImageUrl ? 'Configured' : 'Not set'}\n`);
}

async function findExistingFile(
  files: readonly string[],
): Promise<string | null> {
  for (const file of files) {
    try {
      await fs.access(file);
      return file;
    } catch {
      // File doesn't exist, continue
    }
  }
  return null;
}

function logCoverHints(
  localCoverFile: string | null,
  feedImageUrl: string | undefined,
  bucketName: string,
): void {
  if (!localCoverFile) return;
  if (feedImageUrl?.includes(bucketName)) {
    console.log('✅ Local cover image found and already uploaded to R2!');
    return;
  }
  console.log(`🎨 Found local cover image: ${localCoverFile}`);
  console.log('   You can upload it to R2 with: bun run upload-cover\n');
}

function logNextSteps(needsRename: boolean, hasLocalCover: boolean): void {
  if (!needsRename) return;
  console.log('🔧 Next steps:');
  console.log('1. Update worker name and bucket name in wrangler.toml');
  console.log('2. Customize FEED_TITLE and optionally set FEED_IMAGE_URL');
  if (hasLocalCover) {
    console.log('3. Upload your cover image: bun run upload-cover');
  } else {
    console.log(
      '3. Optionally add a cover.jpg/cover.png file and run: bun run upload-cover',
    );
  }
  console.log('4. Replace example feeds with your actual RSS feed URLs');
  console.log(
    '5. Create your R2 bucket: wrangler r2 bucket create YOUR_BUCKET_NAME',
  );
  console.log('6. Deploy your worker: bun run deploy\n');
}

function logFeedImageStatus(feedImageUrl: string | undefined): void {
  if (!feedImageUrl) return;
  if (feedImageUrl.includes('example.com')) {
    console.log('⚠️  Warning: Feed image URL is still set to example.com');
    return;
  }
  if (!feedImageUrl.startsWith('https://')) {
    console.log(
      '⚠️  Warning: Feed image URL should use HTTPS for best compatibility.',
    );
  }
  if (feedImageUrl.includes('.r2.dev')) {
    console.log('✅ Using R2-hosted image - great for performance!');
    return;
  }
  console.log('✅ Custom feed image configured!');
  console.log(
    '💡 Tip: You can also host images directly in R2 with: bun run upload-cover',
  );
}

function logFeedCount(feedCount: number, hasExampleFeeds: boolean): void {
  console.log(`📡 Configured feeds: ${feedCount}`);
  if (feedCount === 0) {
    console.log(
      '⚠️  No feeds configured yet. Add some FEED_XX_URL variables to wrangler.toml',
    );
    return;
  }
  if (hasExampleFeeds) {
    console.log(
      '⚠️  Found example feed URLs. Replace them with real RSS feeds.',
    );
    return;
  }
  console.log('✅ Feeds look configured!');
}

async function setupTemplate() {
  console.log('🚀 Setting up your RSS Combiner...\n');

  const wranglerPath = 'wrangler.toml';
  const wranglerContent = await fs.readFile(wranglerPath, 'utf-8');
  const hasExampleFeeds = wranglerContent.includes('feeds.example.com');
  warnIfExampleFeeds(wranglerContent);

  const config = parse(wranglerContent);
  const workerName = config.name as string;
  const bucketName = (config.r2_buckets as any)?.[0]?.bucket_name as string;
  const feedTitle = (config.vars as any)?.FEED_TITLE as string;
  const feedImageUrl = (config.vars as any)?.FEED_IMAGE_URL as string;

  logCurrentConfig(workerName, bucketName, feedTitle, feedImageUrl);

  const localCoverFile = await findExistingFile(COVER_FILES);
  logCoverHints(localCoverFile, feedImageUrl, bucketName);
  logNextSteps(
    !!workerName?.includes('your-') || !!bucketName?.includes('your-'),
    !!localCoverFile,
  );
  logFeedImageStatus(feedImageUrl);

  const feedCount = Object.keys(config.vars || {}).filter(
    (key) => key.startsWith('FEED_') && key.endsWith('_URL'),
  ).length;
  logFeedCount(feedCount, hasExampleFeeds);

  console.log(
    '\n📚 Documentation: Check README.md for detailed setup instructions',
  );
  console.log('🐛 Issues? Open an issue on GitHub');
}

try {
  await setupTemplate();
} catch (e) {
  console.error(e);
}
