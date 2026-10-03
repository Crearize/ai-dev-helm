---
name: subagent-driven-development
description: Use when independent bounded tasks benefit from delegation during implementation
---

# Subagent-Driven Development

Choose delegation by total effort: briefing, implementation, rediscovery, integration, and rework. The parent may implement or fix code directly. Do not require a particular implementation model or forbid the parent model from writing code. Select available models for task difficulty and use the runtime's actual tool contract.

Delegate only work with clear ownership, interfaces, acceptance criteria, and useful independence. Parallel tasks must not edit the same files or depend on unfinished shared state. Give each worker concise requirements, relevant source paths, the workspace, constraints, and expected verification; do not ask it to transcribe a complete implementation from a plan.

Use [implementer-prompt.md](implementer-prompt.md) as an optional brief template. The controller integrates results, resolves dependencies, and can handle a small fix itself. Workers report evidence and uncertainties; they do not launch extra reviewers. Maintain a concise progress record only when it aids resumption, using existing runtime records where available.

Run appropriate tests while implementing. After integration, use the project's independent quality-check and its review budget. There is no mandatory task-by-task review, spec/quality double review, or additional whole-branch reviewer. A targeted investigation can still be requested when a concrete unresolved concern requires another perspective; account for it in the existing review budget.

The task-brief and workspace scripts remain optional utilities for larger handoffs. Legacy task review/re-review templates are optional formats for an explicitly selected quality-check investigation, not additional gates. Do not create their ledgers, snapshots, or packages unless the chosen workflow needs them.

Before completion, verify the integrated result and report what changed, test evidence, and material limitations. Continue integration within existing authorization and project branch policy.
