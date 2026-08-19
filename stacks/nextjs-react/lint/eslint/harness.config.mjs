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
//   - devDependencies: eslint, @eslint/js, typescript-eslint, typescript.
//
// File scoping:
//   - Type-aware parts apply only to `**/*.{ts,tsx,mts,cts}`.
//   - Plain-JS parts (@eslint/js recommended, no-console, no-await-in-loop,
//     harness custom rules) apply broadly.
//   - Build output dirs are ignored below; extend `ignores` for product
//     specific output dirs.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import noForwardref from './rules/no-forwardref.js';
import oneComponentPerFile from './rules/one-component-per-file.js';
import exportAtDefinition from './rules/export-at-definition.js';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];

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
  // type-safety (Catalog: A5)
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
