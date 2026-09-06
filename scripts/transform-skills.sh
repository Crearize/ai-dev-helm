#!/usr/bin/env bash
# Usage: ./scripts/transform-skills.sh <superpowers_skills_dir> <output_dir>
# Copies and transforms superpowers skills for standalone use
# Used by GitHub Actions sync workflow

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
for skill in "${SKILLS[@]}"; do
    find "$DEST" -name '*.md' -print0 | xargs -0 sed -i "s|skills/$skill/|skills/superpowers/$skill/|g"
done

# Upstream files nest code fences inside fenced prompt templates, which breaks
# rendering in some Markdown viewers. Widen the outer fences after copying.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
find "$DEST" -name '*.md' -print0 | xargs -0 "$SCRIPT_DIR/fix-nested-fences.sh"

# Policy lives in the loaded skill bodies, not a competing instruction layer.
# Zero fuzz prevents silently retaining changed upstream instructions. Check
# each patch before applying it and identify the failed patch in CI output.
PATCH_DIR="$SCRIPT_DIR/skill-patches"
shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
if [ "${#PATCHES[@]}" -eq 0 ]; then
    echo "::error::No harness policy patches found in $PATCH_DIR" >&2
    exit 1
fi
for policy_patch in "${PATCHES[@]}"; do
    patch_name="$(basename "$policy_patch")"
    if ! patch --dry-run --batch --forward --fuzz=0 -p1 -d "$DEST" < "$policy_patch"; then
        echo "::error::Harness skill patch failed: $patch_name. Reconcile upstream changes before syncing." >&2
        exit 1
    fi
    patch --batch --forward --fuzz=0 -p1 -d "$DEST" < "$policy_patch"
    echo "  Applied policy patch: $patch_name"
done

echo "Done. Transformed ${#SKILLS[@]} skills."
