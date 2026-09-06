---
name: brainstorming
description: Use when requirements, tradeoffs, or architectural decisions need clarification before implementation
---

# Brainstorming Ideas Into Designs

Read the relevant existing flow and the user's constraints. Identify the intended behavior, scope, and observable success criteria. Do not reopen decisions or approvals already given.

- For a bounded, authorized change, describe the approach briefly and proceed once requirements are clear. A separate spec or approval round is unnecessary.
- For exploratory work, state what the probe can establish and report its limitations. Do not turn a disposable experiment into a product change outside the authorized scope.
- For architectural work, compare the meaningful alternatives and document interfaces, data flow, failure behavior, compatibility, and verification. Split only where the work has independent deliverables.

Bundle related clarification questions into a small set. Resolve routine implementation choices from the repository and conversation. When a consequential product decision or authorization is missing, ask and continue only independent work while waiting. Do not interpret elapsed time as approval.

Write a spec when it helps review or preserves decisions across sessions, normally at docs/superpowers/specs/YYYY-MM-DD-topic-design.md. Check for ambiguity, contradictions, and scope gaps. Follow the project's independent design review policy and budget; do not add another review merely because a skill also mentions it. Respect ignored/local-only documentation and do not force a commit.

Use writing-plans when sequencing or handoff benefits from a plan; otherwise continue with implementation and appropriate tests. Preserve the independent final quality-check.

For decisions that benefit from browser mockups, use the optional [visual companion](visual-companion.md). Follow the user's existing preference and the guide's browser launch instructions.
