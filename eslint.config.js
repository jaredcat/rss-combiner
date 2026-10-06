import narwhal from 'eslint-config-narwhal';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

const sharedRules = {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  // Pad indices / status codes in strings are intentional.
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowNumber: true },
  ],
  // Empty-string defaults (`x || ''`) are intentional for RSS/form fields.
  '@typescript-eslint/prefer-nullish-coalescing': [
    'error',
    { ignorePrimitives: { string: true } },
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
      'pnpm-lock.yaml',
      'worker-configuration.d.ts',
    ],
  },
  ...narwhal({
    typescript: true,
    typechecked: true,
    strict: true,
    stylistic: true,
    prettier: true,
  }),
  {
    languageOptions: {
      parserOptions: {
        // allowJs in tsconfig already covers eslint.config.js; narwhal 2.1
        // disables typed rules on that file. No allowDefaultProject needed.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
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
    files: ['vitest.config.ts'],
    rules: {
      // Vitest configs export defineConfig(...) at the top level by design.
      'unicorn/no-top-level-side-effects': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'unicorn/no-top-level-assignment-in-function': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
);
