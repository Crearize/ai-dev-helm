# Codex Setup

## What Gets Installed

| Item | Location | Description |
|------|----------|-------------|
| Skills | `.codex/skills/` | Symlink to `skills/` (referenced from AGENTS.md) |
| Rules | `.codex/rules/` | Stack-specific coding rules |
| Project config | `.codex/config.toml` | Project-local approval/sandbox |
| Hook | `.codex/hooks/quality-gate.cjs` | Merge-gate hook (Node, cross-platform); always overwritten by init |
| Hook registration | `.codex/hooks.json` | PreToolUse registration for quality-check enforcement |
| AGENTS.md | `AGENTS.md` (project root) | AI configuration file |

## Directory Structure After Setup

```
your-project/
├── .codex/
│   ├── skills -> ../skills    # Symlink to shared skills
│   ├── rules/                  # Stack rules
│   ├── config.toml             # Approval/sandbox
│   ├── hooks/
│   │   └── quality-gate.cjs    # Merge-gate hook body
│   └── hooks.json              # PreToolUse hook registration
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

`.codex/hooks.json` registers events under a top-level `hooks` key (Codex's schema, not a bare event key at the top level — see [#112](https://github.com/Crearize/ai-dev-helm/issues/112)):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": "node .codex/hooks/quality-gate.cjs", "timeout": 30 }
        ]
      }
    ]
  }
}
```

The registered `PreToolUse` hook:

1. Runs before every Bash tool invocation
2. If the command is `gh pr merge`, `git merge` / `git pull` / `git rebase` on main/master, or a push targeting main/master, validates `.quality-check-passed` (commit-bound JSON written by the quality-check skill) (the three sync forms on the current trunk - `git pull`, `git pull origin <trunk>`, `git merge origin/<trunk>` with no other options, using the trunk's own name, e.g. `master` on a `master` checkout - are the only exemption)
3. Blocks with a reason if the flag is missing, invalid, or non-harness code changed after the recorded commit. Unconditional blocks (no exemption) include force/delete pushes and a closed set of other git operations sharing the line: HEAD-movers (`commit`/`reset`/`checkout`/`switch`/`cherry-pick`/`rebase`/`revert`/`am`/`bisect`/`update-ref`/`stash pop`/`stash apply`) are checked across the whole command, `fetch` and `branch -f`/`-d`/`-D`/`--force` are checked on the same line only, and any other git operation (`status`, `add`, `log`, etc.) does not block. Also unconditional: `-C` / `--git-dir` / `cd`, shell expansion in refs, multiple gated operations. Trunk names are fixed to `main` / `master`. The complete, authoritative list lives in the `quality-check` skill's `SKILL.md` (`hook の完全な契約`) — this is a summary, not the source.
4. The flag is not consumed; harness-only follow-up commits keep it valid — except commits touching gate control-plane files (the quality-check skill and its schemas, review guides, the hook body and its registration files including `.codex/config.toml` and `mcp.json`, and the settings `hooks` / `permissions.deny` keys), which invalidate the flag and block with `Gate control-plane changed:`. Pushes to feature branches are never gated, and harness-only diffs skip the gate entirely (same control-plane carve-out applies)

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
