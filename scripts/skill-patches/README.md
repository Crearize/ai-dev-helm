# Harness skill patches

`transform-skills.sh` copies the selected upstream skills, rewrites cross-skill
paths, normalizes nested fences, then applies these patches in filename order.
The patches modify the instructions actually loaded by agents; templates do not
need to repeat upstream override rules.

Patches are unified diffs relative to `skills/superpowers`. They apply with zero
fuzz and a dry run first. A missing required skill, missing patch set, or rejected
patch fails synchronization and names the failure in CI output. A failed sync
does not update `.superpowers-version` or publish a sync PR. Inspect the Actions
failure, reconcile the upstream change, regenerate the affected patch against the
transformed upstream source, and rerun verification; never skip a rejected patch.

`001-proportional-workflow.patch` is based on Superpowers 6.3.0 after the two
existing transformations. It makes planning proportional, allows direct parent
implementation, removes duplicate task/final reviews, and reuses existing user
authorization. Project quality-check, review budget, independent test evidence,
and branch/permission policy remain authoritative.

Run `npx vitest run lib/skill-transform.test.js`. The integration tests reconstruct
the upstream fixture by reversing the patch, then check reproduction, repeat
synchronization, missing skills, and intentional conflicting upstream drift.
When upgrading upstream, also run the transform on the actual new release.
