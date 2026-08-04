# Claude Code Setup

## What Gets Installed

| Item | Location | Description |
|------|----------|-------------|
| Skills | `.claude/skills/` | Symlink to `skills/` (superpowers + project skills) |
| Rules | `.claude/rules/` | Stack-specific coding rules |
| Settings | `.claude/settings.json` | Quality check hooks, permission rules |
| CLAUDE.md | `CLAUDE.md` (project root) | AI configuration file |

## Directory Structure After Setup

```
your-project/
├── .claude/
│   ├── skills -> ../skills    # Symlink to shared skills
│   ├── rules/
│   │   ├── frontend/          # Frontend rules (from stack)
│   │   └── backend/           # Backend rules (from stack)
│   └── settings.json          # Hooks and permissions
├── skills/
│   ├── superpowers/           # Development process skills
│   └── project/               # Project workflow skills
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
/quality-check    - Run pre-push quality checks
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
