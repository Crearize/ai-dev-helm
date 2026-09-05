# Contributing to ai-dev-helm

## Development Setup

```bash
# Clone the repository
git clone https://github.com/Crearize/ai-dev-helm.git
cd ai-dev-helm

# Install dependencies
npm install

# Run tests
npm test
```

## Development with Claude Code

This project uses the [superpowers](https://github.com/obra/superpowers) skill system. We recommend using **Claude Code** for development, which can leverage the skills defined in `skills/` for structured workflows:

- `/brainstorming` — Explore requirements and design before implementation
- `/writing-plans` — Create implementation plans before writing code
- `/quality-check` — Run quality checks before merging

### Editing files from Claude Code on Windows

- Git Bash on Windows fails on long heredocs (`cat <<'EOF' ...`) that mix multi-byte text and quotes (`unexpected EOF while looking for matching quote`), and the failure discards the whole command. Write edit scripts, fixtures and long Japanese text with the Write tool (or an editor) first, then run them from Bash.
- Short ASCII replacements via `sed` or an inline `python -c` are fine; anything longer, or containing Japanese, goes through a script file.
- Test fixtures that contain `node_modules` junctions must be staged with explicit paths, not `git add .`, or the junction target gets walked.

## Pull Request Process

1. **Do not push directly to `main`** — Always create a feature branch
2. **Branch naming**: `[type]/[description]-[issue-number]` (e.g., `feat/add-python-stack-42`)
3. **Create a Pull Request** — PRs require at least **1 reviewer approval** before merging
4. **Stale reviews are automatically dismissed** — If you push new commits after receiving approval, the review resets

## Versioning Policy

This project follows [Semantic Versioning](https://semver.org/):

| Version | When |
|---------|------|
| **patch** (1.0.x) | Bug fixes, hotfixes, documentation corrections |
| **minor** (1.x.0) | New features, new tech stacks, new skills |
| **major** (x.0.0) | Breaking changes, major restructuring |

## Adding a Tech Stack

See the [README](README.md#技術スタックの追加) for instructions on adding new tech stacks.

## Reporting Issues

- **Bugs**: Open a [GitHub Issue](https://github.com/Crearize/ai-dev-helm/issues)
- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md)
