# nextjs-react lint assets

Pre-built lint assets for the Next.js / React stack: an ESLint flat-config preset with three harness-specific rules, plus stack-specific ast-grep rules. Every asset here is execution-verified by the repo test suite (`lib/eslint-assets.test.js`, `lib/lint-assets.test.js`) against violating and conforming fixtures before it ships.

## What a product receives

`ai-dev-helm init` copies these assets into the product; the lint-scaffolding skill does the wiring described below. From the product's perspective:

```
lint/
  eslint/
    harness.config.mjs      # the flat-config preset
    rules/                  # the three custom rules it imports
      no-forwardref.js
      one-component-per-file.js
      export-at-definition.js
  ast-grep/
    nextjs-react/
      no-loop-query-prisma.yml
      no-loop-query-drizzle.yml
  mutation/
    stryker.config.mjs        # pre-built Stryker config (see below)
    stryker.diff.config.mjs   # diff-scoped variant: mutates only the changed lines
    changed-ranges.mjs        # git diff -> Stryker mutation ranges (used by the diff config)
```

## Wiring ESLint

1. Install the peer tooling: `npm i -D eslint @eslint/js typescript-eslint typescript eslint-plugin-react eslint-plugin-react-hooks globals`.
   (On ESLint 10, `eslint-plugin-react`'s published peer range still lags; install it with `--legacy-peer-deps` if npm refuses. The plugin works under flat config on ESLint 10.)
2. Create (or extend) `eslint.config.mjs` at the product root:

```js
import harness from './lint/eslint/harness.config.mjs';

export default [
  ...harness,
  // product-specific overrides go BELOW the preset so they win
];
```

The preset resolves its custom rules relative to itself (`./rules/*.js`), so the `lint/eslint/` directory must be copied as a unit.

### Requirements

- **A product `tsconfig.json` is required.** The preset enables `projectService: true`, so the type-aware rules resolve the nearest `tsconfig.json` for each linted file. Without one, TS/TSX linting errors out.
- Type-aware rules are scoped to `**/*.{ts,tsx,mts,cts}`; the plain-JS rules (`no-console`, `no-await-in-loop`, the security group, the react/react-hooks group, the harness custom rules, `@eslint/js` recommended) apply to all files, so plain `.js`/`.jsx` are guarded too.
- Plain `.js`/`.cjs`/`.mjs`/`.jsx` files receive Node + browser globals (via `globals`) and the right `sourceType`, so CommonJS config files (e.g. `next.config.js`) do not trip `no-undef` on `process`/`module`/`require`/`window`.
- Build output (`.next/`, `dist/`, `build/`, `coverage/`, `out/`, `node_modules/`) is ignored by the preset; add product-specific output dirs in an override.

### Requirements / cost

Type-aware rules (`projectService: true`, `recommendedTypeChecked`) build a full TypeScript program to resolve types, which is **much slower** than the syntax-only rules (the security group, `no-console`, the harness custom rules). On a large repo the type-aware pass dominates lint time. To keep it fast:

- Run `eslint --cache` so unchanged files are skipped between runs.
- Lint diff-scoped file lists in pre-commit / PR checks (only changed `**/*.{ts,tsx}`) and reserve a full-tree run for CI or a nightly job.
- The syntax-only groups stay cheap; if you need a fast advisory pass, an override that turns the type-aware groups off gives near-instant linting while keeping the security/react/custom rules.

### Rule groups and opting out

The preset is organized into commented groups; a product opts out of a group by appending an override that turns the group's rules off (overrides below the preset win). Groups and their catalog references:

| Group | Catalog | Rules |
| --- | --- | --- |
| correctness | A1, A2 | `no-console`, `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `require-await`, `await-thenable` |
| type-safety | A1, A5 | `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment` (description required) |
| security | A1, B1 | `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url` (all files, incl. plain `.js`/`.jsx`) |
| react | A1 | `react/no-danger`, `react/jsx-no-script-url`, `react/jsx-no-target-blank` (XSS-prone JSX sinks) |
| react-hooks | D3 | `react-hooks/rules-of-hooks` (error), `react-hooks/exhaustive-deps` (warn) |
| exhaustiveness | A7 | `@typescript-eslint/switch-exhaustiveness-check` |
| performance | D2 | `no-await-in-loop` |
| maintainability | C6 | `@typescript-eslint/no-magic-numbers` (warn; ignores -1/0/1/2, enums, numeric literal types, ...) |
| harness custom | A1, C7 | `harness/no-forwardref`, `harness/one-component-per-file`, `harness/export-at-definition` |

The security group is deliberately plain-syntax (no type info) so it guards `.js`/`.jsx` config and script files that the type-aware groups never see. The react/react-hooks groups use `eslint-plugin-react` (React version pinned to `19.0` in the preset's `settings`) and `eslint-plugin-react-hooks`.

Example opt-out (drop the performance group):

```js
export default [
  ...harness,
  { rules: { 'no-await-in-loop': 'off' } },
];
```

### The harness custom rules

- **harness/no-forwardref** (A1): React 19 passes `ref` as a regular prop; `forwardRef` imports from `'react'`, `React.forwardRef(...)` calls, and calls of a locally imported `forwardRef` are reported.
- **harness/one-component-per-file** (C7): more than one *exported* React component in a file is reported (second and later). Non-exported uppercase helpers are fine.
- **harness/export-at-definition** (C7): `export { X }` / `export default X` pointing at a local function/class/variable belongs at the definition site. Re-exports from other modules are untouched.

## Wiring ast-grep

The stack rules land at `lint/ast-grep/nextjs-react/` and are picked up by the same per-directory `sgconfig.yml` opt-in used for the shared rules. Both rules are deliberate heuristics for catalog **D1** (N+1 query detection): a Prisma (`prisma.<model>.<fn>(...)`) or Drizzle (`db.select/insert/update/delete(...)`) call inside a for/for-of/for-in/while/do-while body or a `.map()` callback is flagged. `Promise.all(xs.map(x => query(x)))` is flagged too, by design - the AST rule stays coarse and is paired with the runtime query-count check, which is the authority on real round-trip counts. The receivers are matched literally (`prisma`, `db`); a differently named client binding is out of scope for the AST heuristic and is covered by the runtime pairing.

## Mutation testing (Stryker)

`init` copies `mutation/stryker.config.mjs`, `mutation/stryker.diff.config.mjs` and `mutation/changed-ranges.mjs` to the product's `lint/mutation/`. The base config is a pre-built Stryker config: `testRunner: 'vitest'`, source-only `mutate` globs (tests, `*.d.ts` and generated/build output excluded), a lean mutator set (non-behavioural mutators excluded - the config's exclusion list is the single source; `ignoreStatic` on), the `clear-text` / `json` / `html` reporters, and `incremental` on for the full run. The diff config extends it, narrows `mutate` to the **changed lines**, and turns `incremental` off for its own runs (the cache is full-run state; sharing it would merge stale out-of-scope mutants into the diff report). The diff run is what the `test-recommendation` skill (quality-check Step 5, propose-then-decide) uses.

Known limitation: `ignoreStatic` does not take effect for static mutants that have perTest coverage - Stryker core can still report them as Survived. Triage machine-classifies such survivors as `tool_false_negative` (see the `test-recommendation` skill's triage rules).

### Wiring

(Upgrading from a v1.10.x wiring: the old `mutation:diff` script used `--since`, which StrykerJS does not have - it never ran. Replace both scripts with the forms below.)

1. Install the runner tooling as **product devDependencies** (these are product devDeps, not harness deps): `npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner minimatch`. (`minimatch` is what `changed-ranges.mjs` filters files with - the same matcher Stryker itself uses. It is a transitive dependency of the core on npm, but isolated installs (pnpm, Yarn PnP) do not expose transitive packages, so declare it explicitly - in a workspace, at the **workspace root**, where the asset resolves it from; see "Environment notes" below. A product that sets the base ref from a package.json script on Windows also adds `cross-env` - same section.)
2. Register two package.json scripts. The config file is a **positional argument** - StrykerJS has no `--configFile` option, and no `--since` option either (that flag belongs to Stryker.NET):

```json
{
  "scripts": {
    "mutation:full": "stryker run lint/mutation/stryker.config.mjs",
    "mutation:diff": "stryker run lint/mutation/stryker.diff.config.mjs"
  }
}
```

`mutation:full` mutates the whole `mutate` set. `mutation:diff` diffs the **working tree** against the merge base of the base ref (`git diff -U0 <merge-base>` - uncommitted edits count, so line numbers always match the files Stryker actually mutates), turns every hunk into a Stryker mutation range (`src/file.ts:12-15`) and mutates only those lines - a one-line change in a large file yields the mutants of that line, not of the whole file. Files outside the `mutate` globs (tests, `*.d.ts`, generated output) never enter the scope even when they changed; the matching is done with minimatch, applied in Stryker's own order, so the diff scope is always a subset of the full run's scope. Paths containing glob-magic characters (Next.js dynamic routes: `[id]`, `[...slug]`) cannot carry a mutation range - those files fall back to whole-file scope via a character-class-escaped glob; plain `(group)` route segments keep their line ranges.

The base ref defaults to `origin/main` (then `origin/master`) and must be fetched locally. Products whose base branch is named differently set `MUTATION_BASE_REF` (for example `MUTATION_BASE_REF=origin/develop npm run mutation:diff` - POSIX shells only; the Windows forms are under "Environment notes" below); quality-check requires the same base as its own diff detection and records it as `mutation.base_ref`. When no base ref can be resolved (single-branch or shallow clone), `mutation:diff` fails loudly with a fetch hint (`git fetch origin main`) - it never degrades into a silent empty scope; quality-check records that failure as `mutation.reason: "scope_error"`. The old wiring's silent full-run fallback on shallow clones is gone: fetch the base ref or set `MUTATION_BASE_REF`.

**Empty scope**: when no changed line falls inside the mutate set, `mutation:diff` deletes a stale `reports/mutation/mutation.json` from a previous run, prints `[mutation:diff] empty scope ...` and exits 0 without starting Stryker (Stryker itself would otherwise abort with "No tests were executed"). quality-check records `mutation.reason: "empty_scope"` for that case.

Both configs stay in `lint/mutation/` and are addressed by path - nothing needs to move to the product root. Stryker resolves the `mutate` globs and ranges against the working directory, so run the scripts from the directory the globs are written for (the product root for the shipped globs). Add `reports/` and `.stryker-tmp/` to the product `.gitignore` (`ai-dev-helm init` registers `reports/mutation/` and `.stryker-tmp/` automatically) - a committed `stryker-incremental.json` would share stale mutant state between developers.

### Product-specific tuning (jest runner, re-enabling a mutator)

`lint/mutation/` is package-managed - re-running `init` overwrites it. Put product tuning in a product-owned config that spreads the shipped one, and wrap it the same way for the diff scope:

```js
// lint/product/stryker.config.mjs
import base from '../mutation/stryker.config.mjs';

export default {
  ...base,
  testRunner: 'jest', // jest products: install @stryker-mutator/jest-runner instead of the vitest runner
  mutator: { excludedMutations: ['StringLiteral'] }, // a narrower exclusion list than the lean default
};
```

```js
// lint/product/stryker.diff.config.mjs
import { withChangedLines } from '../mutation/changed-ranges.mjs';
import config from './stryker.config.mjs';

export default withChangedLines(config);
```

Then point the two scripts at `lint/product/...`. The `mutate` globs, reporters and incremental settings are inherited.

### Environment notes

Observed while wiring the shipped assets into products. Each is handled in the product's own config, scripts or test setup - never by editing the package-managed files.

- **pnpm / isolated `node_modules`**: Stryker resolves its default plugin glob (`plugins: ['@stryker-mutator/*']`) relative to the core's own install location, which under pnpm's `.pnpm/` layout does not contain the runner, so the run fails with `Cannot find TestRunner plugin "vitest"`. Name the runner explicitly in the product-owned config: `appendPlugins: ['@stryker-mutator/vitest-runner']`.
- **Workspaces / monorepos**: `changed-ranges.mjs` imports `minimatch` from where the asset lives. With `lint/mutation/` at the repository root, Node's ESM resolution walks up from there and never reaches `packages/*/node_modules`, so declaring `minimatch` in an individual package fails with `Cannot find package 'minimatch'` (npm's hoisting can mask this; pnpm's isolated layout does not). Declare `minimatch` where the asset sits - the **workspace root** devDependencies.
- **TypeScript 7**: `@stryker-mutator/core` calls `ts.parseConfigFileTextToJson()` - removed in TypeScript 7 - from its tsconfig preprocessor and fails at startup with `TypeError: ts.parseConfigFileTextToJson is not a function` (observed with core 10 and TypeScript 7.0.2). The core declares no `typescript` dependency, so a package-manager override cannot pin an older compiler for it. First check whether the Stryker release you install has restored TypeScript 7 support. If not, the workaround has two steps: set `tsconfigFile` to a path that does not exist (the preprocessor then no-ops and never touches the TypeScript API); and, **if that tsconfig `extends` a file outside the package**, also add `/tsconfig.json` to `ignorePatterns` so the sandbox copy never sees it - the preprocessor's real job was rewriting that `extends` for the sandbox copy, and without this second step Vite/oxc fails every test with `[TSCONFIG_ERROR]` (the reporting monorepo extended a shared parent, so it needed both). A tsconfig with no outside `extends` stays in the sandbox and keeps serving its `paths` / `jsx` settings.
- **Windows and `MUTATION_BASE_REF`**: the `VAR=value command` prefix only works in POSIX shells. In PowerShell run `$env:MUTATION_BASE_REF = 'origin/develop'; npm run mutation:diff` (the assignment outlives the command - `Remove-Item Env:MUTATION_BASE_REF` clears it). Inside a package.json script - which cmd.exe executes on Windows - use `cross-env MUTATION_BASE_REF=origin/develop stryker run lint/mutation/stryker.diff.config.mjs` with `cross-env` as a product devDependency.
- **Tests that reach the source at runtime rather than by import** (`SELF.fetch()` under `@cloudflare/vitest-pool-workers`, dispatch through a worker or server entry point): the vitest runner picks the tests to run per mutant from the static module graph, so a test that never imports the mutated file statically is silently left out - the mutant is reported `Survived` (or `NoCoverage`) even though that test would kill it. In the diff scope this shows up as false survivors, in the full run as a depressed score. Add a side-effect import of the source entry point to the helper module those tests import - an entry whose import does nothing beyond loading the sources, or a test-only barrel that imports them (an entry that opens connections or reads secrets on import would do that in every test). `setupFiles` do not work for this - the selection does not read the setupFiles graph. This is a wiring gap, not a triage decision: fix it **before** measuring, so the survivors that reach triage are real.
- **Sandbox copies leaking into normal test runs**: Stryker copies the tests into `.stryker-tmp/`, and Vitest's default `exclude` does not cover that directory, so a mutation run in progress (or one that was force-stopped) makes `vitest run` pick up the sandbox copies. Add `'**/.stryker-tmp/**'` to `test.exclude` in the product's Vitest config.

### Score and gating

Stryker writes the machine-readable result to the **json report** (`reports/mutation/mutation.json`): every mutant with its mutator, location and status. The `test-recommendation` skill (quality-check Step 5, propose-then-decide) reads that report, lists the survivors, triages them with the user and presents the raw score as reference information - there is **no pass/fail score** (`quality-policy.md` §2). This config deliberately does **not** set `thresholds.break`, so Stryker never fails the run on score - a score gate exists nowhere. The `thresholds.high` / `thresholds.low` values in the config are report-coloring hints only. Excluded mutators appear as `Ignored` in the report and stay outside the score; `NoCoverage` mutants count as survivors in the triage (a changed line no test reaches is the strongest possible survivor).

### Where it runs

Mutation testing runs **locally only and is not part of CI** (run time is cost). CI stays a build-confirmation stage; see `quality-policy.md` §2 for the execution policy.
