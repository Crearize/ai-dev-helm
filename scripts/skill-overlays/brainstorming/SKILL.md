---
name: brainstorming
description: Use before implementing any feature, behavior change, or refactor - settles requirements and design, then gets the design independently reviewed and approved by the user before code is written
---

# Brainstorming Ideas Into Designs

Read the relevant existing flow and the user's constraints. Identify the intended behavior, scope, and observable success criteria. Do not reopen decisions already given.

- For a bounded change, a short design in chat is enough: approach, files touched, and tests.
- For exploratory work, state what the probe can establish and report its limitations. Do not turn a disposable experiment into a product change outside the authorized scope.
- For architectural work, compare the meaningful alternatives and document interfaces, data flow, failure behavior, compatibility, and verification. Split only where the work has independent deliverables.

Bundle related clarification questions into one message. Resolve routine implementation choices from the repository and conversation. When a consequential product decision or authorization is missing, ask and continue only independent work while waiting. Do not interpret elapsed time as approval.

Write a spec when it helps review or preserves decisions across sessions, normally at docs/superpowers/specs/YYYY-MM-DD-topic-design.md. Check it for ambiguity, contradictions, and scope gaps before the design review. Respect ignored/local-only documentation and do not force a commit.

## Design Gate

When the design is complete, complete these steps in order before writing any implementation code. The gate applies to bounded and architectural designs alike; only the length of the design scales.

0. **Create a task branch first.** Review reservations are per branch and are refused on `main`/`master`, so create the task branch before reserving the design review.
1. **Reserve the review.** Run `node .claude/hooks/review-budget.cjs begin --phase design --roles document-reviewer` (`.codex` in a Codex-only project; in an environment where the review-budget hook is not installed or not trusted (in this distribution, Cursor for example), `ai-dev-helm review-budget begin` with the same arguments; see `documents/development/harness-runtime.md`). Add `--limit 3` to this first reservation only when the design is known to be large (quality-policy §5.5). Place the returned marker line at the top of the reviewer prompt.
2. **Request the design review.** Dispatch one reviewer named `document-reviewer` (Codex: `helm-doc-reviewer`) with the design-review model from `harness-runtime.md`. Give it [spec-document-reviewer-prompt.md](spec-document-reviewer-prompt.md), the design or spec path, the user's requirements, and the relevant existing code. Fix confirmed findings. Another round is allowed only within the reserved limit and when the review raised a High finding; otherwise report the remaining concern in step 3 rather than reserving again.
3. **Ask the user to review the design.** Send one message with the design, the review findings and how each was resolved, and the decisions that need approval. Stop there. Start implementation only after the user explicitly approves. If the user requests changes, revise and present the design again; ask the user before any further review round. If the user approves exceeding the review limit, run `node .claude/hooks/review-budget.cjs extend --phase design --rounds <1-3> --reason "<the user's approval, quoted>"` yourself; never ask the user to run commands, inspect state, or reset state.

Exemption: a typo fix that involves no design choice, or an obviously correct change of a few lines. A fix within an already approved design (such as a response to a quality-check finding) that does not change that design needs no new Design Gate. State what you will change before making an exempt change.

None of these replaces the gate: your own self-check, a request to implement given before the design existed, a plan review, or the final quality-check. If the reservation is denied, report the reason and ask the user how to proceed.

Once the user approves, do not ask again when updating the spec or writing the plan.

## After Approval

Update the spec, if any, with the approved decisions. Use writing-plans when sequencing or handoff benefits from a plan; otherwise continue with implementation and appropriate tests. Preserve the independent final quality-check.

For decisions that benefit from browser mockups, use the optional [visual companion](visual-companion.md). Follow the user's existing preference and the guide's browser launch instructions.
