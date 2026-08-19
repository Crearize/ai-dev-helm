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

1. Install the peer tooling: `npm i -D eslint @eslint/js typescript-eslint typescript`.
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
- Type-aware rules are scoped to `**/*.{ts,tsx,mts,cts}`; plain-JS rules (`no-console`, `no-await-in-loop`, the harness custom rules, `@eslint/js` recommended) apply to all files.
- Build output (`.next/`, `dist/`, `build/`, `coverage/`, `out/`, `node_modules/`) is ignored by the preset; add product-specific output dirs in an override.

### Rule groups and opting out

The preset is organized into commented groups; a product opts out of a group by appending an override that turns the group's rules off (overrides below the preset win). Groups and their catalog references:

| Group | Catalog | Rules |
| --- | --- | --- |
| correctness | A1, A2 | `no-console`, `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `require-await`, `await-thenable` |
| type-safety | A5 | `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment` (description required) |
| exhaustiveness | A7 | `@typescript-eslint/switch-exhaustiveness-check` |
| performance | D2 | `no-await-in-loop` |
| maintainability | C6 | `@typescript-eslint/no-magic-numbers` (warn; ignores -1/0/1/2, enums, numeric literal types, ...) |
| harness custom | A1, C7 | `harness/no-forwardref`, `harness/one-component-per-file`, `harness/export-at-definition` |

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
