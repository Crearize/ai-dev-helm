---
name: using-superpowers
description: Use when selecting skills for a task or resolving how skill workflows apply
---

# Using Superpowers

Use a skill when the user requests it or its workflow materially helps the task. Read the relevant skill once before applying it, and briefly state its purpose. A matching keyword or a small chance of relevance alone does not require loading a skill. Ordinary questions and read-only exploration can proceed directly.

User instructions and project policy take precedence. Reuse decisions and authorization already present in the conversation; do not restart an approved design or ask again merely because a skill was loaded. Ask only for information or authorization that is still needed.

Scale process to the work. A bounded change can be implemented by the parent with a short approach and appropriate verification. Use design and planning skills for unresolved requirements, architectural decisions, dependencies, or a useful handoff. Independent bounded tasks may be delegated when doing so reduces total effort; having subagent tools does not require using them.

The project's quality-check remains the independent final quality gate. Skill workflows do not add per-task reviews or another whole-branch review on top of it. Keep the project's review budget, test oracles, and evidence requirements.

For tool syntax consult only the reference relevant to your runtime, and trust the actual available tools and instructions over examples:
- Codex: [references/codex-tools.md](references/codex-tools.md)
- Pi: [references/pi-tools.md](references/pi-tools.md)
- Antigravity: [references/antigravity-tools.md](references/antigravity-tools.md)
- Hermes: [references/hermes-tools.md](references/hermes-tools.md)
