#!/usr/bin/env bash
# Usage: ./scripts/transform-skills.sh <superpowers_skills_dir> <output_dir>
# Copies and transforms superpowers skills for standalone use
# Used by GitHub Actions sync workflow. Harness policy is applied from
# scripts/skill-overlays (see apply-skill-overlays.js).

set -euo pipefail

SRC="$1"
DEST="$2"

# Skills to copy (directory names)
SKILLS=(
    brainstorming
    writing-plans
    executing-plans
    test-driven-development
    systematic-debugging
    dispatching-parallel-agents
    subagent-driven-development
    verification-before-completion
    finishing-a-development-branch
    requesting-code-review
    receiving-code-review
    using-git-worktrees
    using-superpowers
    writing-skills
)

# Files to exclude (patterns).
# Only exclude authoring noise that no skill document references.
# Do NOT exclude content files or directories (scripts/, references/,
# examples/, helper scripts): skill documents reference them by relative
# path, and excluding them ships skills with dangling references
# (see issue #63 — subagent-driven-development requires scripts/*).
EXCLUDE_PATTERNS=(
    "CREATION-LOG.md"
    "test-*.md"
)

# Validate the upstream before touching the destination.
#
# Upstream symlinks: npm does not ship them, so a copied link would be missing
# in adopters (and fail the 100755 check on main); following one could copy
# whatever it points at outside upstream. Stop and name it instead. On Windows
# a link checked out with core.symlinks=false (Git for Windows' default) is a
# plain file holding the target path, and MSYS copies links as files, so only
# git's index (mode 120000) still shows it there. Read upstream from a git work
# tree whenever there is one: refuse any link the index records and any file
# it does not track (so the index describes everything that is copied). A
# plain directory is accepted only off Windows, where find sees links.
if [ "$(git -C "$SRC" rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
    src_in_git=true
else
    src_in_git=false
    case "$(uname -s)" in
        MINGW* | MSYS* | CYGWIN*)
            echo "::error::On Windows, regenerate from a git clone of upstream: a symlink there is checked out as a plain file, and only git's index records it ($SRC is not in a git work tree)" >&2
            exit 1
            ;;
    esac
fi
# Build the paths by concatenation, not ${SKILLS[@]/#/$SRC/}: since bash 5.2
# (patsub_replacement) an & in the replacement, here in $SRC, is replaced by
# the match, so a path such as .../R&D/... would lose its &.
skill_dirs=()
for skill in "${SKILLS[@]}"; do
    if [ ! -d "$SRC/$skill" ]; then
        echo "::error::Required upstream skill not found: $skill" >&2
        exit 1
    fi
    skill_dirs+=("$SRC/$skill")
done
# One find and two git calls for all skills (each process start is slow on
# Windows).
links=$(find "${skill_dirs[@]}" -type l)
if [ "$src_in_git" = true ]; then
    untracked=$(git -C "$SRC" ls-files --others -- "${SKILLS[@]}")
    if [ -n "$untracked" ]; then
        echo "::error::Upstream file not tracked by git (regenerate from a clean clone of upstream): $untracked" >&2
        exit 1
    fi
    indexed=$(git -C "$SRC" ls-files -s -- "${SKILLS[@]}" | awk '$1 == "120000"' | cut -f2-)
    links=$(printf '%s\n' "$links" "$indexed" | sed '/^$/d')
fi
if [ -n "$links" ]; then
    echo "::error::Upstream symlink not supported (npm does not ship symlinks): $links" >&2
    exit 1
fi

# Check overlay drift before touching the destination: a drift failure must
# leave it exactly as it was.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/apply-skill-overlays.js" check "$SRC"

for skill in "${SKILLS[@]}"; do
    skill_src="$SRC/$skill"
    skill_dest="$DEST/$skill"

    if [ ! -d "$skill_src" ]; then
        echo "::error::Required upstream skill not found: $skill" >&2
        exit 1
    fi

    # Remove the previous copy so files deleted upstream don't linger
    rm -rf "$skill_dest"
    mkdir -p "$skill_dest"

    # Copy files, excluding patterns
    find "$skill_src" -maxdepth 1 -type f | while read -r file; do
        filename=$(basename "$file")
        skip=false

        for pattern in "${EXCLUDE_PATTERNS[@]}"; do
            # shellcheck disable=SC2053
            if [[ "$filename" == $pattern ]]; then
                skip=true
                break
            fi
        done

        if [ "$skip" = false ]; then
            cp "$file" "$skill_dest/"
        fi
    done

    # Copy all subdirectories (scripts/, references/, examples/) — skill
    # documents reference their contents by relative path (see issue #63)
    find "$skill_src" -mindepth 1 -maxdepth 1 -type d | while read -r dir; do
        cp -r "$dir" "$skill_dest/"
    done

    echo "  $skill"
done

# Upstream uses a flat skills/<name>/ layout; this repo nests skills under
# skills/superpowers/<name>/. Rewrite absolute-style upstream paths in the
# copied documents so cross-skill references resolve in consuming projects.
# `sed -i<suffix>` (suffix attached) is the in-place form that GNU and
# BSD/macOS sed both accept. The suffix is unique to this script so removing
# the backups never deletes an upstream file.
for skill in "${SKILLS[@]}"; do
    find "$DEST" -name '*.md' -print0 | xargs -0 sed -i.helm-sed-bak "s|skills/$skill/|skills/superpowers/$skill/|g"
done
find "$DEST" -name '*.helm-sed-bak' -type f -delete

# Upstream files nest code fences inside fenced prompt templates, which breaks
# rendering in some Markdown viewers. Widen the outer fences after copying.
find "$DEST" -name '*.md' -print0 | xargs -0 "$SCRIPT_DIR/fix-nested-fences.sh"

# Files the harness does not ship: executing-plans/scripts (task-start/task-done
# belong to upstream's native execution, which the harness replaces), the Muse
# tool mapping (an unsupported runtime), subagent-driven-development/references
# (upstream v7's five-round fix loop and final whole-branch review contradict
# the harness's review rounds, which its SKILL.md overlay defines) and
# brainstorming/builder-check-prompt.md (the harness keeps no prompt of its own
# for that check).
rm -rf "$DEST/executing-plans/scripts" "$DEST/using-superpowers/references/muse-tools.md" \
    "$DEST/subagent-driven-development/references" "$DEST/brainstorming/builder-check-prompt.md"

# Policy lives in harness-owned overlays (scripts/skill-overlays), not line
# patches: each overlay records the hash of the upstream file it was written
# against, so an upstream change fails loudly and names the file.
node "$SCRIPT_DIR/apply-skill-overlays.js" apply "$SRC" "$DEST"

# npm ships file modes. Keep every shipped file that starts with a shebang
# executable, so a script upstream adds as 644 (or whose mode it drops) still
# reaches adopters executable and the sync PR keeps the main build green.
find "$DEST" -type f -print0 | while IFS= read -r -d '' file; do
    if [ "$(head -c 2 "$file")" = '#!' ]; then chmod +x "$file"; fi
done

echo "Done. Transformed ${#SKILLS[@]} skills."
