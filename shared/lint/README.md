# Lint assets

Pre-built static-analysis assets placed into this `lint/` directory by `ai-dev-helm init`. They are **not yet wired up** — copying them here changes nothing about your build. Wiring and enabling (ESLint config imports, `sgconfig.yml` opt-ins, Gradle plugin blocks, CI steps) is done by the `lint-scaffolding` skill, which walks through each group and records what was enabled.

## Layout

```
lint/
  README.md                 # this file
  README-<stack>.md         # per-stack wiring guide (only for selected stacks)
  ast-grep/
    <category>/             # generic, stack-independent rule groups
      *.yml                 # ast-grep rules
      README.md             # what the group catches and why
    <stack>/                # stack-specific ast-grep rules (e.g. nextjs-react/)
  eslint/                   # ESLint flat-config preset + custom rules (nextjs-react)
  checkstyle/               # Checkstyle preset (java-springboot)
  archunit/                 # ArchUnit test-class template (java-springboot)
  mutation/                 # mutation-testing config (per selected stack; see below)
  product/                  # product-owned, NOT package-managed (init never touches it)
    ast-grep/               # generated rules that fill gaps; add to sgconfig.yml ruleDirs
```

Which directories you have depends on the stacks selected during `init`; the generic `ast-grep/<category>/` groups are always present. Everything except `lint/product/` is package-managed (see Updating); `lint/product/` is yours to own.

## Opting in and out

Products opt in **per directory / per group** — nothing here is all-or-nothing:

- Enable only the groups that fit your product; the `lint-scaffolding` skill handles the mechanics.
- **The durable opt-out is the coverage map plus leaving the group out of `sgconfig.yml` (or the equivalent tool config) — NOT deleting the directory.** These `lint/` directories are package-managed: re-running `ai-dev-helm init` restores a deleted directory, so a deletion does not durably opt out. Record the decision in the coverage map and simply do not wire the group in.
- Do not weaken a rule in place to make it pass — opt out of the group whole and record why.

## Mutation testing

Stacks that ship a mutation-testing config place it under `lint/mutation/`: `stryker.config.mjs` + `stryker.diff.config.mjs` + `changed-ranges.mjs` (Stryker, nextjs-react) or `pitest.gradle` (PIT, java-springboot). Like everything else here it arrives **unwired**; the per-stack guide (`README-<stack>.md`) describes the wiring and the two entry points - full scope and diff scope (`mutation:full` / `mutation:diff` package.json scripts on the JS side, `mutationFull` / `mutationDiff` Gradle tasks on the Java side). Three contracts to know:

- **Score gating is owned by quality-check, not by these configs.** They deliberately set no failing threshold (`thresholds.break` / `mutationThreshold`); quality-check reads the generated report and compares the score against the thresholds single-sourced in `documents/development/quality-policy.md` §2. Do not add a threshold to the config to "make it strict" — that moves the gate out of the policy's control.
- **The diff scope is changed lines (Stryker) or changed classes (PIT), never whole changed files.** `stryker.diff.config.mjs` derives mutation ranges from the working tree against the merge base of the base ref; `pitest.gradle` narrows `targetClasses` the same way when the `mutationDiff` task is invoked with `-PmutationDiffBase=<ref>`. An empty scope is reported and the run ends without mutating anything; a failed derivation (base ref not fetched) fails loudly instead. The shipped mutator set is lean on purpose (non-behavioural mutators excluded, see quality-policy §2); re-enable one in a product-owned config that extends the shipped one, never by editing these package-managed files.
- **Mutation runs are local-only** (run time is cost); CI stays a build-confirmation stage. See quality-policy §2 for the execution policy.

## Generated rules

Rules you generate to fill gaps (categories with no pre-built asset for your stack) go in the **product-owned** `lint/product/ast-grep/` directory and are added to `sgconfig.yml` `ruleDirs`. Never place generated rules inside the package-managed `lint/ast-grep/` tree: `init` overwrites that tree with the release's versions and can remove them. `lint/product/` is never written by `init`, so your rules survive re-runs.

## Updating

These files are package-managed: re-running `ai-dev-helm init` overwrites them with the current release's versions (and restores any you deleted). Keep product-specific overrides in your own config (e.g. ESLint overrides below the preset) and generated rules in `lint/product/`, not by editing these files. `lint/product/` is the one directory here `init` never touches.
