import eslint from '@eslint/js';
import narwhal from 'eslint-config-narwhal';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sharedRules = {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  // Cloudflare Workers + this repo use Env / env throughout.
  'unicorn/name-replacements': [
    'error',
    {
      allowList: {
        Env: true,
        env: true,
        RebuildEnv: true,
      },
    },
  ],
  // Action helpers that return success/failure are not boolean predicates.
  'unicorn/consistent-boolean-name': [
    'error',
    {
      ignore: [
        'claimPublishedPointer',
        'publishJobFeed',
        'blockHasBinding',
        'needsRename',
        'existing',
      ],
    },
  ],
};

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      '.wrangler/**',
      'dist/**',
      'worker-configuration.d.ts',
      'podcasts.xml',
      'bun.lockb',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...narwhal,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.worker,
      },
    },
    rules: sharedRules,
  },
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      // Wrangler/CI helper CLIs.
      'unicorn/no-process-exit': 'off',
    },
  },
  {
    // Script that also exports helpers for unit tests.
    files: ['scripts/ensure-queue-ci.ts'],
    rules: {
      'unicorn/no-exports-in-scripts': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'unicorn/no-top-level-assignment-in-function': 'off',
    },
  },
  {
    files: ['src/admin.ts'],
    rules: {
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/no-identical-functions': 'off',
    },
  },
);
