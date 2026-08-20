// stryker.config.mjs - pre-built Stryker mutation-testing config (nextjs-react stack)
//
// How a product uses this config (see ../README.md for full wiring):
//   - Install the runner devDeps (product devDeps, not harness deps):
//     @stryker-mutator/core and @stryker-mutator/vitest-runner.
//   - Register package.json scripts: "mutation:full" and "mutation:diff".
//   - Run locally only. Mutation testing is not part of CI.
//
// Score gating is NOT done here. quality-check reads the json report below and
// compares the mutation score against the thresholds single-sourced in
// quality-policy.md §2. Do not hardcode gate numbers in this file.

export default {
  // --- runner (product tunes: swap for jest products) --------------------
  // vitest products use @stryker-mutator/vitest-runner. A jest product swaps
  // testRunner to 'jest' and installs @stryker-mutator/jest-runner instead.
  testRunner: 'vitest',

  // --- mutate globs (product tunes) --------------------------------------
  // Source under test only. Excludes tests, type declarations (*.d.ts) and
  // generated / build output. Adjust globs to the product's source layout.
  mutate: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.{test,spec}.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/**/*.stories.{ts,tsx}',
    '!src/**/generated/**',
    '!.next/**',
    '!dist/**',
    '!build/**',
    '!coverage/**',
  ],

  // --- reporters ---------------------------------------------------------
  // clear-text: console summary. html: human report. json: the machine report
  // quality-check reads for the mutation score.
  reporters: ['clear-text', 'json', 'html'],

  // Pin the json report path so quality-check reads it from a fixed,
  // predictable location instead of relying on Stryker's implicit default.
  // Mirrors PIT's stable-path approach (timestampedReports = false).
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },

  // --- incremental (enables mutation:diff since-scoped runs) -------------
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',

  // --- report-coloring hints only (NOT the gate) -------------------------
  // thresholds.high / thresholds.low only color the html/clear-text report
  // bands and are deliberately NOT set to the policy gate values. They are NOT
  // the quality gate. The gate lives in quality-policy.md §2 and is applied by
  // quality-check. thresholds.break is intentionally left unset so Stryker
  // never fails the run on score; gating is quality-check's job.
  thresholds: {
    high: 90,
    low: 50,
  },
};
