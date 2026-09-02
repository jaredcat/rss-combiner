#!/usr/bin/env bun

import { parse, stringify } from '@iarna/toml';
import { execSync } from 'child_process';
import fs from 'fs/promises';

async function uploadCover() {
  console.log('🎨 Uploading cover image to R2...\n');

  // Check for cover image files
  const possibleFiles = ['cover.jpg', 'cover.jpeg', 'cover.png'];
  let coverFile: string | null = null;

  for (const file of possibleFiles) {
    try {
      await fs.access(file);
      coverFile = file;
      console.log(`✅ Found cover image: ${file}`);
      break;
    } catch {
      // File doesn't exist, continue
    }
  }

  if (!coverFile) {
    console.log('❌ No cover image found.');
    console.log(
      '   Place a cover.jpg, cover.jpeg, or cover.png file in the project root.',
    );
    console.log('   Recommended size: 1400x1400px or larger.');
    process.exit(1);
  }

  // Read wrangler config to get bucket name
  const wranglerContent = await fs.readFile('wrangler.toml', 'utf-8');
  const config = parse(wranglerContent);
  const bucketName = (config.r2_buckets as any)?.[0]?.bucket_name as string;

  if (!bucketName) {
    console.log('❌ No R2 bucket configured in wrangler.toml');
    process.exit(1);
  }

  console.log(`📦 Uploading to bucket: ${bucketName}`);

  try {
    // Upload the file to R2
    const command = `wrangler r2 object put ${bucketName}/cover.jpg --file=${coverFile}`;
    console.log(`Running: ${command}`);
    execSync(command, { stdio: 'inherit' });

    // Update wrangler.toml with the R2 URL
    const imageUrl = `https://${bucketName}.r2.dev/cover.jpg`;

    // Update the FEED_IMAGE_URL in the config
    const updatedConfig = { ...config };
    if (!updatedConfig.vars) {
      updatedConfig.vars = {};
    }
    (updatedConfig.vars as any).FEED_IMAGE_URL = imageUrl;

    // Write back to wrangler.toml
    const updatedContent = stringify(updatedConfig);
    await fs.writeFile('wrangler.toml', updatedContent);

    console.log('\n✅ Cover image uploaded successfully!');
    console.log(`🌐 Image URL: ${imageUrl}`);
    console.log('📝 Updated wrangler.toml with new image URL');
    console.log('\n🚀 Deploy your worker to use the new image:');
    console.log('   bun run deploy');
  } catch (error) {
    console.error('❌ Failed to upload cover image:', error);
    console.log('\n💡 Make sure:');
    console.log('   1. You have wrangler installed and authenticated');
    console.log(
      '   2. Your R2 bucket exists: wrangler r2 bucket create YOUR_BUCKET_NAME',
    );
    console.log('   3. You have permission to write to the bucket');
    process.exit(1);
  }
}

uploadCover().catch(console.error);
