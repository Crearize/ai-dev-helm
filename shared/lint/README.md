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
```

Which directories you have depends on the stacks selected during `init`; the generic `ast-grep/<category>/` groups are always present.

## Opting in and out

Products opt in **per directory / per group** — nothing here is all-or-nothing:

- Enable only the groups that fit your product; the `lint-scaffolding` skill handles the mechanics.
- **Deleting an unused directory is fine.** The coverage map maintained by the skill records the decision, so a deleted group is a documented opt-out, not a gap.
- Do not weaken a rule in place to make it pass — opt out of the group whole and record why.

## Updating

These files are package-managed: re-running `ai-dev-helm init` overwrites them with the current release's versions. Keep product-specific overrides in your own config (e.g. ESLint overrides below the preset), not by editing these files.
