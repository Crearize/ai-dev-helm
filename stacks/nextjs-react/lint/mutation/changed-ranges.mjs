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
// - Incremental is OFF by default and never shares the full run's cache.
//   MUTATION_INCREMENTAL=1 opts in for re-measurement with a diff-only cache
//   (DIFF_INCREMENTAL_FILE). Stryker keeps every mutant of a cache in the
//   report - even one whose line is no longer inside `mutate` - so the cache
//   is read only while the current scope still covers every line the cached
//   run scoped, against the same merge base (recorded in DIFF_SCOPE_FILE);
//   otherwise it is discarded first. The sidecar is developer-editable and
//   gitignored, so anything this file would not have written itself counts
//   as "no provenance" and discards the cache too.
//
// API boundary: `withChangedLines` (the config wrapper - a PRE-RUN HOOK with
// side effects: it may delete the stale report and the diff cache, writes
// the scope sidecar, and exits the process on an empty scope),
// `deriveScope` / `changedLineRanges` (pure scope derivation - use these to
// inspect the scope without side effects), `resolveBaseRef` and the exported
// constants are the supported surface. Every other export exists for the
// harness's own tests and may change without notice.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Minimatch } from 'minimatch';

// Remote-tracking refs first (the two the quality-gate hook also probes for
// its harness-only exemption), then the local trunk for clones and worktrees
// that carry no remote-tracking ref at all. A stale local trunk only moves
// the merge base further back, which WIDENS the scope and never narrows it -
// with one exception: a local trunk that is the checked-out commit itself
// (or ahead of it) has HEAD as its merge base, and every committed change
// would silently drop out of the scope. resolveBaseRef skips such a candidate
// and fails loudly instead (scope_error, never a quiet empty scope).
export const REMOTE_BASE_REFS = ['origin/main', 'origin/master'];
export const LOCAL_BASE_REFS = ['main', 'master'];
export const DEFAULT_BASE_REFS = [...REMOTE_BASE_REFS, ...LOCAL_BASE_REFS];

// The diff run's own incremental cache and the sidecar recording the scope
// (base ref, merge base, mutate entries) that produced it. Both sit next to
// the full run's cache under reports/mutation/ (gitignored by `init`).
export const DIFF_INCREMENTAL_FILE = 'reports/mutation/stryker-incremental.diff.json';
export const DIFF_SCOPE_FILE = 'reports/mutation/stryker-incremental.diff.scope.json';

// MUTATION_INCREMENTAL: only "1" and "true" opt in. Anything else (unset,
// "", "0", "false") keeps incremental off - the safe default.
export function incrementalRequested(value) {
  return value === '1' || value === 'true';
}

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

// The commit a ref resolves to, or null when it does not exist.
function revParse(ref, cwd) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).trim();
  } catch {
    return null;
  }
}

function mergeBaseOf(ref, cwd) {
  try {
    return git(['merge-base', ref, 'HEAD'], cwd).trim();
  } catch {
    return null;
  }
}

// MUTATION_BASE_REF wins; otherwise probe REMOTE_BASE_REFS, then the local
// trunks whose merge base with HEAD is not HEAD itself (see the constants).
export function resolveBaseRef({ cwd = process.cwd(), baseRef = process.env.MUTATION_BASE_REF } = {}) {
  if (baseRef) return assertSafeRef(baseRef);
  for (const candidate of REMOTE_BASE_REFS) {
    if (revParse(candidate, cwd) !== null) return candidate;
  }
  const head = revParse('HEAD', cwd);
  const rejected = [];
  for (const candidate of LOCAL_BASE_REFS) {
    if (revParse(candidate, cwd) === null) continue;
    if (head !== null && mergeBaseOf(candidate, cwd) === head) {
      rejected.push(candidate);
      continue;
    }
    return candidate;
  }
  const why =
    rejected.length > 0
      ? `is usable in this clone (local ${rejected.join(' / ')} is the checked-out commit or ahead of it - ` +
        'its merge base would be HEAD and every committed change would fall out of the scope). '
      : 'exists in this clone. ';
  throw new Error(
    `[mutation:diff] no base ref found: none of ${DEFAULT_BASE_REFS.join(', ')} ${why}` +
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
export function changedLineRanges(options) {
  return deriveScope(options).entries;
}

// The scope with its provenance: `{ baseRef, mergeBase, entries }`. The merge
// base is what the incremental sidecar pins - a rebased branch or a moved
// base ref changes the lines under every entry.
export function deriveScope({ cwd = process.cwd(), baseRef, mutate = [] } = {}) {
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
  return { baseRef: ref, mergeBase, entries };
}

const RANGE_ENTRY_RE = /^(.+):(\d+)-(\d+)$/;

// Mutate entries -> Map<file, [start, end][] | null>, null meaning the whole
// file (a glob-magic path). The range is split off at the LAST ":" and must
// be `start-end`; anything else is a whole-file entry. A whole-file entry
// absorbs any range entries of the same file. Ranges stay intervals - never
// expanded line by line, a sidecar is developer-editable input.
function parseScope(entries) {
  const files = new Map();
  for (const entry of entries) {
    const match = RANGE_ENTRY_RE.exec(entry);
    if (!match) {
      files.set(entry, null);
      continue;
    }
    const [, file, start, end] = match;
    const ranges = files.get(file);
    if (ranges === null) continue;
    const list = ranges ?? [];
    list.push([Number(start), Number(end)]);
    files.set(file, list);
  }
  return files;
}

// Every line of [start, end] lies inside the union of `ranges` (a sweep over
// the ranges sorted by start; reversed ranges cover nothing).
function rangesCover(ranges, [start, end]) {
  let line = start;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s > e || e < line) continue;
    if (s > line) return false;
    line = e + 1;
    if (line > end) return true;
  }
  return line > end;
}

