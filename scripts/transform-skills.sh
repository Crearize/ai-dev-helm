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
for skill in "${SKILLS[@]}"; do
    if [ ! -d "$SRC/$skill" ]; then
        echo "::error::Required upstream skill not found: $skill" >&2
        exit 1
    fi
done

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
# belong to upstream's native execution, which the harness replaces) and the
# Muse tool mapping (an unsupported runtime).
rm -rf "$DEST/executing-plans/scripts" "$DEST/using-superpowers/references/muse-tools.md"

# Policy lives in harness-owned overlays (scripts/skill-overlays), not line
# patches: each overlay records the hash of the upstream file it was written
# against, so an upstream change fails loudly and names the file.
node "$SCRIPT_DIR/apply-skill-overlays.js" apply "$SRC" "$DEST"

echo "Done. Transformed ${#SKILLS[@]} skills."
