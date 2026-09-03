// stryker.config.mjs - pre-built Stryker mutation-testing config (nextjs-react stack)
//
// How a product uses this config (see ../README.md for full wiring):
//   - Install the runner devDeps (product devDeps, not harness deps):
//     @stryker-mutator/core and @stryker-mutator/vitest-runner.
//   - Register package.json scripts. The config file is a positional argument
//     (StrykerJS has no --configFile option):
//       "mutation:full": "stryker run lint/mutation/stryker.config.mjs"
//       "mutation:diff": "stryker run lint/mutation/stryker.diff.config.mjs"
//     stryker.diff.config.mjs extends this file and narrows `mutate` to the
//     lines changed since the base ref (see changed-ranges.mjs).
//   - Run locally only. Mutation testing is not part of CI.
//
// There is no score gate - not here, not downstream. The test-recommendation
// skill (quality-check Step 5) reads the json report below, presents the score
// as reference information and triages survivors with the user
// (quality-policy.md §2). Do not add gate numbers to this file.

export default {
  // --- runner (product tunes: swap for jest products) --------------------
  // vitest products use @stryker-mutator/vitest-runner. A jest product sets
  // testRunner to 'jest' in a product-owned config that spreads this one and
  // installs @stryker-mutator/jest-runner instead.
  testRunner: 'vitest',

  // --- mutate globs (product tunes) --------------------------------------
  // Source under test only. Excludes tests, type declarations (*.d.ts) and
  // generated / build output. Adjust globs to the product's source layout.
  // changed-ranges.mjs applies the same globs when it derives the diff scope,
  // so mutation:diff never reaches a file mutation:full would not mutate.
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

  // --- mutator set (lean by default) -------------------------------------
  // Only behaviour-changing mutators stay enabled. The excluded ones mostly
  // produce survivors in non-behavioural code - log messages and string keys
  // (StringLiteral), option objects (ObjectLiteral), constant arrays
  // (ArrayDeclaration), regex patterns (Regex) and defensive `?.` guards
  // (OptionalChaining) - that cost real tests to kill without proving anything
  // about the change under review. Excluded mutants are reported as `Ignored`
  // and do not count toward the score. Re-enable one by overriding
  // `mutator.excludedMutations` in a product-owned config that spreads this
  // one; do not edit this package-managed file.
  mutator: {
    excludedMutations: [
      'StringLiteral',
      'ObjectLiteral',
      'ArrayDeclaration',
      'Regex',
      'OptionalChaining',
    ],
  },

  // Static mutants only execute while a file loads (module-level constants
  // and initialisers). They need a full test-runner restart each and rarely
  // say anything about the change under review. Requires coverageAnalysis
  // 'perTest', which is Stryker's default.
  ignoreStatic: true,

  // --- reporters ---------------------------------------------------------
  // clear-text: console summary. html: human report. json: the machine report
  // the test-recommendation skill reads for the mutation score.
  reporters: ['clear-text', 'json', 'html'],

  // Pin the json report path so the report is read from a fixed,
  // predictable location instead of relying on Stryker's implicit default.
  // Mirrors PIT's stable-path approach (timestampedReports = false).
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },

  // --- incremental (the full run's own cache) ----------------------------
  // This cache is FULL-RUN state. The diff config (stryker.diff.config.mjs)
  // never reads or writes it: it always points `incrementalFile` at its own
  // diff-only cache (reports/mutation/stryker-incremental.diff.json) and
  // keeps `incremental` off unless MUTATION_INCREMENTAL=1 opts the
  // re-measurement in (see changed-ranges.mjs).
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',

  // --- report-coloring hints only (NOT a gate) ---------------------------
  // thresholds.high / thresholds.low only color the html/clear-text report
  // bands. There is no mutation-score gate: the score is reference
  // information for the test-recommendation skill's survivor triage
  // (quality-policy.md §2). thresholds.break is intentionally left unset so
  // Stryker never fails the run on score.
  thresholds: {
    high: 90,
    low: 50,
  },
};
