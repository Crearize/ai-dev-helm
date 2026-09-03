// changed-ranges.mjs - diff-scoped mutation ranges for Stryker (nextjs-react stack)
//
// Turns the hunks of a git diff against the base branch into Stryker `mutate`
// entries in Stryker's mutation-range syntax (`path:startLine-endLine`), so a
// diff-scoped run mutates only the LINES that changed instead of every file
// that changed. Consumed by stryker.diff.config.mjs.
//
// Why lines and not files: a one-line change in a large file would otherwise
// mutate the whole file, and the score would measure the legacy tests of that
// file rather than the change under review (quality-policy.md §2).
//
// Contracts this file keeps deliberately (all execution-verified against
// Stryker 9.6.1 / git 2.x):
// - The scope is derived from the WORKING TREE against the merge base of the
//   base ref (`git diff <merge-base>`), not from `base...HEAD`: Stryker
//   mutates the files on disk, so line numbers must match the disk state even
//   while the quality-check loop holds uncommitted edits. (A brand-new file
//   that was never staged is invisible to `git diff` and stays out of scope.)
// - File filtering reuses minimatch - the same matcher Stryker resolves
//   `mutate` globs with. minimatch is a direct dependency of
//   @stryker-mutator/core, but isolated installs (pnpm, Yarn PnP) do not
//   expose transitive dependencies, so the wiring adds it as an explicit
//   product devDependency (see the README). It is applied in order with
//   `dot: false` exactly like Stryker's project reader:
//   the LAST matching pattern wins, so a positive pattern can re-include what
//   an earlier negation excluded. The diff scope is therefore always a subset
//   of the full run's scope, even for product-tuned mutate arrays.
// - The git invocation is pinned against user-level git config: --no-ext-diff
//   (diff.external would replace the unified format entirely and silently
//   empty the scope), fixed --src-prefix/--dst-prefix (git >= 2.45 lets
//   config change them, breaking the `b/` strip), --inter-hunk-context=0
//   (config could merge hunks and pull unchanged lines into scope),
//   --no-textconv, and core.quotePath=false (non-ASCII paths arrive raw).
// - Paths containing glob-magic characters (Next.js dynamic routes: [id],
//   [...slug]) cannot carry a mutation range - Stryker rejects glob+range
//   combos and minimatch-globs the file part of a range - so those files fall
//   back to whole-file scope via a character-class-escaped glob ("[" becomes
//   "[[]"). Plain parenthesis segments ((group) route groups) are not glob
//   magic and keep their line ranges.
// - A path whose FIRST character is "!" cannot be expressed at all: Stryker
//   reads a mutate entry starting with "!" as a negation pattern, so both the
//   range form and the literal-glob form would silently drop the file from
//   the scope (fail-open). Such a path fails the run loudly instead. A "!"
//   deeper in the path is literal and keeps its range.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Minimatch } from 'minimatch';

// Remote-tracking refs first (the same order the quality-gate hook probes),
// then the local trunk for clones and worktrees that carry no remote-tracking
// ref at all. A stale local trunk only moves the merge base further back,
// which WIDENS the scope - it can never narrow it, so the fallback stays on
// the safe side of the gate.
export const DEFAULT_BASE_REFS = ['origin/main', 'origin/master', 'main', 'master'];

// git emits every added line of every changed file before our glob filter
// runs; Node's default 1 MiB maxBuffer would crash on lockfile-sized diffs.
const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_DIFF_BUFFER,
  });
}

// A revision reaching git argv must never be able to smuggle an option:
// MUTATION_BASE_REF='--output=/tmp/x' would silently redirect the diff and
// empty the scope. Failing loudly beats a neutralized gate.
function assertSafeRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-')) {
    throw new Error(
      `[mutation:diff] invalid base ref ${JSON.stringify(ref)} - a revision must not be empty or start with "-"`
    );
  }
  return ref;
}

function refExists(ref, cwd) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

