---
name: finishing-a-development-branch
description: Use when verified implementation is ready for an integration decision or authorized integration
---

# Finishing a Development Branch

Confirm the final change has completed the project's independent quality-check and required checks. Evidence must describe the current tree: rerun affected verification after material edits or integration changes, and report unresolved failures. Do not add another whole-branch review or repeat an unchanged successful test suite merely to follow this skill.

Determine the repository, branch, base, worktree ownership, and uncommitted changes with read-only Git commands. Verify the intended target from the plan, upstream, or conversation before integrating.

Follow the integration action already authorized by the user. Do not present an approval menu again when the user has requested a PR or another concrete action. If authorization or the target is missing, finish the reviewable result first, then ask the specific remaining question.

A project with no remote integrates into main without a PR, with main open in another worktree: (1) finish quality-check in the feature worktree so the flag matches HEAD; (2) in the checkout that has main open, run `git switch --detach`; (3) in the feature worktree, run `git push . HEAD:main` (git refuses anything but a fast-forward); (4) in the main checkout, run `git switch main`; (5) delete `.quality-check-passed`. Use this only when no remote exists. With the feature and main in one checkout, finish quality-check on the feature, switch to main and run `git merge <feature>`: the quality gate checks that the flag names that branch's tip and that main has nothing the branch lacks. Delete `.quality-check-passed` after any merge into main.

Keep the project's branch protections and quality gate. A local merge or main push is not a substitute for a required PR. Investigate rejected pushes; do not force-push or bypass a gate without explicit applicable authorization.

When creating a PR, describe the problem, resulting behavior, and observed checks. Preserve the worktree for feedback. On an environment-owned worktree, use supported platform operations and leave cleanup to its owner.

Clean up only a worktree you created and only after its work is safely integrated or explicitly discarded. Check for uncommitted and ignored files before removal. Never force removal of files that exist nowhere else; resolve their disposition with the user. Do not infer permission to discard work from an integration request.
