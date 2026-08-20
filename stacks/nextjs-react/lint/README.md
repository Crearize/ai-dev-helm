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
