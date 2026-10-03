---
name: requesting-code-review
description: Use when arranging the project quality-check or investigating a concrete unresolved code concern
---

# Requesting Code Review

Use the project's quality-check as the independent final review, with its prescribed roles and review budget. Do not require a reviewer after every implementation task or add a whole-branch reviewer after quality-check has already covered the same change.

Give reviewers the actual changed files, requirements, independently established test expectations, and observed verification evidence. Use the current working-tree diff for uncommitted work, not only a stale commit range. Ask reviewers to check the specification and actual behavior independently rather than simply endorse the author's explanation.

[code-reviewer.md](code-reviewer.md) is an optional review brief. Project policy determines review scope, blocking criteria, and budget. A separate targeted investigation needs a concrete unresolved concern and must not reset the budget.

Evaluate findings against evidence. Fix confirmed blocking defects, record reasoned disagreement, and rerun checks affected by fixes. Preserve original detection sources when merging duplicate findings; represent no findings as an empty collection. Do not treat a reviewer approval as a substitute for execution evidence.
