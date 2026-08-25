// changed-ranges.mjs - diff-scoped mutation ranges for Stryker (nextjs-react stack)
//
// Turns the hunks of `git diff -U0 <base>...HEAD` into Stryker `mutate`
// entries in Stryker's mutation-range syntax (`path:startLine-endLine`), so a
// diff-scoped run mutates only the LINES that changed instead of every file
// that changed. Consumed by stryker.diff.config.mjs; plain Node, no deps.
//
// Why lines and not files: a one-line change in a large file would otherwise
// mutate the whole file, and the score would measure the legacy tests of that
// file rather than the change under review (quality-policy.md §2).

import { execFileSync } from 'node:child_process';

export const DEFAULT_BASE_REF = 'origin/main';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Minimal glob -> RegExp covering what the shipped `mutate` patterns use:
// `**/` (zero or more directories), a trailing `**`, `*` (within a path
// segment), `?`, and `{a,b}` alternation. Matched against forward-slash paths
// relative to the Stryker working directory.
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        re += '\\{';
        i += 1;
      } else {
        const alternatives = glob.slice(i + 1, close).split(',').map(escapeRegExp);
        re += `(?:${alternatives.join('|')})`;
        i = close + 1;
      }
    } else {
      re += escapeRegExp(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

// Does `file` belong to the mutate set described by `mutate` globs? Positive
// patterns must match at least one (when any exist); negated `!` patterns
// must match none. This mirrors how Stryker applies the same array, so the
// diff scope never reaches a file the full run would not mutate.
export function matchesMutateGlobs(file, mutate) {
  const positives = [];
  const negatives = [];
  for (const pattern of mutate) {
    if (pattern.startsWith('!')) negatives.push(globToRegExp(pattern.slice(1)));
    else positives.push(globToRegExp(pattern));
  }
  if (positives.length > 0 && !positives.some((re) => re.test(file))) return false;
  return !negatives.some((re) => re.test(file));
}

// git quotes paths containing `"` or control characters as C-style strings.
// core.quotePath is turned off in changedLineRanges so non-ASCII paths arrive
// raw; only the escape forms that can still appear are handled here.
function unquoteGitPath(raw) {
  if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
  return raw.slice(1, -1).replace(/\\(["\\tn])/g, (_, ch) => {
    if (ch === 't') return '\t';
    if (ch === 'n') return '\n';
    return ch;
  });
}

// Parses unified-diff text (as produced with -U0) into new-side line ranges:
// [{ file, start, end }]. Deletion-only hunks (no new-side lines) and deleted
// files are skipped - there is nothing left to mutate there.
export function parseUnifiedDiff(text) {
  const ranges = [];
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        file = null;
        continue;
      }
      const unquoted = unquoteGitPath(target);
      file = unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
      continue;
    }
    if (file === null) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    ranges.push({ file, start, end: start + count - 1 });
  }
  return ranges;
}

// Lines added or changed since `baseRef` (merge-base semantics, `base...HEAD`)
// as Stryker mutate entries, restricted to files inside the `mutate` globs.
// Paths are relative to `cwd` (`--relative`), which must be the directory
// Stryker runs from, so the ranges resolve exactly like the full-run globs.
export function changedLineRanges({
  cwd = process.cwd(),
  baseRef = DEFAULT_BASE_REF,
  mutate = [],
} = {}) {
  const diff = execFileSync(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '-U0',
      '--no-color',
      '--relative',
      '--diff-filter=AMR',
      `${baseRef}...HEAD`,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return parseUnifiedDiff(diff)
    .filter((range) => matchesMutateGlobs(range.file, mutate))
    .map((range) => `${range.file}:${range.start}-${range.end}`);
}

function exitOnEmptyScope(baseRef) {
  console.warn(
    `[mutation:diff] empty scope: no changed lines inside the mutate set since ${baseRef} - nothing to mutate`
  );
  process.exit(0);
}

// Returns `baseConfig` with `mutate` narrowed to the changed lines. When the
// scope is empty the run must not reach Stryker (it would warn "No files found
// for mutation" and abort with "No tests were executed"); by default the
// process reports the empty scope and exits 0, and quality-check records
// `mutation.reason: "empty_scope"`. `onEmpty` exists so tests and product
// wrappers can substitute their own handling.
export function withChangedLines(
  baseConfig,
  {
    cwd = process.cwd(),
    baseRef = process.env.MUTATION_BASE_REF || DEFAULT_BASE_REF,
    onEmpty = exitOnEmptyScope,
  } = {}
) {
  const mutate = changedLineRanges({ cwd, baseRef, mutate: baseConfig.mutate || [] });
  if (mutate.length === 0) return onEmpty(baseRef);
  console.info(`[mutation:diff] base ${baseRef}: ${mutate.length} changed range(s) in scope`);
  return { ...baseConfig, mutate };
}
