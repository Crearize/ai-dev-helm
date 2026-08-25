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

`init` copies `mutation/stryker.config.mjs`, `mutation/stryker.diff.config.mjs` and `mutation/changed-ranges.mjs` to the product's `lint/mutation/`. The base config is a pre-built Stryker config: `testRunner: 'vitest'`, source-only `mutate` globs (tests, `*.d.ts` and generated/build output excluded), a lean mutator set (`StringLiteral`, `ObjectLiteral`, `ArrayDeclaration`, `Regex` and `OptionalChaining` excluded; `ignoreStatic` on), the `clear-text` / `json` / `html` reporters, and `incremental` on. The diff config extends it and narrows `mutate` to the **lines changed since the base ref** - that is what quality-check Step 3.5 runs.

### Wiring

1. Install the runner tooling as **product devDependencies** (these are product devDeps, not harness deps): `npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner`.
2. Register two package.json scripts. The config file is a **positional argument** - StrykerJS has no `--configFile` option, and no `--since` option either (that flag belongs to Stryker.NET):

```json
{
  "scripts": {
    "mutation:full": "stryker run lint/mutation/stryker.config.mjs",
    "mutation:diff": "stryker run lint/mutation/stryker.diff.config.mjs"
  }
}
```

`mutation:full` mutates the whole `mutate` set. `mutation:diff` reads `git diff -U0 <base>...HEAD` (merge-base semantics), turns every hunk into a Stryker mutation range (`src/file.ts:12-15`) and mutates only those lines - a one-line change in a large file yields the mutants of that line, not of the whole file. Files outside the `mutate` globs (tests, `*.d.ts`, generated output) never enter the scope even when they changed, and `incremental` lets the loop re-runs quality-check performs reuse the previous results.

The base ref defaults to `origin/main` and must be fetched locally. Products whose base branch is named differently set `MUTATION_BASE_REF` (for example `MUTATION_BASE_REF=origin/develop npm run mutation:diff`); quality-check requires the same base as its own diff detection and records it as `mutation.base_ref`.

**Empty scope**: when no changed line falls inside the mutate set, `mutation:diff` prints `[mutation:diff] empty scope ...` and exits 0 without starting Stryker (Stryker itself would otherwise abort with "No tests were executed"). quality-check records `mutation.reason: "empty_scope"` for that case.

Both configs stay in `lint/mutation/` and are addressed by path - nothing needs to move to the product root. Stryker resolves the `mutate` globs and ranges against the working directory, so run the scripts from the directory the globs are written for (the product root for the shipped globs).

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

### Score and gating

Stryker writes the machine-readable result to the **json report** (`reports/mutation/mutation.json`): every mutant with its mutator, location and status. `quality-check` reads that report, lists the survivors, triages them (gate mode) and compares the adjusted score against the mutation-score thresholds single-sourced in `quality-policy.md` §2 (do not restate the numbers here). This config deliberately does **not** set `thresholds.break`, so Stryker never fails the run on score - gating is entirely `quality-check`'s job. The `thresholds.high` / `thresholds.low` values in the config are report-coloring hints only and are not the gate. Excluded mutators appear as `Ignored` in the report and stay outside the score.

### Where it runs

Mutation testing runs **locally only and is not part of CI** (run time is cost). CI stays a build-confirmation stage; see `quality-policy.md` §2 for the execution policy.
