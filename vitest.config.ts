import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['scripts/**/*.test.ts', 'src/**/*.unit.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.toml' },
          }),
        ],
        test: {
          name: 'workers',
          include: ['src/**/*.worker.test.ts'],
        },
      },
    ],
  },
});