// MUTATION_BASE_REF wins; otherwise probe DEFAULT_BASE_REFS in order.
export function resolveBaseRef({ cwd = process.cwd(), baseRef = process.env.MUTATION_BASE_REF } = {}) {
  if (baseRef) return assertSafeRef(baseRef);
  for (const candidate of DEFAULT_BASE_REFS) {
    if (refExists(candidate, cwd)) return candidate;
  }
  throw new Error(
    `[mutation:diff] no base ref found: none of ${DEFAULT_BASE_REFS.join(', ')} exists in this clone. ` +
      'Fetch the base branch (e.g. `git fetch origin main`) or set MUTATION_BASE_REF.'
  );
}

// git C-quotes paths containing quotes or control bytes even with
// core.quotePath=false. Decode the full escape set (\" \\ \t \n \r and octal
// \NNN) at byte level, so such a file is filtered under its real name instead
// of silently dropping out of the mutation scope.
export function unquoteGitPath(raw) {
  if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte);
      continue;
    }
    const next = inner[++i];
    if (next === 't') bytes.push(0x09);
    else if (next === 'n') bytes.push(0x0a);
    else if (next === 'r') bytes.push(0x0d);
    else if (next >= '0' && next <= '7') {
      bytes.push(Number.parseInt(inner.slice(i, i + 3), 8));
      i += 2;
    } else {
      for (const byte of Buffer.from(next, 'utf8')) bytes.push(byte);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Ordered minimatch over the mutate array, mirroring Stryker's project
// reader: start excluded, walk the patterns in order, a matching positive
// includes and a matching `!` negation excludes - the last matching pattern
// wins. `dot: false` like Stryker, so dot-directories never enter the scope.
export function compileMutateMatcher(mutate) {
  const patterns = mutate.map((raw) => {
    const negated = raw.startsWith('!');
    return { negated, matcher: new Minimatch(negated ? raw.slice(1) : raw, { dot: false }) };
  });
  return (file) => {
    let included = false;
    for (const { negated, matcher } of patterns) {
      if (matcher.match(file)) included = !negated;
    }
    return included;
  };
}

export function matchesMutateGlobs(file, mutate) {
  return compileMutateMatcher(mutate)(file);
}

// Characters that make Stryker treat a path as a glob pattern. `(` counts
// only when prefixed by an extglob marker (!@+*?) - a bare (group) segment is
// literal.
const GLOB_MAGIC_RE = /[*?{}[\]]|[!@+*?]\(/;

export function hasGlobMagic(file) {
  return GLOB_MAGIC_RE.test(file);
}

// Neutralize glob magic by wrapping each special character in a character
// class ("[" -> "[[]") - the one encoding minimatch matches literally.
export function toLiteralGlob(file) {
  return file.replace(/[*?{}[\]()]/g, (ch) => `[${ch}]`);
}

// Parses unified-diff text (as produced with -U0) into new-side line ranges:
// [{ file, start, end }]. Structure-aware on purpose: `diff --git ` can only
// open a section (inside hunks every line starts with '+', '-', ' ' or '\'),
// and the `+++ ` header is honored only inside that header zone - so an added
// content line beginning '++ ' (rendered '+++ x') can never hijack the
// current file. Deletion-only hunks and deleted files yield nothing - there
// is no new side to mutate.
export function parseUnifiedDiff(text) {
  const ranges = [];
  let file = null;
  let inHeader = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      const target = unquoteGitPath(line.slice(4).trim());
      file = target === '/dev/null' ? null : target.startsWith('b/') ? target.slice(2) : target;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      inHeader = false;
      if (file === null) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) continue;
      ranges.push({ file, start, end: start + count - 1 });
    }
  }
  return ranges;
}