// True when every line the `previous` scope covered is still inside
// `current`: per file, a whole-file entry covers everything, a set of ranges
// covers only its lines and never a whole-file entry; a reversed range
// (start > end) is malformed and is never covered. This is the reuse guard
// for the diff cache. It compares line NUMBERS; Stryker itself relocates
// cached mutants by matching source content, so a heavily edited file can in
// theory carry a cached mutant to a line outside the numeric scope - a
// residual, documented limitation, not a proof of containment.
export function scopeCovers(current, previous) {
  const cur = parseScope(current);
  for (const [file, ranges] of parseScope(previous)) {
    if (!cur.has(file)) return false;
    const curRanges = cur.get(file);
    if (ranges === null && curRanges === null) continue;
    if (ranges === null || curRanges === null) {
      if (curRanges === null) continue;
      return false;
    }
    for (const range of ranges) {
      if (range[0] > range[1]) return false;
      if (!rangesCover(curRanges, range)) return false;
    }
  }
  return true;
}

// Best-effort removal that REPORTS its outcome: a locked file must not turn
// a clean-up into a crash, but the caller has to know the file is still
// there (an empty-scope exit with a stale report left behind would be read
// as a genuine result). Recursive, so a directory squatting on the path goes
// too; a symlink is removed as the link, never followed.
function rmBestEffort(absPath) {
  try {
    fs.rmSync(absPath, { force: true, recursive: true });
    return true;
  } catch (err) {
    fs.writeSync(2, `[mutation:diff] warning: could not remove ${absPath}: ${err.message}\n`);
    return false;
  }
}

// A stale json report from a previous run must not survive an empty-scope
// exit - quality-check would read yesterday's mutants as today's.
function removeStaleReport(baseConfig, cwd) {
  const fileName = baseConfig.jsonReporter?.fileName;
  if (!fileName) return true;
  return rmBestEffort(path.resolve(cwd, fileName));
}

function resetDiffCache(cwd) {
  const cacheGone = rmBestEffort(path.resolve(cwd, DIFF_INCREMENTAL_FILE));
  const sidecarGone = rmBestEffort(path.resolve(cwd, DIFF_SCOPE_FILE));
  return cacheGone && sidecarGone;
}

// Sidecar format. Bump the version whenever the meaning of a field changes:
// a sidecar of another version has no usable provenance and discards the
// cache (fail-closed), instead of being trusted by accident.
const SIDECAR_VERSION = 1;
const MERGE_BASE_RE = /^[0-9a-f]{7,64}$/;
// Wider than any real file; only a hand-edited sidecar reaches this.
const MAX_RANGE_LINES = 1_000_000;

function isScopeEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return false;
  const match = RANGE_ENTRY_RE.exec(entry);
  if (!match) return true;
  const start = Number(match[2]);
  const end = Number(match[3]);
  return start >= 1 && end >= start && end - start < MAX_RANGE_LINES;
}

// The sidecar is gitignored and developer-editable, so it is validated like
// untrusted input: version, a hex merge base, and a NON-EMPTY list of
// well-formed entries. An empty `mutate` can never come from this file (an
// empty scope exits before the sidecar is written) and would make
// scopeCovers vacuously true - the one shape that lets any stale cache
// through - so it discards the cache like any other corruption.
function readScopeSidecar(absPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.version !== SIDECAR_VERSION) return null;
    if (typeof parsed.mergeBase !== 'string' || !MERGE_BASE_RE.test(parsed.mergeBase)) return null;
    if (!Array.isArray(parsed.mutate) || parsed.mutate.length === 0) return null;
    if (!parsed.mutate.every(isScopeEntry)) return null;
    return parsed;
  } catch {
    // missing or unreadable sidecar: the cache has no known provenance
    return null;
  }
}

