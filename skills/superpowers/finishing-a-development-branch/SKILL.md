---
name: finishing-a-development-branch
description: Use when verified implementation is ready for an integration decision or authorized integration
---

# Finishing a Development Branch

Confirm the final change has completed the project's independent quality-check and required checks. Evidence must describe the current tree: rerun affected verification after material edits or integration changes, and report unresolved failures. Do not add another whole-branch review or repeat an unchanged successful test suite merely to follow this skill.

Determine the repository, branch, base, worktree ownership, and uncommitted changes with read-only Git commands. Verify the intended target from the plan, upstream, or conversation before integrating.

Follow the integration action already authorized by the user. Do not present an approval menu again when the user has requested a PR or another concrete action. If authorization or the target is missing, finish the reviewable result first, then ask the specific remaining question.

Keep the project's branch protections and quality gate. A local merge or main push is not a substitute for a required PR. Investigate rejected pushes; do not force-push or bypass a gate without explicit applicable authorization.

When creating a PR, describe the problem, resulting behavior, and observed checks. Preserve the worktree for feedback. On an environment-owned worktree, use supported platform operations and leave cleanup to its owner.

Clean up only a worktree you created and only after its work is safely integrated or explicitly discarded. Check for uncommitted and ignored files before removal. Never force removal of files that exist nowhere else; resolve their disposition with the user. Do not infer permission to discard work from an integration request.
