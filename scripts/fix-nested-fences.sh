#!/usr/bin/env bash
# Usage: ./scripts/fix-nested-fences.sh <file.md> [<file.md>...]
# Widens outer code fences when the fenced block contains nested fence lines
# with the same or more backticks (e.g. ``` blocks nested inside a ``` block).
# Indented nested fences are valid CommonMark, but many Markdown renderers
# still break on them. Idempotent: already-wide-enough fences are untouched.
# Called by transform-skills.sh so the fix survives upstream syncs.

set -euo pipefail

fix_file() {
    local file="$1"
    local tmp="${file}.tmp"

    awk '
        function fencerun(line,    m) {
            m = line
            sub(/^ {0,3}/, "", m)
            if (match(m, /^`+/) == 0) return 0
            return RLENGTH
        }
        # Pass 1: find outer fence pairs whose body nests fences of equal or
        # greater width, and record the width the outer fence needs
        NR == FNR {
            n = fencerun($0)
            if (!infence) {
                if (n >= 3) { infence = 1; fencelen = n; start = FNR; maxnested = 0 }
            } else {
                m = $0
                sub(/^ {0,3}/, "", m)
                if (n >= fencelen && m ~ /^`+[ \t]*$/) {
                    infence = 0
                    if (maxnested >= fencelen) {
                        marks[start] = maxnested + 1
                        marks[FNR] = maxnested + 1
                    }
                } else if (match($0, /```+/)) {
                    if (RLENGTH > maxnested) maxnested = RLENGTH
                }
            }
            next
        }
        # Pass 2: widen marked fences to the recorded width
        FNR in marks {
            fence = ""
            for (i = 0; i < marks[FNR]; i++) fence = fence "`"
            sub(/`+/, fence)
            print
            next
        }
        { print }
    ' "$file" "$file" > "$tmp"

    if cmp -s "$file" "$tmp"; then
        rm -f "$tmp"
    else
        mv "$tmp" "$file"
        echo "  fixed: $file"
    fi
}

for f in "$@"; do
    fix_file "$f"
done
