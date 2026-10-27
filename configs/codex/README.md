# Codex Setup

## What Gets Installed

| Item | Location | Description |
|------|----------|-------------|
| Skills | `.codex/skills/` | Symlink to `skills/` (referenced from AGENTS.md) |
| Rules | `.codex/rules/` | Stack-specific coding rules and managed command-prefix safety rules |
| Role agents | `.codex/agents/` | Named design, implementation, exploration, and review agents |
| Project config | `.codex/config.toml` | Project-local subagent defaults; user permission settings are preserved |
| Hook | `.codex/hooks/quality-gate.cjs` | Merge-gate hook (Node, cross-platform); always overwritten by init |
| Hook | `.codex/hooks/review-budget.cjs` | Review-round budget (reserves a round before reviewers start) |
| Hook | `.codex/hooks/context-handoff.cjs` | Saves the conversation record before `/compact` and `/clear` and puts its key points back (3.7.1; see `harness-runtime.md`) |
| Hook registration | `.codex/hooks.json` | PreToolUse (quality-gate, review-budget), PostToolUse (review-budget), and PreCompact / SessionStart (`compact|clear`) / Stop (context-handoff), each appended at the end of its event's array |
| AGENTS.md | `AGENTS.md` (project root) | AI configuration file |

## Directory Structure After Setup

```
your-project/
├── .codex/
│   ├── skills -> ../skills    # Symlink to shared skills
│   ├── rules/                  # Stack rules
│   ├── agents/                 # Model-routed named roles
│   ├── config.toml             # Subagent defaults
│   ├── hooks/
│   │   ├── quality-gate.cjs    # Merge-gate hook body
│   │   ├── review-budget.cjs   # Review-round budget
│   │   └── context-handoff.cjs # Conversation record across /compact and /clear
│   └── hooks.json              # Hook registrations
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

**Threat model**: the hook only stops accidental, good-faith pushes/merges into main — development always starts from an Issue + branch, and a push/merge that lands on main can still be reverted, so the hook is a safety-net block, not a security boundary. Deliberate evasion (shell expansion/quoting/encoding tricks that hide a word, wrapper scripts, indirect execution) is out of scope by design and only enumerated in the hook's own header.

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

The registered `PreToolUse` hook runs before every Bash tool invocation and refuses a direct push/merge into main (or master) without a valid `.quality-check-passed` flag (commit-bound JSON written by the quality-check skill); feature-branch pushes are not gated, and harness-only diffs skip the gate. What it gates, the unconditional blocks, what passes, the gate control plane and the fail-open scope are defined once in the `quality-check` skill ("hook の完全な契約" in `references/hook-contract.md`, "ハーネスのみ変更の免除" in `references/harness-exemption.md`) - this README does not restate them.

Project-local hooks only load when Codex marks the project as trusted, and each hook runs only after it is trusted in `/hooks` (new or changed hooks are skipped until then; `codex-trust` checks this).

## Personal Setup (Global)

Run `npx @crearize/ai-dev-helm personal` and pick option `3) Codex global settings`:

- Merges `~/.codex/config.toml` with safe defaults:
  - `approval_policy = "on-request"`
  - `sandbox_mode = "read-only"`
  - `model = "gpt-6.1-sol"` (existing value preserved unless upgraded)
- Installs managed safety rules in `.codex/rules/ai-dev-helm-safety.rules` using Codex's supported `prefix_rule(... decision = "forbidden")` format. Direct-prefix coverage includes common recursive `rm` forms targeting `/`, literal `~`, or `.`, `git reset --hard`, forced `git clean`, conventional force pushes to `origin` main/master, `docker system prune`, and package publishing. This is not equivalent to the old regex policy: expanded home paths, other remotes/refspecs, unlisted flag spellings/orderings, shell indirection and alternate tools require additional user rules. Inspect the installed rules before relying on their coverage.
- Installs six project-local role agents with explicit routing: designer, doc-reviewer and visual-producer (visual/editorial production) use GPT-6.1 Sol/high, implementer uses GPT-6.1 Sol/medium, explorer uses GPT-6.1 Sol/low, and the final quality reviewer (including design review of produced visuals) uses GPT-6 Astra/high. GPT-6 Luna is not used. Role files left unmodified from an earlier release, and the former default subagent model `gpt-5.6-terra`, are upgraded; customized model and permission choices remain unchanged.
- The former TOML `[[rules]]` schema is unsupported by current Codex. Exact legacy ai-dev-helm rules can be migrated to the supported mechanism; unknown user rules are retained with a warning for manual migration.
- Existing settings are preserved; updates create timestamped backups before writing.
- Use `--upgrade-model` to force-overwrite the `model` field with the template value.

## Customization

### Adding Project-Specific Rules

Create `.codex/rules/[name].md` for coding rules referenced from AGENTS.md.

### Modifying Hooks

Edit `.codex/hooks.json` to add custom PreToolUse / PostToolUse hooks. The schema mirrors Claude Code's hooks but Codex loads it from `hooks.json` (or inline `[hooks]` in `config.toml`).
