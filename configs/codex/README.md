# Codex Setup

## What Gets Installed

| Item | Location | Description |
|------|----------|-------------|
| Skills | `.codex/skills/` | Symlink to `skills/` (referenced from AGENTS.md) |
| Rules | `.codex/rules/` | Stack-specific coding rules |
| Project config | `.codex/config.toml` | Project-local approval/sandbox |
| Hooks | `.codex/hooks.json` | PreToolUse hook for quality-check enforcement |
| AGENTS.md | `AGENTS.md` (project root) | AI configuration file |

## Directory Structure After Setup

```
your-project/
├── .codex/
│   ├── skills -> ../skills    # Symlink to shared skills
│   ├── rules/                  # Stack rules
│   ├── config.toml             # Approval/sandbox
│   └── hooks.json              # PreToolUse hook
├── skills/
│   ├── superpowers/
│   └── project/
├── AGENTS.md                   # Main AI configuration
└── ...
```

## How AGENTS.md Works

Codex builds an instruction chain at startup:

1. Global: `~/.codex/AGENTS.md` (if present)
2. Project: walks from git root to cwd, concatenating each directory's `AGENTS.md`

Files are merged with closer paths overriding earlier ones (combined size limit: 32 KiB by default).

## How Hooks Work

`.codex/hooks.json` defines a `PreToolUse` hook that:

1. Runs before every Bash tool invocation
2. If the command starts with `git push`, checks for `.quality-check-passed`
3. If the flag is missing, blocks the push with a reason
4. If present, consumes the flag (one-time use)

Project-local hooks only load when Codex marks the project as trusted.

## Personal Setup (Global)

Run `npx @crearize/ai-dev-helm personal` and pick option `3) Codex global settings`:

- Merges `~/.codex/config.toml` with safe defaults:
  - `approval_policy = "on-request"`
  - `sandbox_mode = "read-only"`
  - `model = "gpt-5.6-sol"` (existing value preserved unless upgraded)
- Adds `[[rules]]` entries that deny destructive commands (rm -rf /, force push to main, etc.)
- Existing settings are preserved; a timestamped backup is created before any change.
- Use `--upgrade-model` to force-overwrite the `model` field with the template value.

## Customization

### Adding Project-Specific Rules

Create `.codex/rules/[name].md` for coding rules referenced from AGENTS.md.

### Modifying Hooks

Edit `.codex/hooks.json` to add custom PreToolUse / PostToolUse hooks. The schema mirrors Claude Code's hooks but Codex loads it from `hooks.json` (or inline `[hooks]` in `config.toml`).