// Stryker rethrows anything but ENOENT when it reads the cache, so a cache
// left truncated by an interrupted run would wedge every later run on the
// same SyntaxError if it were reported as reusable. Unreadable = absent.
function cacheIsReadable(absPath) {
  try {
    JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

// Decides whether this run may READ the diff cache, and records the current
// scope for the next run. Reuse needs a readable cache plus a valid sidecar
// naming the same merge base whose scope the current one still covers (see
// scopeCovers); anything else - no or invalid sidecar, another merge base, a
// shrunk or moved scope, an unreadable cache - discards the cache first,
// because Stryker would keep the stale mutants in the report quality-check
// triages. The decision is reported on stderr with the same synchronous
// write as the scope line.
//
// Ordering invariant (why the sidecar is written BEFORE Stryker runs): on
// disk, cache contents ⊆ the scope the sidecar records. A discard empties
// the cache before the sidecar is written, and a reuse only advances the
// sidecar to a scope that covers the recorded one. An interrupted run can
// therefore leave the sidecar AHEAD of the cache but never behind it, and
// the next decision errs on the discarding side. Keep it that way.
function prepareDiffIncremental(cwd, scope) {
  const cachePath = path.resolve(cwd, DIFF_INCREMENTAL_FILE);
  const sidecarPath = path.resolve(cwd, DIFF_SCOPE_FILE);
  const previous = cacheIsReadable(cachePath) ? readScopeSidecar(sidecarPath) : null;
  const reusable =
    previous !== null &&
    previous.mergeBase === scope.mergeBase &&
    scopeCovers(scope.entries, previous.mutate);
  if (reusable) {
    fs.writeSync(
      2,
      `[mutation:diff] incremental: reusing the diff cache (${DIFF_INCREMENTAL_FILE}) - the scope still covers the previous run\n`
    );
  } else {
    resetDiffCache(cwd);
    fs.writeSync(2, `[mutation:diff] incremental: starting the diff cache (${DIFF_INCREMENTAL_FILE})\n`);
  }
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  // Replace, never write through: a symlink in the sidecar's place must not
  // redirect the write.
  rmBestEffort(sidecarPath);
  fs.writeFileSync(
    sidecarPath,
    `${JSON.stringify(
      // baseRef is informational (diagnostics); only mergeBase and mutate
      // take part in the reuse decision.
      { version: SIDECAR_VERSION, baseRef: scope.baseRef, mergeBase: scope.mergeBase, mutate: scope.entries },
      null,
      2
    )}\n`
  );
}

// Returns `baseConfig` with `mutate` narrowed to the changed lines. On an
// empty scope the run must not reach Stryker (it would abort with "No tests
// were executed"): the stale report and the diff cache are removed, the
// empty scope is reported on stderr via fs.writeSync (synchronous -
// console.warn through a pipe could be truncated by process.exit) and the
// process exits 0; quality-check records `mutation.reason: "empty_scope"`
// for that case. If a stale report or cache could NOT be removed the run
// exits 1 instead - a leftover report would be read as this run's result,
// and quality-check records that as `scope_error`.
//
// `incremental` (default: MUTATION_INCREMENTAL, see incrementalRequested;
// only the boolean `true` opts in when passed explicitly) enables the
// diff-only cache; `incrementalFile` always names that cache so the full
// run's cache is never read or written from here - a product's own
// `incrementalFile` is deliberately ignored for the diff run.
//
// `cwd` must be the directory Stryker runs from: the ranges are relative to
// it and the cache paths are resolved against it here, but against Stryker's
// own cwd by Stryker.
export function withChangedLines(
  baseConfig,
  { cwd = process.cwd(), baseRef, incremental = incrementalRequested(process.env.MUTATION_INCREMENTAL) } = {}
) {
  if (!Array.isArray(baseConfig.mutate) || baseConfig.mutate.length === 0) {
    throw new Error(
      '[mutation:diff] the base config must define explicit `mutate` globs - ' +
        'a config relying on Stryker default mutate patterns cannot be diff-scoped'
    );
  }
  const ref = assertSafeRef(baseRef ?? resolveBaseRef({ cwd }));
  const scope = deriveScope({ cwd, baseRef: ref, mutate: baseConfig.mutate });
  if (scope.entries.length === 0) {
    const reportGone = removeStaleReport(baseConfig, cwd);
    const cacheGone = resetDiffCache(cwd);
    if (!(reportGone && cacheGone)) {
      fs.writeSync(
        2,
        `[mutation:diff] empty scope since ${ref}, but a previous report or diff cache could not be removed - ` +
          'refusing to finish as an empty scope (the leftover would be read as this run\'s result). ' +
          'Remove it (reports/mutation/) and re-run.\n'
      );
      process.exit(1);
    }
    fs.writeSync(
      2,
      `[mutation:diff] empty scope: no changed lines inside the mutate set since ${ref} - nothing to mutate\n`
    );
    process.exit(0);
  }
  fs.writeSync(2, `[mutation:diff] base ${ref}: ${scope.entries.length} changed range(s) in scope\n`);
  const useCache = incremental === true;
  if (useCache) prepareDiffIncremental(cwd, scope);
  return {
    ...baseConfig,
    mutate: scope.entries,
    incremental: useCache,
    incrementalFile: DIFF_INCREMENTAL_FILE,
  };
}