// Changed lines of the working tree against the merge base of `baseRef`, as
// Stryker mutate entries, restricted to files inside the `mutate` globs.
// Paths are relative to `cwd` (`--relative`), which must be the directory
// Stryker runs from. A failed derivation throws with a fetch hint - loud, so
// quality-check records `scope_error` - and is never a silent empty scope.
export function changedLineRanges({ cwd = process.cwd(), baseRef, mutate = [] } = {}) {
  const ref = assertSafeRef(baseRef ?? resolveBaseRef({ cwd }));
  let mergeBase;
  try {
    mergeBase = git(['merge-base', ref, 'HEAD'], cwd).trim();
  } catch (err) {
    throw new Error(
      `[mutation:diff] cannot resolve the merge base of ${ref} and HEAD - is the base ref fetched? ` +
        `(git fetch origin main, or set MUTATION_BASE_REF)\n${err.message}`
    );
  }
  const diff = git(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '-U0',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--inter-hunk-context=0',
      '--relative',
      '--diff-filter=ACMRT',
      mergeBase,
    ],
    cwd
  );
  const inScope = compileMutateMatcher(mutate);
  const entries = [];
  const fileScoped = new Set();
  for (const range of parseUnifiedDiff(diff)) {
    if (!inScope(range.file)) continue;
    if (range.file.startsWith('!')) {
      throw new Error(
        `[mutation:diff] cannot scope ${JSON.stringify(range.file)}: a mutate entry starting with "!" is a ` +
          'negation pattern to Stryker and would silently drop the file from the scope (fail-open). ' +
          'Rename the file or exclude it from the mutate globs.'
      );
    }
    if (hasGlobMagic(range.file)) {
      // Range syntax is unavailable for glob-magic paths (see header):
      // degrade this one file to whole-file scope, once.
      if (!fileScoped.has(range.file)) {
        fileScoped.add(range.file);
        entries.push(toLiteralGlob(range.file));
      }
      continue;
    }
    entries.push(`${range.file}:${range.start}-${range.end}`);
  }
  return entries;
}

// Best-effort removal: a locked file must not turn a clean-up into a crash.
function rmBestEffort(absPath) {
  try {
    fs.rmSync(absPath, { force: true });
  } catch {
    // swallowed on purpose - see above
    return;
  }
}

// A stale json report from a previous run must not survive an empty-scope
// exit - quality-check would read yesterday's mutants as today's.
function removeStaleReport(baseConfig, cwd) {
  const fileName = baseConfig.jsonReporter?.fileName;
  if (!fileName) return;
  rmBestEffort(path.resolve(cwd, fileName));
}

// Returns `baseConfig` with `mutate` narrowed to the changed lines. On an
// empty scope the run must not reach Stryker (it would abort with "No tests
// were executed"): the stale report is removed, the empty scope is reported
// on stderr via fs.writeSync (synchronous - console.warn through a pipe could
// be truncated by process.exit) and the process exits 0; quality-check
// records `mutation.reason: "empty_scope"` for that case.
export function withChangedLines(baseConfig, { cwd = process.cwd(), baseRef } = {}) {
  if (!Array.isArray(baseConfig.mutate) || baseConfig.mutate.length === 0) {
    throw new Error(
      '[mutation:diff] the base config must define explicit `mutate` globs - ' +
        'a config relying on Stryker default mutate patterns cannot be diff-scoped'
    );
  }
  const ref = assertSafeRef(baseRef ?? resolveBaseRef({ cwd }));
  const mutate = changedLineRanges({ cwd, baseRef: ref, mutate: baseConfig.mutate });
  if (mutate.length === 0) {
    removeStaleReport(baseConfig, cwd);
    fs.writeSync(
      2,
      `[mutation:diff] empty scope: no changed lines inside the mutate set since ${ref} - nothing to mutate\n`
    );
    process.exit(0);
  }
  fs.writeSync(2, `[mutation:diff] base ${ref}: ${mutate.length} changed range(s) in scope\n`);
  return {
    ...baseConfig,
    mutate,
    // The incremental cache is full-run state. Reading it would merge stale
    // out-of-scope mutants into this run's report (the exact report
    // quality-check triages), and writing back would clobber the full-run
    // cache - so the diff run opts out entirely. The scope is small; fully
    // re-running it on each correction loop is cheap.
    incremental: false,
  };
}
