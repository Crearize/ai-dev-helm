// stryker.diff.config.mjs - diff-scoped Stryker run (mutation:diff)
//
// Extends stryker.config.mjs and narrows `mutate` to the lines changed since
// the base ref (default origin/main; override with MUTATION_BASE_REF), using
// Stryker's mutation-range syntax (`path:startLine-endLine`). Run it as
//
//   stryker run lint/mutation/stryker.diff.config.mjs
//
// The config file is a positional argument: StrykerJS has no --configFile
// option and no --since option (`--since` belongs to Stryker.NET).
//
// Empty scope (docs-only or test-only diffs, or changes only in excluded
// paths): nothing is mutated, the empty scope is reported and the process
// exits 0 before Stryker starts. quality-check records
// `mutation.reason: "empty_scope"` for that case.
//
// A product that extends the base config (jest runner, a re-enabled mutator)
// keeps this file untouched and wraps its own config the same way:
//   import { withChangedLines } from './changed-ranges.mjs';
//   export default withChangedLines(myConfig);

import base from './stryker.config.mjs';
import { withChangedLines } from './changed-ranges.mjs';

export default withChangedLines(base);
