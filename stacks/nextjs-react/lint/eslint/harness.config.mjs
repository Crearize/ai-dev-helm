// harness.config.mjs - pre-built ESLint flat-config preset (nextjs-react stack)
//
// How a product uses this preset (see ../README.md for full wiring):
//
//   // eslint.config.mjs at the product root
//   import harness from './lint/eslint/harness.config.mjs';
//   export default [
//     ...harness,
//     // product-specific overrides go BELOW so they win
//   ];
//
// Opting out of a rule group: append an override object that sets the
// group's rules to 'off'. Each group below is delimited by a comment header
// with its catalog references, so an opt-out is a copy of that group's rule
// names with 'off', e.g.:
//
//   { rules: { 'no-await-in-loop': 'off' } }              // drop performance (D2)
//   { rules: { '@typescript-eslint/no-magic-numbers': 'off' } } // drop maintainability (C6)
//
// Requirements:
//   - `projectService: true` needs a tsconfig.json in the product (the
//     TypeScript project service resolves the nearest tsconfig for each
//     linted file). Without a product tsconfig the type-aware rules error.
//   - devDependencies: eslint, @eslint/js, typescript-eslint, typescript,
//     eslint-plugin-react, eslint-plugin-react-hooks, globals.
//
// File scoping:
//   - Type-aware parts apply only to `**/*.{ts,tsx,mts,cts}`.
//   - Plain-JS parts (@eslint/js recommended, no-console, no-await-in-loop,
//     the security group, the react/react-hooks group and the harness custom
//     rules) apply broadly, so plain `.js`/`.jsx` files are guarded too.
//   - Plain `.js`/`.cjs`/`.mjs`/`.jsx` files get Node + browser globals and the
//     right sourceType so config files (e.g. `next.config.js`) do not trip
//     `no-undef` on `process`/`module`/`require`/`window`.
//   - Build output dirs are ignored below; extend `ignores` for product
//     specific output dirs.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

import noForwardref from './rules/no-forwardref.js';
import oneComponentPerFile from './rules/one-component-per-file.js';
import exportAtDefinition from './rules/export-at-definition.js';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
// Every file the react/react-hooks + custom rules should see.
const ALL_SOURCE_FILES = ['**/*.{js,cjs,mjs,jsx,ts,tsx,mts,cts}'];

const harnessPlugin = {
  meta: { name: 'harness' },
  rules: {
    'no-forwardref': noForwardref,
    'one-component-per-file': oneComponentPerFile,
    'export-at-definition': exportAtDefinition,
  },
};

export default [
  // ---------------------------------------------------------------------
  // Global ignores (build output; extend per product)
  // ---------------------------------------------------------------------
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/out/**',
    ],
  },

  // ---------------------------------------------------------------------
  // Baselines: @eslint/js recommended (all files) +
  // typescript-eslint recommended-type-checked (TS/TSX only)
  // ---------------------------------------------------------------------
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TS_FILES,
  })),
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        // Requires a tsconfig.json in the product; the project service picks
        // the nearest one for each linted file.
        projectService: true,
      },
    },
  },

  // ---------------------------------------------------------------------
  // Plain-JS language options: give `.js`/`.cjs`/`.mjs`/`.jsx` files the
  // Node + browser globals and the right sourceType so `js.configs.recommended`
  // (applied to all files above) does not flag `process`/`module`/`require`/
  // `window` as `no-undef`. TS/TSX files are handled by typescript-eslint,
  // which turns `no-undef` off for them.
  // ---------------------------------------------------------------------
  {
    // CommonJS scripts and config files (next.config.js, scripts/*.cjs).
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // ES modules and plain JSX.
    files: ['**/*.mjs', '**/*.jsx'],
    languageOptions: {
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ---------------------------------------------------------------------
  // security (Catalog: A1, B1) - all files, not just TS. Guards plain
  // `.js`/`.jsx` too. `no-implied-eval` overlaps the type-aware
  // `@typescript-eslint/no-implied-eval` on TS files (both may report); the
  // base rule is what covers plain JS where the TS rule never runs.
  // ---------------------------------------------------------------------
  {
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // react / react-hooks (Catalog: A1, D3) - XSS + hooks correctness. The
  // react plugin needs a version; set it explicitly because React is a peer
  // of the product, not installed alongside this preset.
  // ---------------------------------------------------------------------
  {
    files: ALL_SOURCE_FILES,
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: '19.0' },
    },
    rules: {
      'react/no-danger': 'error',
      'react/jsx-no-script-url': 'error',
      'react/jsx-no-target-blank': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ---------------------------------------------------------------------
  // correctness (Catalog: A1, A2)
  // ---------------------------------------------------------------------
  {
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: TS_FILES,
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // type-safety (Catalog: A1, A5)
  // ---------------------------------------------------------------------
  {
    files: TS_FILES,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': { descriptionFormat: '^: .+$' },
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // exhaustiveness (Catalog: A7)
  // ---------------------------------------------------------------------
  {
    files: TS_FILES,
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // performance (Catalog: D2)
  // ---------------------------------------------------------------------
  {
    rules: {
      'no-await-in-loop': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // maintainability (Catalog: C6)
  // ---------------------------------------------------------------------
  {
    files: TS_FILES,
    rules: {
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // harness custom (Catalog: A1, C7)
  // ---------------------------------------------------------------------
  {
    plugins: {
      harness: harnessPlugin,
    },
    rules: {
      'harness/no-forwardref': 'error',
      'harness/one-component-per-file': 'error',
      'harness/export-at-definition': 'error',
    },
  },
];
