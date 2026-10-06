---
name: executing-plans
description: Use when continuing implementation from an existing plan
---

# Executing Plans

Read the plan and current progress, then confirm its assumptions against the repository. Preserve existing decisions and completed work. Resolve gaps within the approved design; do not ask the user again after the design approval.

Use an existing isolated workspace or the project's workspace policy. The parent may execute tasks directly. Delegate independent bounded work only when the handoff and integration cost is worthwhile; tool availability alone is not a reason to switch workflows.

For each coherent task, implement the required behavior and run appropriate focused verification. Adjust mechanical steps when evidence warrants it while preserving scope and contracts. Track enough progress to survive interruption without reproducing tool logs by hand.

Investigate failures instead of merely stopping at the first failed command. Decide within the approved design; record deviations from the design and report them in the final report. Stop only for the exceptions in `documents/development/development-policy.md` §1.0 "承認後の進め方".

Complete the project's independent quality-check once for the final change, using its review budget and required verification. Do not add per-task reviews or another final code reviewer. Integrate according to existing authorization and project branch policy; use finishing-a-development-branch when integration guidance is needed.

Only the quality-check review limit (and a production's final quality review limit) stops the work (exception X1); a plan or mutation review limit is recorded and passed. If that limit is reached and the user approves exceeding it, run `extend` yourself with the same review-budget script used in step 1 of the quality-check reservation (`.claude/hooks/…`, `.codex/hooks/…`, or `npx --no ai-dev-helm review-budget` (where the CLI is not installed, `npx -y @crearize/ai-dev-helm@<version in .ai-dev-helm.json> review-budget`)): `extend --phase <phase> --rounds <1-3> --reason "<the user's approval, quoted>"`; never ask the user to run commands, inspect state, or reset state.
