# Claude Code Setup

## What Gets Installed

| Item | Location | Description |
|------|----------|-------------|
| Skills | `.claude/skills/` | Symlink to `skills/` (superpowers + project skills) |
| Rules | `.claude/rules/` | Stack-specific coding rules |
| Hook | `.claude/hooks/quality-gate.cjs` | Merge-gate hook (Node, cross-platform); registered as a PreToolUse hook by settings.json |
| Hook | `.claude/hooks/review-budget.cjs` | Review-only admission (counts review rounds); registered as PreToolUse / PostToolUse hooks |
| Hook | `.claude/hooks/context-handoff.cjs` | Saves a record of the conversation before /compact and /clear and puts its key points back after them; registered as PreCompact / SessionStart / SessionEnd / Stop hooks (see `documents/development/harness-runtime.md`) |
| Hook | `.claude/hooks/owner-guard.cjs` | Question and request guard (3.8.0): refuses an AskUserQuestion whose header has no class (業務・客先・費用・資源・取消・範囲・本番・差異・設計・延長・テスト・その他), a 業務 / 客先 / 範囲 question without 「（調べたもの: …）」, and a 延長 question while the last reserved review round (quality / production) is below its limit (延長:停滞 / 設計 / 要件 / 全員 pass); a final reply that asks the user to run or open something without `[本人の操作]` is sent back. Registered as PreToolUse (`^AskUserQuestion$`) / Stop hooks, fail-open (Claude Code only; see `documents/development/harness-runtime.md`) |
| Settings | `.claude/settings.json` | Hook registration, permission deny rules |
| CLAUDE.md | `CLAUDE.md` (project root) | AI configuration file |

Shared assets installed alongside (tool-independent): `documents/development/` (policies, coding rules), `.github/review-*.md` (review guides), `.github/PULL_REQUEST_TEMPLATE.md`, `lint/` (pre-built lint assets, wired later by the lint-scaffolding skill), and `.ai-dev-helm.json` (applied-version manifest).

## Directory Structure After Setup

```
your-project/
├── .claude/
│   ├── skills -> ../skills    # Symlink to shared skills
│   ├── rules/
│   │   ├── frontend/          # Frontend rules (from stack)
│   │   └── backend/           # Backend rules (from stack)
│   ├── hooks/
│   │   ├── quality-gate.cjs   # Merge-gate hook (always overwritten by init)
│   │   ├── review-budget.cjs  # Review-only admission
│   │   ├── context-handoff.cjs # Record across /compact and /clear
│   │   └── owner-guard.cjs    # Question classes and requests to the user
│   └── settings.json          # Hook registration and permissions
├── skills/
│   ├── superpowers/           # Development process skills
│   └── project/               # Project workflow skills
├── lint/                      # Pre-built lint assets (placed, not wired)
├── documents/development/     # Shared policies and coding rules
├── CLAUDE.md                  # Main AI configuration
└── ...
```

## How Skills Work

Claude Code automatically discovers skills in `.claude/skills/`. Each skill has a `SKILL.md` with YAML frontmatter (name, description) that determines when it's invoked.

### Invoking Skills

Skills are invoked via the `Skill` tool:
```
/brainstorming    - Start design exploration
/writing-plans    - Create implementation plan
/quality-check    - Run pre-merge quality checks
```

## Customization

### Adding Project-Specific Rules

Create `.claude/rules/[category]/[name].md` with optional YAML frontmatter:

```markdown
---
title: My Custom Rule
description: Rule description
globs:
  - "src/**/*.ts"
---

# My Custom Rule

Content here...
```

### Modifying Settings

Edit `.claude/settings.json` to add custom hooks or permissions.

## Personal Setup (Global)

Run `npx @crearize/ai-dev-helm personal` to add safety rules to `~/.claude/settings.json`:
- Blocks destructive commands (rm -rf /, force push to main, etc.)
- Backs up existing settings before modification
