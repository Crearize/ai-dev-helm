// stryker.diff.config.mjs - diff-scoped Stryker run (mutation:diff)
//
// Extends stryker.config.mjs and narrows `mutate` to the lines of the WORKING
// TREE changed against the merge base of the base ref, using Stryker's
// mutation-range syntax (`path:startLine-endLine`). The base ref defaults to
// origin/main, then origin/master, then a local main / master (clones and
// worktrees without remote-tracking refs), overridable with MUTATION_BASE_REF.
// Run it as
//
//   stryker run lint/mutation/stryker.diff.config.mjs
//
// The config file is a positional argument: StrykerJS has no --configFile
// option and no --since option (`--since` belongs to Stryker.NET).
//
// Behavior notes (see changed-ranges.mjs for the mechanics):
// - Empty scope (docs-only or test-only diffs, or changes only in excluded
//   paths): the stale json report is removed, "[mutation:diff] empty scope"
//   is printed and the process exits 0 before Stryker starts; quality-check
//   records `mutation.reason: "empty_scope"`.
// - A failed scope derivation (base ref not fetched, git failure) throws
//   loudly; quality-check records `mutation.reason: "scope_error"`. It is
//   never converted into a silent empty scope.
// - Files whose paths contain glob-magic characters (Next.js [id] segments)
//   fall back to whole-file scope; all other files are scoped per line.
// - `incremental` stays off by default and never touches the full run's
//   cache (`incrementalFile` always names the diff-only cache).
//   MUTATION_INCREMENTAL=1 opts in for re-measurement; the cache is reused
//   only while the scope still covers the previous run against the same
//   merge base and is discarded first otherwise - Stryker would keep the
//   stale out-of-scope mutants in this run's report.
//
// A product that extends the base config (jest runner, a re-enabled mutator)
// keeps this file untouched and wraps its own config the same way:
//   import { withChangedLines } from './changed-ranges.mjs';
//   export default withChangedLines(myConfig);

import base from './stryker.config.mjs';
import { withChangedLines } from './changed-ranges.mjs';

export default withChangedLines(base);
