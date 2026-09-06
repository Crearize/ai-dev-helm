---
name: writing-plans
description: Use when a multi-step change needs explicit sequencing, dependencies, or a handoff
---

# Writing Plans

Write the smallest plan that makes the authorized work executable and verifiable. Prefer outcomes and contracts over a script for every keystroke. Do not write the implementation twice in a plan and then ask another model to transcribe it.

For a small change, a short task list is sufficient. For substantial work, save a plan at docs/superpowers/plans/YYYY-MM-DD-topic.md, or the project's preferred location. Include:

- Goal, scope, and accepted design or requirements.
- Files or components affected and dependencies between tasks.
- Required behavior, interface contracts, edge cases, and acceptance criteria.
- Meaningful verification and its independent oracle; commands when known.
- Ownership only where work is actually delegated.

Provide exact code only when an API contract or non-obvious constraint requires it. Avoid mandatory 2-5 minute steps, full implementation listings, and a separate commit or review for each task. Tasks should produce coherent, independently testable results.

Self-check coverage, ordering, and contradictions. Follow the project's independent document review policy and review budget without adding duplicate reviews. An already approved design does not need another approval just to start its plan.

The parent may implement directly. Delegate only useful independent bounded work, accounting for briefing, rediscovery, and integration cost as well as model cost. Use executing-plans for continuation or subagent-driven-development when delegation is chosen. Do not ask the user to select an execution mechanism already authorized by the task.

The final change still passes the project's independent quality-check and relevant verification.
