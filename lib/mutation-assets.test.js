const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync, spawn, spawnSync } = require('child_process');

// Meta test for the shipped mutation-testing assets.
//
// Two layers, same contract as lib/checkstyle-assets.test.js and
// lib/eslint-assets.test.js:
//   - Structural checks (always run): the shipped Stryker configs are loadable
//     ESM modules with the shape quality-check depends on, and the diff-scope
//     helper turns a real git diff into the right mutation ranges. Needs no
//     Stryker install - just imports the asset files and spawns git.
//   - Gated smoke tests (STRYKER_SMOKE=1): run the REAL Stryker CLI against a
//     minimal sample project (test/fixtures/mutation/stryker-sample) and
//     assert a json report with a finite, numeric mutation score is produced,
//     for the full run and for the diff-scoped run. A config that "looks
//     right" but never computes a score cannot ship.
//
// Stryker + its vitest runner are NOT harness-root devDependencies (they would
// pull a large tree into every install); they live in the sample fixture's own
// package.json. So the execution half is gated on STRYKER_SMOKE, and the sample
// must have its deps installed (`npm install` in the sample dir) before the
// gate is enabled. Verified against @stryker-mutator/core 9.6.1 / Node 22:
// full run 24 mutants, 18 killed / 6 survived, score 75.00% (sample config);
// diff run scoped to one changed line: mutants only on that line.

const REPO_ROOT = path.resolve(__dirname, '..');

// --- Stryker (nextjs-react) structural checks -------------------------------

const MUTATION_ASSET_DIR = path.join(
  REPO_ROOT,
  'stacks',
  'nextjs-react',
  'lint',
  'mutation'
);
const STRYKER_CONFIG_PATH = path.join(MUTATION_ASSET_DIR, 'stryker.config.mjs');
// The distributable asset set is the directory itself (init copies it with
// copyDirSync, never by filename), so fixtures enumerate it the same way - a
// fourth shipped file automatically reaches every fixture repo.
const MUTATION_ASSET_FILES = fs
  .readdirSync(MUTATION_ASSET_DIR)
  .filter((name) => name.endsWith('.mjs'));

// The lean set quality-policy.md §2 ships with: non-behavioural mutators that
// mostly produce survivors costing real tests to kill without saying anything
// about the change under review. Names hand-verified against
// @stryker-mutator/instrumenter 9.6.1 (excludedMutations is free-form in
// Stryker's schema - a typo would silently exclude nothing).
const LEAN_EXCLUDED_MUTATIONS = [
  'StringLiteral',
  'ObjectLiteral',
  'ArrayDeclaration',
  'Regex',
  'OptionalChaining',
];

describe('shipped Stryker config shape (always runs)', () => {
  let config = null;
  let importError = null;

  beforeAll(async () => {
    try {
      const mod = await import(pathToFileURL(STRYKER_CONFIG_PATH).href);
      config = mod.default;
    } catch (err) {
      importError = err;
    }
  });

  it('loads as ESM with a default export', () => {
    expect(
      importError,
      importError ? `failed to import stryker.config.mjs: ${importError.message}` : ''
    ).toBeNull();
    expect(config, 'stryker.config.mjs must have a default export').toBeTruthy();
    expect(typeof config).toBe('object');
  });

  it('uses the vitest test runner', () => {
    expect(config.testRunner).toBe('vitest');
  });

  it('includes a json reporter (the machine report quality-check reads)', () => {
    expect(Array.isArray(config.reporters)).toBe(true);
    expect(config.reporters).toContain('json');
  });

  it('pins the json report path so quality-check reads a fixed location', () => {
    // The path must be explicit, not left to Stryker's implicit default, so
    // quality-check's read contract does not depend on the runner's default.
    expect(config.jsonReporter, 'jsonReporter must be set').toBeTruthy();
    expect(config.jsonReporter.fileName).toBe('reports/mutation/mutation.json');
  });

  it('does NOT set thresholds.break (there is no score gate - triage is test-recommendation\'s job)', () => {
    // thresholds may be present (report coloring hints) but break must be unset
    // so Stryker never fails the run on score.
    const thresholds = config.thresholds || {};
    expect(
      'break' in thresholds ? thresholds.break : undefined,
      'thresholds.break must be left unset - there is no mutation-score gate; ' +
        'the test-recommendation skill triages survivors (quality-policy.md), not Stryker'
    ).toBeUndefined();
  });

  it('excludes exactly the lean set of non-behavioural mutators', () => {
    expect(config.mutator, 'mutator block must be set').toBeTruthy();
    expect([...config.mutator.excludedMutations].sort()).toEqual(
      [...LEAN_EXCLUDED_MUTATIONS].sort()
    );
  });

  it('ignores static mutants', () => {
    expect(config.ignoreStatic).toBe(true);
    // ignoreStatic requires perTest coverage analysis; Stryker's default is
    // perTest, so the config must not override it to something else.
    expect(config.coverageAnalysis === undefined || config.coverageAnalysis === 'perTest').toBe(true);
  });

  it('keeps incremental mode on for the full run with a pinned incremental file', () => {
    expect(config.incremental).toBe(true);
    expect(config.incrementalFile).toBe('reports/mutation/stryker-incremental.json');
  });
});

// --- diff scope helper (changed-ranges.mjs) ----------------------------------

// A throwaway git repo. Files live under app/ so the `--relative` contract is
// exercised: ranges must come back relative to the Stryker working directory
// (app/), exactly as the `mutate` globs are resolved.
function initGitRepo(dir) {
  const g = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  g('init', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  return g;
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Windows requires an elevated process or Developer Mode to create a
// directory *symlink*, but a *junction* needs neither - so on win32 we ask
// for a junction instead. Junctions require an absolute target; every caller
// here passes one derived from REPO_ROOT (already absolute).
function symlinkDirSync(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

// Windows only: turns an EMPTY directory case-sensitive (per-directory flag,
// inherited by subdirectories created afterwards; no elevation needed on
// current Windows). Returns false where the flag is unsupported, so a test
// that needs it can skip instead of passing vacuously.
function makeCaseSensitiveDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  fs.mkdirSync(path.join(dir, 'probe'));
  fs.mkdirSync(path.join(dir, 'PROBE'));
  const both = fs.readdirSync(dir).filter((name) => name.toLowerCase() === 'probe').length === 2;
  fs.rmdirSync(path.join(dir, 'probe'));
  fs.rmdirSync(path.join(dir, 'PROBE'));
  return both;
}

function copyMutationAssets(destRoot) {
  const dest = path.join(destRoot, 'lint', 'mutation');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of MUTATION_ASSET_FILES) {
    fs.copyFileSync(path.join(MUTATION_ASSET_DIR, file), path.join(dest, file));
  }
}

// Builds: main = base tree (with a refs/remotes/origin/main tracking ref so
// the shipped default base-ref probing is exercised), feat = one line changed
// + one line deleted + one line appended in app/src/calc.ts, a new source
// file, a new glob-magic Next.js dynamic-route file, and changes in files the
// mutate globs exclude (a test, a .d.ts) or never include (README.md).
function seedDiffRepo(dir) {
  const g = initGitRepo(dir);
  writeFile(dir, 'app/src/calc.ts', 'line1\nline2\nline3\nline4\nline5\n');
  writeFile(dir, 'app/src/calc.test.ts', 'test1\n');
  writeFile(dir, 'app/src/types.d.ts', 'type A = 1;\n');
  writeFile(dir, 'app/README.md', 'readme\n');
  copyMutationAssets(path.join(dir, 'app'));
  g('add', '.');
  g('commit', '-m', 'base');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-b', 'feat');
  writeFile(dir, 'app/src/calc.ts', 'line1\nline2 changed\nline3\nline5\nline6 added\n');
  writeFile(dir, 'app/src/calc.test.ts', 'test1\ntest2\n');
  writeFile(dir, 'app/src/types.d.ts', 'type A = 2;\n');
  writeFile(dir, 'app/src/new.ts', 'n1\nn2\nn3\n');
  writeFile(dir, 'app/src/app/[id]/page.ts', 'p1\np2\n');
  writeFile(dir, 'app/README.md', 'readme changed\n');
  g('add', '.');
  g('commit', '-m', 'change');
  // The spawned diff config imports minimatch, which must resolve from the
  // fixture the way it resolves from a product root (where it ships as a
  // dependency of @stryker-mutator/core). Symlinked after the commits, so it
  // stays untracked and invisible to the git diffs under test.
  symlinkDirSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(dir, 'app', 'node_modules')
  );
  return g;
}

// Glob-magic paths ([id]) cannot carry a line range (Stryker rejects
// glob+range and globs the file part), so they degrade to a whole-file entry
// in character-class-escaped form; every other file is line-scoped.
const EXPECTED_DIFF_RANGES = [
  'src/app/[[]id[]]/page.ts',
  'src/calc.ts:2-2',
  'src/calc.ts:5-5',
  'src/new.ts:1-3',
];

// Some environments refuse even a junction (e.g. a restricted tmp mount), so
// probe once - synchronously, before describe.skipIf needs the answer - and
// skip the whole diff-scope suite with a clear reason instead of failing
// every fixture-seeding test with a raw EPERM/EACCES.
const DIR_SYMLINK_SKIP_REASON = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-symlink-probe-'));
  try {
    const target = path.join(probeDir, 'target');
    fs.mkdirSync(target);
    symlinkDirSync(target, path.join(probeDir, 'link'));
    return null;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return 'directory symlink not permitted here; enable Developer Mode or run as admin';
    }
    throw err;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

// --- changed-ranges.mjs pure helpers (always run) ---------------------------
//
// scopeCovers is the ONLY guard between a stale diff cache and the report
// quality-check triages (#92), so these tests must never be skipped by the
// directory-symlink gate of the git-fixture suite below. No git, no fixture.
describe('changed-ranges.mjs pure helpers (always runs)', () => {
  let helper = null;

  beforeAll(async () => {
    helper = await import(pathToFileURL(path.join(MUTATION_ASSET_DIR, 'changed-ranges.mjs')).href);
  });

  it('exports the diff-only cache paths under reports/mutation/ (ignored at any depth by init) and reads the opt-in flag strictly', () => {
    expect(helper.DIFF_INCREMENTAL_FILE).toBe('reports/mutation/stryker-incremental.diff.json');
    expect(helper.DIFF_SCOPE_FILE).toBe('reports/mutation/stryker-incremental.diff.scope.json');
    // lib/init.test.js proves `reports/mutation/` is ignored at any depth;
    // keeping both files inside it is what makes them uncommittable.
    for (const file of [helper.DIFF_INCREMENTAL_FILE, helper.DIFF_SCOPE_FILE]) {
      expect(file.startsWith('reports/mutation/'), file).toBe(true);
    }
    expect(helper.incrementalRequested('1')).toBe(true);
    expect(helper.incrementalRequested('true')).toBe(true);
    // Strict on purpose: no trimming, no case folding, no non-string truthiness.
    for (const value of ['0', 'false', '', undefined, 'yes', 'on', 'TRUE', 'True', 'TRUE ', ' 1', 1, true]) {
      expect(helper.incrementalRequested(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('scopeCovers compares line sets per file, a whole-file entry covers every line of its file, and a range set never covers a whole-file entry', () => {
    const covers = (current, previous) => helper.scopeCovers(current, previous);
    // Same lines expressed differently - covered.
    expect(covers(['src/a.ts:2-5'], ['src/a.ts:2-3', 'src/a.ts:5-5'])).toBe(true);
    // Line 4 of the previous scope is gone - not covered.
    expect(covers(['src/a.ts:2-3', 'src/a.ts:5-5'], ['src/a.ts:2-5'])).toBe(false);
    // Shrink: a previously scoped line dropped.
    expect(covers(['src/a.ts:2-2'], ['src/a.ts:2-2', 'src/a.ts:5-5'])).toBe(false);
    // Grow: extra lines / files are fine.
    expect(covers(['src/a.ts:1-9', 'src/b.ts:1-1'], ['src/a.ts:2-2'])).toBe(true);
    // The file itself left the scope.
    expect(covers(['src/b.ts:1-1'], ['src/a.ts:1-1'])).toBe(false);
    // Whole-file (glob-magic) entries.
    expect(covers(['src/app/[[]id[]]/page.ts'], ['src/app/[[]id[]]/page.ts'])).toBe(true);
    expect(covers(['src/app/[[]id[]]/page.ts'], [])).toBe(true);
    expect(covers([], ['src/app/[[]id[]]/page.ts'])).toBe(false);
    expect(covers(['src/a.ts'], ['src/a.ts:2-3'])).toBe(true);
    expect(covers(['src/a.ts:1-100'], ['src/a.ts'])).toBe(false);
    // Nothing cached is always covered; nothing current covers nothing.
    expect(covers(['src/a.ts:1-1'], [])).toBe(true);
    expect(covers([], ['src/a.ts:1-1'])).toBe(false);
    // The range is split off at the LAST ":" - a ":" inside the path stays.
    expect(covers(['src/a:b.ts:3-3'], ['src/a:b.ts:3-3'])).toBe(true);
    expect(covers(['src/a:b.ts:3-3'], ['src/a:b.ts'])).toBe(false);
  });


  // The README's second-choice exclusion for a root-level "!" file (renaming
  // is the first): a negated glob whose "!" is escaped. This pins the HARNESS
  // side only - compileMutateMatcher strips the leading "!" itself and hands
  // the rest to minimatch, which reads "\!" as a literal "!". Stryker's own
  // matcher path.resolve()s the pattern first, which on Windows eats the
  // backslash as a separator, so the full run keeps the file there; the
  // README states that limit rather than this test claiming otherwise.
  it('compileMutateMatcher honours an escaped "!" in a negated glob (the harness side of the README recipe)', () => {
    const inScope = helper.compileMutateMatcher(['**/*.ts', '!\\!bang.ts']);
    expect(inScope('!bang.ts')).toBe(false);
    expect(inScope('bang.ts')).toBe(true);
    expect(inScope('src/!bang.ts')).toBe(true);
    expect(inScope('src/other.ts')).toBe(true);
  });

  it('scopeCovers never expands ranges line by line and treats a reversed range as uncoverable', () => {
    const covers = (current, previous) => helper.scopeCovers(current, previous);
    // A billion-line range must not allocate a billion-entry set (a sidecar
    // is developer-editable input).
    expect(covers(['a.ts:1-2000000000'], ['a.ts:5-5'])).toBe(true);
    expect(covers(['a.ts:5-5'], ['a.ts:1-2000000000'])).toBe(false);
    // Unsorted / overlapping current ranges still cover a span across them.
    expect(covers(['a.ts:4-6', 'a.ts:1-4'], ['a.ts:1-6'])).toBe(true);
    expect(covers(['a.ts:5-6', 'a.ts:1-3'], ['a.ts:1-6'])).toBe(false);
    // A reversed range (start > end) is malformed: it covers nothing and can
    // never count as covered - so it can never make a cache reusable.
    expect(covers(['a.ts:1-9'], ['a.ts:5-2'])).toBe(false);
    expect(covers(['a.ts:5-2'], ['a.ts:5-2'])).toBe(false);
    expect(covers(['a.ts:5-2'], ['a.ts:3-3'])).toBe(false);
    expect(covers(['a.ts:5-2'], [])).toBe(true);
  });

  // Reference model for scopeCovers (#160): expands every range into an
  // explicit line set. Only usable on the small line numbers the random
  // inputs below use - which is the point: it shares no code or shortcut with
  // the interval implementation, so agreement on 1,000 random pairs pins the
  // semantics while the implementation is free to be fast.
  function referenceScopeCovers(current, previous) {
    const parse = (entries) => {
      const files = new Map();
      for (const entry of entries) {
        const match = /^(.+):(\d+)-(\d+)$/.exec(entry);
        if (!match) {
          files.set(entry, null);
          continue;
        }
        const [, file, start, end] = match;
        if (files.get(file) === null) continue;
        const ranges = files.get(file) ?? [];
        ranges.push([Number(start), Number(end)]);
        files.set(file, ranges);
      }
      return files;
    };
    const cur = parse(current);
    for (const [file, ranges] of parse(previous)) {
      if (!cur.has(file)) return false;
      const curRanges = cur.get(file);
      if (curRanges === null) continue;
      if (ranges === null) return false;
      const lines = new Set();
      for (const [s, e] of curRanges) for (let l = s; l <= e; l++) lines.add(l);
      for (const [s, e] of ranges) {
        if (s > e) return false;
        for (let l = s; l <= e; l++) if (!lines.has(l)) return false;
      }
    }
    return true;
  }

  it('scopeCovers agrees with a line-set reference model on 1,000 random scope pairs (#160)', () => {
    // Deterministic PRNG (mulberry32) so a failure reproduces exactly.
    let seed = 0x160;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n) => Math.floor(rand() * n);
    const entries = () => {
      const out = [];
      const count = int(6);
      for (let i = 0; i < count; i++) {
        const file = ['a.ts', 'b.ts', 'c:d.ts'][int(3)];
        if (rand() < 0.08) {
          out.push(file); // whole-file entry
        } else {
          const start = 1 + int(30);
          // Mostly well-formed, sometimes reversed (start > end).
          const end = rand() < 0.1 ? start - 1 - int(3) : start + int(8);
          out.push(`${file}:${start}-${end}`);
        }
      }
      return out;
    };
    let coveredCount = 0;
    for (let i = 0; i < 1000; i++) {
      const current = entries();
      // Bias half of the previous scopes toward the current one so both
      // outcomes are exercised, not just the overwhelmingly common "false".
      const previous =
        rand() < 0.5
          ? current.filter(() => rand() < 0.6)
          : entries();
      const expected = referenceScopeCovers(current, previous);
      if (expected) coveredCount++;
      expect(
        helper.scopeCovers(current, previous),
        `current=${JSON.stringify(current)} previous=${JSON.stringify(previous)}`
      ).toBe(expected);
    }
    // Guard against a degenerate generator that only ever produces one answer.
    expect(coveredCount).toBeGreaterThan(100);
    expect(coveredCount).toBeLessThan(900);
  });

  // 10,000 is the size the design names; 50,000 is where the old
  // per-previous-range rescan took ~5 s (10^8-scale steps) while the interval
  // index stays in the tens of milliseconds, so the bound has wide headroom
  // on a slow CI runner and still fails against an O(P x C) implementation.
  // Only the 50,000 case is the regression test: the old implementation
  // passes the 10,000 case too (~115-217 ms), so that one only pins the
  // design's size.
  for (const size of [10000, 50000]) {
    it(`scopeCovers finishes ${size} previous x ${size} current ranges in under 1 second (#160)`, () => {
      // Worst case for a per-previous-range rescan of the current ranges:
      // every previous range sits at the END of the current list, so a sweep
      // from the start walks all current ranges for each previous one. The
      // interval index answers each in O(log C).
      const current = [];
      for (let i = 0; i < size; i++) {
        // Gapped (every other line) so the ranges cannot merge into one.
        current.push(`big.ts:${i * 2 + 1}-${i * 2 + 1}`);
      }
      const previous = [];
      for (let i = 0; i < size; i++) {
        const line = 2 * size - 1 - 2 * (i % 50);
        previous.push(`big.ts:${line}-${line}`);
      }
      const started = process.hrtime.bigint();
      expect(helper.scopeCovers(current, previous)).toBe(true);
      // A gap line right at the end is still detected as not covered.
      expect(helper.scopeCovers(current, [...previous, `big.ts:${2 * size}-${2 * size}`])).toBe(false);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs, `scopeCovers took ${elapsedMs.toFixed(0)} ms`).toBeLessThan(1000);
    }, 60000);
  }
});

describe.skipIf(DIR_SYMLINK_SKIP_REASON)(
  DIR_SYMLINK_SKIP_REASON
    ? `changed-ranges.mjs (diff scope for mutation:diff) (skipped: ${DIR_SYMLINK_SKIP_REASON})`
    : 'changed-ranges.mjs (diff scope for mutation:diff)',
  () => {
  let helper = null;
  let baseConfig = null;
  let tmpDir;

  beforeAll(async () => {
    helper = await import(pathToFileURL(path.join(MUTATION_ASSET_DIR, 'changed-ranges.mjs')).href);
    baseConfig = (await import(pathToFileURL(STRYKER_CONFIG_PATH).href)).default;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-diff-'));
  });

  afterEach(() => {
    // A process killed a moment ago (the cache-lock test) may still hold its
    // cwd on Windows; retry instead of failing the next test's cleanup.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('matches files the way the shipped mutate globs do (positive + negated patterns)', () => {
    const mutate = baseConfig.mutate;
    const included = ['src/a.ts', 'src/a.tsx', 'src/deep/er/b.ts', 'src/app/[id]/page.tsx'];
    const excluded = [
      'src/a.d.ts',
      'src/a.test.ts',
      'src/a.spec.tsx',
      'src/__tests__/a.ts',
      'src/x/generated/a.ts',
      'src/a.js',
      'lib/a.ts',
      'dist/a.ts',
      'README.md',
    ];
    for (const file of included) {
      expect(helper.matchesMutateGlobs(file, mutate), `${file} should be in scope`).toBe(true);
    }
    for (const file of excluded) {
      expect(helper.matchesMutateGlobs(file, mutate), `${file} should be out of scope`).toBe(false);
    }
  });

  it('mirrors Stryker: patterns apply in order (re-include after negation), braces may hold wildcards, dotdirs stay out', () => {
    // Last matching pattern wins, exactly like Stryker's project reader.
    const reInclude = ['src/**/*.ts', '!src/legacy/**', 'src/legacy/critical/**'];
    expect(helper.matchesMutateGlobs('src/legacy/critical/core.ts', reInclude)).toBe(true);
    expect(helper.matchesMutateGlobs('src/legacy/old.ts', reInclude)).toBe(false);
    // Brace alternatives containing wildcards are valid minimatch (a
    // hand-rolled escape would kill them and empty the whole scope).
    expect(helper.matchesMutateGlobs('src/a.ts', ['src/**/{*.ts,*.tsx}'])).toBe(true);
    // dot: false like Stryker - dot-directories never enter the scope.
    expect(helper.matchesMutateGlobs('src/.internal/a.ts', ['src/**/*.ts'])).toBe(false);
    // No positive pattern -> nothing is in scope.
    expect(helper.matchesMutateGlobs('src/a.ts', ['!src/b.ts'])).toBe(false);
  });

  it('parses -U0 hunks into new-side ranges and skips deletion-only hunks and deleted files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3,2 @@ export function f() {',
      '+  const x = 1;',
      '+  return x;',
      '@@ -10,2 +11,0 @@',
      '-old',
      '-old2',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+a',
      '+b',
      '+c',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git "a/src/we\\"ird.ts" "b/src/we\\"ird.ts"',
      '--- "a/src/we\\"ird.ts"',
      '+++ "b/src/we\\"ird.ts"',
      '@@ -1 +1 @@',
      '+z',
      '',
    ].join('\n');

    expect(helper.parseUnifiedDiff(diff)).toEqual([
      { file: 'src/a.ts', start: 3, end: 4 },
      { file: 'src/new.ts', start: 1, end: 3 },
      { file: 'src/we"ird.ts', start: 1, end: 1 },
    ]);
  });

  it('cannot be hijacked by added content lines that render as +++/--- headers', () => {
    // An added line whose content starts with '++ ' renders as '+++ x' in the
    // diff body. Headers are only honored between `diff --git` and the first
    // hunk, so the parser must keep attributing hunks to src/g.ts.
    const diff = [
      'diff --git a/src/g.ts b/src/g.ts',
      '--- a/src/g.ts',
      '+++ b/src/g.ts',
      '@@ -0,0 +1,2 @@',
      '+++ b/hijacked.ts',
      '+const x = 1;',
      '@@ -9,0 +12 @@',
      '+const y = 2;',
      '',
    ].join('\n');

    expect(helper.parseUnifiedDiff(diff)).toEqual([
      { file: 'src/g.ts', start: 1, end: 2 },
      { file: 'src/g.ts', start: 12, end: 12 },
    ]);
  });

  it('decodes C-quoted paths including octal escapes', () => {
    // With core.quotePath=false git still quotes quotes/control bytes; \346\227\245 is 日.
    expect(helper.unquoteGitPath('"b/src/\\346\\227\\245.ts"')).toBe('b/src/日.ts');
    expect(helper.unquoteGitPath('"b/src/we\\"ird\\\\x.ts"')).toBe('b/src/we"ird\\x.ts');
    expect(helper.unquoteGitPath('b/plain.ts')).toBe('b/plain.ts');
  });

  it('derives ranges from a real git diff, relative to cwd, restricted to the mutate set, with glob-magic paths degraded to whole-file entries', () => {
    seedDiffRepo(tmpDir);

    const ranges = helper.changedLineRanges({
      cwd: path.join(tmpDir, 'app'),
      baseRef: 'main',
      mutate: baseConfig.mutate,
    });

    expect([...ranges].sort()).toEqual([...EXPECTED_DIFF_RANGES].sort());
  });

  it('scopes against the working tree, not just HEAD (uncommitted edits shift line numbers)', () => {
    seedDiffRepo(tmpDir);
    // Uncommitted edit: prepend two lines to calc.ts. Stryker mutates the
    // disk state, so the committed change at line 2 now sits at line 4 and
    // the ranges must follow it.
    writeFile(
      tmpDir,
      'app/src/calc.ts',
      'pre1\npre2\nline1\nline2 changed\nline3\nline5\nline6 added\n'
    );

    const ranges = helper.changedLineRanges({
      cwd: path.join(tmpDir, 'app'),
      baseRef: 'main',
      mutate: baseConfig.mutate,
    });

    expect(ranges).toContain('src/calc.ts:1-2');
    expect(ranges).toContain('src/calc.ts:4-4');
    expect(ranges).not.toContain('src/calc.ts:2-2');
  });

  it('resolves the default base ref by probing origin/main, origin/master, then local main / master, and fails loudly when none exists', () => {
    const g = seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    expect(helper.resolveBaseRef({ cwd })).toBe('origin/main');

    // A remote-tracking ref always outranks the local trunk: origin/master
    // wins over the local main that seedDiffRepo also created.
    g('update-ref', 'refs/remotes/origin/master', 'HEAD');
    g('update-ref', '-d', 'refs/remotes/origin/main');
    expect(helper.resolveBaseRef({ cwd })).toBe('origin/master');

    // No remote-tracking ref at all (worktree, unfetched clone): local main.
    g('update-ref', '-d', 'refs/remotes/origin/master');
    expect(helper.resolveBaseRef({ cwd })).toBe('main');

    // Then local master.
    g('branch', '-m', 'main', 'master');
    expect(helper.resolveBaseRef({ cwd })).toBe('master');

    // Nothing left: the error names every probed candidate.
    g('update-ref', '-d', 'refs/heads/master');
    expect(() => helper.resolveBaseRef({ cwd })).toThrow(
      /no base ref found: none of origin\/main, origin\/master, main, master/
    );
  });

  // The local fallback's safety argument ("a stale trunk only widens the
  // scope") breaks when the trunk IS the checked-out commit - or ahead of it:
  // the merge base would be HEAD and every committed change would silently
  // drop out of the scope (exit 0, "empty scope"). That is a derivation
  // failure and must stay loud (scope_error), so such a candidate is skipped.
  it('refuses a local trunk whose merge base with HEAD is HEAD itself, instead of reporting a silent empty scope', () => {
    const g = seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    g('checkout', '-q', 'main');

    // With a remote-tracking ref the checked-out trunk is fine: there really
    // is nothing to measure against origin/main.
    expect(helper.resolveBaseRef({ cwd })).toBe('origin/main');

    g('update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => helper.resolveBaseRef({ cwd })).toThrow(/no base ref found/);
    expect(() => helper.resolveBaseRef({ cwd })).toThrow(/checked-out commit/);
    // The way out it names is the trunk quality-check diffs against - never
    // HEAD, which would measure only the uncommitted lines while looking
    // like a passing gate run.
    let stuck;
    try {
      helper.resolveBaseRef({ cwd });
    } catch (err) {
      stuck = err;
    }
    expect(stuck.message).toMatch(/set MUTATION_BASE_REF to the trunk quality-check diffs against/);
    expect(stuck.message).not.toMatch(/=HEAD/);

    // A local master AHEAD of HEAD is just as unusable (merge base = HEAD)...
    g('branch', 'master', 'feat');
    expect(() => helper.resolveBaseRef({ cwd })).toThrow(/no base ref found/);
    // ...while one strictly behind HEAD is a real base.
    writeFile(tmpDir, 'app/src/extra.ts', 'e1\n');
    g('add', 'app/src/extra.ts');
    g('commit', '-q', '-m', 'later on main');
    g('branch', '-f', 'master', 'HEAD~1');
    expect(helper.resolveBaseRef({ cwd })).toBe('master');
  });

  it('throws a scope_error-grade failure (with a fetch hint) instead of a silent empty scope when the base ref is unresolvable', () => {
    seedDiffRepo(tmpDir);
    expect(() =>
      helper.changedLineRanges({
        cwd: path.join(tmpDir, 'app'),
        baseRef: 'no-such-ref',
        mutate: baseConfig.mutate,
      })
    ).toThrow(/cannot resolve the merge base/);
  });

  it('rejects option-shaped base refs (git option injection guard)', () => {
    seedDiffRepo(tmpDir);
    expect(() =>
      helper.changedLineRanges({
        cwd: path.join(tmpDir, 'app'),
        baseRef: '--output=/tmp/x',
        mutate: baseConfig.mutate,
      })
    ).toThrow(/must not be empty or start with/);
  });

  // A mutate entry starting with "!" is a negation pattern to Stryker, so a
  // root-level file named "!x.ts" cannot be expressed as a range or as a
  // literal glob - either form would silently DROP the file from the scope
  // (fail-open). Such a path must fail the run loudly. A "!" deeper in the
  // path is literal and keeps its range. New files are `git add -N`ed so the
  // diff sees them (an untracked file is invisible to `git diff`).
  it('refuses a root-level path starting with "!" (Stryker would read the entry as a negation) and keeps a mid-path "!" literal', () => {
    const g = seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const mutate = ['**/*.ts', '!**/*.test.ts', '!**/*.d.ts'];

    writeFile(cwd, 'src/!mid.ts', 'm1\n');
    g('add', '-N', 'app/src/!mid.ts');
    expect(helper.changedLineRanges({ cwd, baseRef: 'main', mutate })).toContain('src/!mid.ts:1-1');

    writeFile(cwd, '!bang.ts', 'b1\n');
    g('add', '-N', 'app/!bang.ts');
    expect(() => helper.changedLineRanges({ cwd, baseRef: 'main', mutate })).toThrow(/negation/);
    g('rm', '-q', '--cached', 'app/!bang.ts');
    fs.rmSync(path.join(cwd, '!bang.ts'));

    // glob-magic AND "!"-prefixed: the negation guard must win over the
    // whole-file literal-glob fallback ("[!]" would not neutralize a leading "!").
    writeFile(cwd, '![id].ts', 'g1\n');
    g('add', '-N', 'app/![id].ts');
    expect(() => helper.changedLineRanges({ cwd, baseRef: 'main', mutate })).toThrow(/negation/);
  });

  it('withChangedLines narrows mutate, keeps incremental off by default, and refuses a config without explicit mutate globs', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main' });
    expect([...scoped.mutate].sort()).toEqual([...EXPECTED_DIFF_RANGES].sort());
    // Everything else is inherited from the base config untouched - except
    // the incremental settings: the full-run cache is full-run state and must
    // never be read or written by the diff run, so incrementalFile always
    // names the diff-only cache even while incremental is off.
    expect(scoped.testRunner).toBe(baseConfig.testRunner);
    expect(scoped.mutator).toEqual(baseConfig.mutator);
    expect(scoped.incremental).toBe(false);
    expect(scoped.incrementalFile).toBe(helper.DIFF_INCREMENTAL_FILE);
    expect(scoped.incrementalFile).not.toBe(baseConfig.incrementalFile);

    expect(() => helper.withChangedLines({}, { cwd, baseRef: 'main' })).toThrow(
      /must define explicit `mutate` globs/
    );
  });

  // --- #92: opt-in incremental for the diff run, guarded by scope containment
  //
  // Stryker keeps every mutant of an incremental cache in the report, even
  // one whose line is no longer inside `mutate` (execution-verified against
  // 9.6.1). So the diff run may only read its cache while the current scope
  // still covers every line the cached run scoped, against the same merge
  // base; otherwise the cache is discarded first. The previous scope lives in
  // a sidecar next to the cache.
  const DIFF_CACHE = 'reports/mutation/stryker-incremental.diff.json';
  const DIFF_SCOPE = 'reports/mutation/stryker-incremental.diff.scope.json';
  const readJson = (cwd, rel) => JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8'));
  const exists = (cwd, rel) => fs.existsSync(path.join(cwd, rel));


  it('withChangedLines with incremental off leaves an existing diff cache alone and writes no sidecar', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main' });

    expect(scoped.incremental).toBe(false);
    expect(readJson(cwd, DIFF_CACHE)).toEqual({ files: {}, previous: true });
    expect(exists(cwd, DIFF_SCOPE)).toBe(false);
  });

  it('withChangedLines with incremental on starts the diff cache on the first run and records the scope in a sidecar', () => {
    const g = seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });

    expect(scoped.incremental).toBe(true);
    expect(scoped.incrementalFile).toBe(DIFF_CACHE);
    const sidecar = readJson(cwd, DIFF_SCOPE);
    expect(sidecar.baseRef).toBe('main');
    expect(sidecar.mergeBase).toBe(g('rev-parse', 'main'));
    expect([...sidecar.mutate].sort()).toEqual([...scoped.mutate].sort());
  });

  it('withChangedLines reuses the diff cache only while the scope still covers the previous run against the same merge base', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const run = () => helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });

    // Same scope as the previous run: the cache survives.
    run();
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
    run();
    expect(readJson(cwd, DIFF_CACHE)).toEqual({ files: {}, previous: true });

    // Grow (a further appended line): every previously scoped line is still
    // in scope, so the cache is kept and the sidecar follows the new scope.
    writeFile(cwd, 'src/calc.ts', 'line1\nline2 changed\nline3\nline5\nline6 added\nline7 added\n');
    run();
    expect(readJson(cwd, DIFF_CACHE)).toEqual({ files: {}, previous: true });
    expect(readJson(cwd, DIFF_SCOPE).mutate).toContain('src/calc.ts:5-6');

    // Shrink (line 2 reverted): its cached mutants would leak into the
    // report, so the cache is discarded and the sidecar rewritten.
    writeFile(cwd, 'src/calc.ts', 'line1\nline2\nline3\nline5\nline6 added\nline7 added\n');
    run();
    expect(exists(cwd, DIFF_CACHE)).toBe(false);
    expect(readJson(cwd, DIFF_SCOPE).mutate).not.toContain('src/calc.ts:2-2');

    // A sidecar naming another merge base: discarded.
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
    writeFile(cwd, DIFF_SCOPE, JSON.stringify({ ...readJson(cwd, DIFF_SCOPE), mergeBase: 'deadbeef' }));
    run();
    expect(exists(cwd, DIFF_CACHE)).toBe(false);

    // A cache without a sidecar (unknown provenance): discarded.
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
    fs.rmSync(path.join(cwd, DIFF_SCOPE));
    run();
    expect(exists(cwd, DIFF_CACHE)).toBe(false);
    expect(exists(cwd, DIFF_SCOPE)).toBe(true);
  });

  // The sidecar lives in a gitignored directory, so a hand-edited (or
  // forged) one never shows up in review. Anything this file would not have
  // written itself is treated as "no provenance" and discards the cache -
  // in particular an empty `mutate`, which would make scopeCovers vacuously
  // true and let any stale cache through.
  it('withChangedLines discards a cache whose sidecar is forged, malformed or of another format version', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const run = () => helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    run();
    const genuine = readJson(cwd, DIFF_SCOPE);
    expect(genuine.version).toBe(1);
    const { version: _dropVersion, ...unversioned } = genuine;

    const forgeries = {
      'empty mutate': { ...genuine, mutate: [] },
      'non-string entry': { ...genuine, mutate: [42] },
      'empty-string entry': { ...genuine, mutate: [''] },
      'reversed range': { ...genuine, mutate: ['src/calc.ts:5-2'] },
      'absurd range': { ...genuine, mutate: ['src/calc.ts:1-2000000000'] },
      'zero line': { ...genuine, mutate: ['src/calc.ts:0-1'] },
      'non-hex merge base': { ...genuine, mergeBase: 'HEAD' },
      'unknown version': { ...genuine, version: 2 },
      'missing version': unversioned,
      'not an object': [genuine],
    };
    for (const [label, sidecar] of Object.entries(forgeries)) {
      writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
      writeFile(cwd, DIFF_SCOPE, JSON.stringify(sidecar));
      run();
      expect(exists(cwd, DIFF_CACHE), label).toBe(false);
    }

    // The genuine sidecar (rewritten by the last run) still reuses.
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
    run();
    expect(readJson(cwd, DIFF_CACHE)).toEqual({ files: {}, previous: true });
  });

  // Stryker rethrows anything but ENOENT when reading the cache, so a cache
  // left truncated by an interrupted run would wedge every later run on the
  // same SyntaxError if it were reported as "reusing".
  it('withChangedLines discards a cache Stryker could not read (truncated JSON, or a directory in its place)', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const run = () => helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    run();

    writeFile(cwd, DIFF_CACHE, '{"files":{"src/calc.ts":{"mut');
    run();
    expect(exists(cwd, DIFF_CACHE)).toBe(false);

    // Valid JSON without the report's `files` object: Stryker would fail on
    // it just the same, so it is not "readable" either.
    writeFile(cwd, DIFF_CACHE, '{"previous":true}');
    run();
    expect(exists(cwd, DIFF_CACHE)).toBe(false);

    // A directory in the cache's place is not this file's to delete (#159:
    // no recursive delete at all): it is left alone and the run goes
    // cache-less, so Stryker never reads it.
    fs.mkdirSync(path.join(cwd, DIFF_CACHE), { recursive: true });
    writeFile(cwd, `${DIFF_CACHE}/stray.txt`, 'x');
    expect(run().incremental).toBe(false);
    expect(exists(cwd, `${DIFF_CACHE}/stray.txt`)).toBe(true);
  });

  // Invariant behind writing the sidecar BEFORE Stryker runs: on disk, cache
  // contents ⊆ the scope the sidecar records. Reuse only ever advances the
  // sidecar to a scope that covers the old one, and a discard empties the
  // cache before writing - so an interrupted run leaves the sidecar ahead of
  // the cache, never behind it, and the next decision errs on discarding.
  it('withChangedLines keeps reusing after an interrupted run left the sidecar ahead of the cache, and discards below the recorded scope', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const run = () => helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    run();
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');

    // Grow: the sidecar advances while the (fake) cache still holds the
    // narrower run - what an interrupted Stryker leaves behind. The same wider
    // scope keeps reusing (cache ⊆ old scope ⊆ recorded scope).
    writeFile(cwd, 'src/calc.ts', 'line1\nline2 changed\nline3\nline5\nline6 added\nline7 added\n');
    run();
    run();
    expect(readJson(cwd, DIFF_CACHE)).toEqual({ files: {}, previous: true });
    expect(readJson(cwd, DIFF_SCOPE).mutate).toContain('src/calc.ts:5-6');

    // Shrinking back to the ORIGINAL scope is below the recorded one: discard.
    writeFile(cwd, 'src/calc.ts', 'line1\nline2 changed\nline3\nline5\nline6 added\n');
    run();
    expect(exists(cwd, DIFF_CACHE)).toBe(false);
  });

  // The diff config is what a product actually runs (`stryker run
  // lint/mutation/stryker.diff.config.mjs`). It resolves the base ref from
  // MUTATION_BASE_REF (default: origin/main probing) and exits the process on
  // an empty scope, so it is exercised in a child process rather than
  // imported into this worker.
  const loadDiffConfigIn = (cwd, baseRef, envOverrides = {}, configRel = 'lint/mutation/stryker.diff.config.mjs') => {
    const { MUTATION_BASE_REF: _drop, MUTATION_INCREMENTAL: _drop2, ...env } = process.env;
    if (baseRef !== undefined) env.MUTATION_BASE_REF = baseRef;
    Object.assign(env, envOverrides);
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const mod = await import(process.argv[1]); console.log(JSON.stringify(mod.default));',
        '--',
        pathToFileURL(path.join(cwd, configRel)).href,
      ],
      { cwd, encoding: 'utf8', env }
    );
  };

  // MUTATION_BASE_REF=HEAD (or any ref whose merge base with HEAD is HEAD)
  // measures the uncommitted lines only - never what quality-check's Step 1
  // diffs against. It stays available for an ad-hoc look, but the run says
  // so on stderr, whichever way the ref was chosen.
  it('warns on stderr when the merge base is HEAD itself (uncommitted changes only - not a gate measurement)', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    fs.appendFileSync(path.join(cwd, 'src/calc.ts'), 'line7\n');

    const head = loadDiffConfigIn(cwd, 'HEAD');
    expect(head.status, head.stderr).toBe(0);
    expect(head.stderr).toContain('[mutation:diff] warning: base HEAD resolves to HEAD itself');
    expect(head.stderr).toContain('not a gate measurement');
    const lines = head.stdout.trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).mutate).toEqual(['src/calc.ts:6-6']);

    // The probed trunk is a real base: no warning.
    const trunk = loadDiffConfigIn(cwd, undefined);
    expect(trunk.status, trunk.stderr).toBe(0);
    expect(trunk.stderr).not.toContain('HEAD itself');
  });

  it('stryker.diff.config.mjs narrows mutate using the probed origin/main default', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    const result = loadDiffConfigIn(cwd, undefined);

    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const config = JSON.parse(lines[lines.length - 1]);
    expect([...config.mutate].sort()).toEqual([...EXPECTED_DIFF_RANGES].sort());
    expect(config.testRunner).toBe('vitest');
    expect(config.incremental).toBe(false);
    expect(config.jsonReporter.fileName).toBe('reports/mutation/mutation.json');
    expect(result.stderr).toContain('base origin/main');
  });

  it('stryker.diff.config.mjs reports an empty scope, removes the stale report, and exits 0 before Stryker would start', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    // A stale report from a previous run must not survive the empty scope -
    // quality-check would read yesterday's mutants as today's. The diff cache
    // and its sidecar go with it: nothing is in scope any more, so the cache
    // could only ever leak mutants into a later run.
    writeFile(cwd, 'reports/mutation/mutation.json', '{"files":{}}');
    writeFile(cwd, DIFF_CACHE, '{"files":{}}');
    writeFile(cwd, DIFF_SCOPE, '{}');

    const result = loadDiffConfigIn(cwd, 'HEAD');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('empty scope');
    // process.exit(0) inside the config: the importing script never prints.
    expect(result.stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(cwd, 'reports', 'mutation', 'mutation.json'))).toBe(false);
    expect(exists(cwd, DIFF_CACHE)).toBe(false);
    expect(exists(cwd, DIFF_SCOPE)).toBe(false);
  });

  // jsonReporter.fileName is PRODUCT-owned config. A directory squatting on it
  // (a mis-set 'reports/mutation') or a path outside the run directory must
  // never be deleted - the run refuses to finish as an empty scope instead
  // (exit 1, quality-check records scope_error), because a leftover report
  // would be read as this run's result.
  it('an empty scope whose stale report cannot be removed exits 1 (scope_error), never deleting a directory or a path outside the run directory', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const wrap = (name, fileName) =>
      writeFile(
        cwd,
        `lint/mutation/${name}`,
        "import base from './stryker.config.mjs';\n" +
          "import { withChangedLines } from './changed-ranges.mjs';\n" +
          `export default withChangedLines({ ...base, jsonReporter: { fileName: ${JSON.stringify(fileName)} } });\n`
      );

    wrap('dir.diff.config.mjs', 'reports/mutation');
    writeFile(cwd, 'reports/mutation/keep.txt', 'keep');
    const dir = loadDiffConfigIn(cwd, 'HEAD', {}, 'lint/mutation/dir.diff.config.mjs');
    expect(dir.status, dir.stderr).toBe(1);
    expect(dir.stderr).toContain('is a directory');
    expect(dir.stderr).toContain('refusing to finish as an empty scope');
    expect(dir.stdout.trim()).toBe('');
    expect(exists(cwd, 'reports/mutation/keep.txt')).toBe(true);

    wrap('outside.diff.config.mjs', '../outside.json');
    writeFile(tmpDir, 'outside.json', '{}');
    const outside = loadDiffConfigIn(cwd, 'HEAD', {}, 'lint/mutation/outside.diff.config.mjs');
    expect(outside.status, outside.stderr).toBe(1);
    expect(outside.stderr).toContain('outside');
    expect(fs.existsSync(path.join(tmpDir, 'outside.json'))).toBe(true);

    // A report whose NAME merely starts with ".." is inside the run
    // directory and is a stale report like any other.
    wrap('dotdot.diff.config.mjs', '..stale.json');
    writeFile(cwd, '..stale.json', '{}');
    const dotdot = loadDiffConfigIn(cwd, 'HEAD', {}, 'lint/mutation/dotdot.diff.config.mjs');
    expect(dotdot.status, dotdot.stderr).toBe(0);
    expect(dotdot.stderr).not.toContain('outside');
    expect(exists(cwd, '..stale.json')).toBe(false);
  });

  // NEW-2: a diff cache that must be discarded but cannot be removed would be
  // read by Stryker as if it were this run's - the run falls back to a
  // cache-less run instead of reporting "starting the diff cache". The
  // removal is made to fail with the platform's own means: on Windows a
  // directory that is a live process's cwd cannot be removed (EBUSY); on
  // POSIX a read-only parent directory refuses the unlink (EACCES; root
  // ignores that, so the test is skipped for uid 0).
  it.skipIf(process.platform !== 'win32' && process.getuid?.() === 0)(
    'incremental falls back to a cache-less run when the previous diff cache cannot be removed',
    () => {
      seedDiffRepo(tmpDir);
      const cwd = path.join(tmpDir, 'app');
      const cacheDir = path.join(cwd, DIFF_CACHE);
      fs.mkdirSync(cacheDir, { recursive: true });
      writeFile(cwd, `${DIFF_CACHE}/leftover.txt`, 'x');
      let holder = null;
      const parent = path.dirname(cacheDir);
      try {
        if (process.platform === 'win32') {
          holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: cacheDir, stdio: 'ignore' });
        } else {
          fs.chmodSync(parent, 0o555);
        }

        const result = loadDiffConfigIn(cwd, 'origin/main', { MUTATION_INCREMENTAL: '1' });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('[mutation:diff] incremental: disabled for this run');
        expect(result.stderr).not.toContain('starting the diff cache');
        const lines = result.stdout.trim().split('\n');
        expect(JSON.parse(lines[lines.length - 1]).incremental).toBe(false);
        expect(fs.existsSync(cacheDir)).toBe(true);
        // No sidecar for a run that used no cache: otherwise the next run would
        // see a readable old cache plus a sidecar recording the current scope.
        expect(exists(cwd, DIFF_SCOPE)).toBe(false);
      } finally {
        if (holder) holder.kill();
        if (process.platform !== 'win32') fs.chmodSync(parent, 0o755);
      }
    }
  );

  it('stryker.diff.config.mjs turns incremental on only for MUTATION_INCREMENTAL=1 and reports the cache decision on stderr', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const configOf = (result) => {
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.trim().split('\n');
      return JSON.parse(lines[lines.length - 1]);
    };

    const off = configOf(loadDiffConfigIn(cwd, undefined, { MUTATION_INCREMENTAL: '0' }));
    expect(off.incremental).toBe(false);
    expect(off.incrementalFile).toBe(DIFF_CACHE);
    expect(exists(cwd, DIFF_SCOPE)).toBe(false);

    const first = loadDiffConfigIn(cwd, undefined, { MUTATION_INCREMENTAL: '1' });
    const on = configOf(first);
    expect(on.incremental).toBe(true);
    expect(on.incrementalFile).toBe(DIFF_CACHE);
    expect(first.stderr).toContain('starting the diff cache');
    expect(exists(cwd, DIFF_SCOPE)).toBe(true);

    writeFile(cwd, DIFF_CACHE, '{"files":{}}');
    const second = loadDiffConfigIn(cwd, undefined, { MUTATION_INCREMENTAL: '1' });
    expect(configOf(second).incremental).toBe(true);
    expect(second.stderr).toContain('reusing the diff cache');
    expect(exists(cwd, DIFF_CACHE)).toBe(true);
  });

  it('stryker.diff.config.mjs fails loudly (nonzero) when the scope cannot be derived', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    const result = loadDiffConfigIn(cwd, 'no-such-ref');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot resolve the merge base');
  });

  // --- #159 (H-45): deletes and writes stay inside the run directory ---------
  //
  // A junction (Windows) or directory symlink (POSIX) anywhere on the way to
  // the report or the diff cache must never let the clean-up delete - or the
  // sidecar write land - outside the directory the run started from. Every
  // "outside" target lives in this test's own temp sandbox (tmpDir/outside),
  // never anywhere else. Containment is decided on REAL paths relative to the
  // real cwd, so a cwd that itself sits under a link (macOS /var, or the
  // `via` link below) keeps working.
  const listTree = (root) => {
    const out = {};
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, key);
        else out[key] = fs.readFileSync(abs, 'utf8');
      }
    };
    walk(root, '');
    return out;
  };

  it('H-45: an empty scope never deletes through a reports junction - the outside report and cache survive and the run exits 1', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    writeFile(outside, 'mutation/stryker-incremental.diff.json/sentinel.txt', 'keep');
    writeFile(outside, 'mutation/stryker-incremental.diff.scope.json', '{"keep":true}');
    writeFile(outside, 'mutation/mutation.json', '{"files":{},"keep":true}');
    symlinkDirSync(outside, path.join(cwd, 'reports'));
    const before = listTree(outside);

    const result = loadDiffConfigIn(cwd, 'HEAD');

    expect(listTree(outside), result.stderr).toEqual(before);
    // The stale report could not be removed, so the run must not claim an
    // empty scope (quality-check records scope_error).
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('outside');
    expect(result.stderr).toContain('refusing to finish as an empty scope');
    expect(fs.lstatSync(path.join(cwd, 'reports')).isSymbolicLink()).toBe(true);
  });

  // Nothing to delete is not a failure: a linked reports/ that holds no
  // stale report must not turn every empty scope into scope_error.
  it('H-45: an empty scope with a linked reports/ but no stale report exits 0 and touches nothing outside', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    symlinkDirSync(outside, path.join(cwd, 'reports'));

    const result = loadDiffConfigIn(cwd, 'HEAD');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('empty scope');
    expect(result.stderr).not.toContain('not removing');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  // Only the up-front containment check stands between this layout and an
  // outside write: no cache or sidecar exists, so the delete helper has
  // nothing to refuse (both are 'absent'), and without the check the run
  // would mkdir and write the sidecar through the junction.
  it('H-45: a cache directory that is itself a junction is refused up front, before any delete or write', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(cwd, 'reports'));
    symlinkDirSync(outside, path.join(cwd, 'reports', 'mutation'));
    expect(helper.removeManagedFile(cwd, DIFF_SCOPE)).toBe('absent');

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });

    expect(scoped.incremental).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scoped, 'incrementalFile')).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  // Windows and macOS file systems are case-insensitive by default: an
  // on-disk REPORTS/MUTATION is the same directory as reports/mutation, and
  // the real path the OS hands back carries the on-disk case. Containment
  // must not mistake that for "outside".
  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'H-45: containment compares names case-insensitively where the file system does',
    () => {
      seedDiffRepo(tmpDir);
      const cwd = path.join(tmpDir, 'app');
      fs.mkdirSync(path.join(cwd, 'REPORTS', 'MUTATION'), { recursive: true });
      expect(helper.isContained(cwd, 'reports/mutation')).toBe(true);

      const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });

      expect(scoped.incremental).toBe(true);
      expect(exists(cwd, DIFF_SCOPE)).toBe(true);
    }
  );

  it('H-45: isContained judges real paths component by component', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(cwd, 'real'));
    symlinkDirSync(outside, path.join(cwd, 'linked'));
    expect(helper.isContained(cwd, '.')).toBe(true);
    expect(helper.isContained(cwd, 'real/absent/deeper')).toBe(true);
    expect(helper.isContained(cwd, 'linked')).toBe(false);
    expect(helper.isContained(cwd, 'linked/absent')).toBe(false);
    expect(helper.isContained(cwd, '../outside')).toBe(false);
    expect(helper.isContained(cwd, outside)).toBe(false);
  });

  // #159: a case-sensitive directory on a case-insensitive OS can hold two
  // siblings that differ only in case. A real parent compared by name,
  // ignoring case, would accept a junction into the other sibling.
  it.skipIf(process.platform !== 'win32')('H-45: isContained does not take a differently-cased sibling for the real parent', ({ skip }) => {
    const cs = path.join(tmpDir, 'cs');
    if (!makeCaseSensitiveDir(cs)) skip('case-sensitive directories are not supported here');
    const cwd = path.join(cs, 'app');
    const twin = path.join(cs, 'APP');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(twin, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'real'));
    symlinkDirSync(path.join(twin, 'reports'), path.join(cwd, 'reports'));
    expect(helper.isContained(cwd, 'real/absent')).toBe(true);
    expect(helper.isContained(cwd, 'reports')).toBe(false);
    expect(helper.isContained(cwd, 'reports/mutation/mutation.json')).toBe(false);
  });

  it('H-45: incremental with a reports junction turns the cache off for the run and writes nothing outside', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    symlinkDirSync(outside, path.join(cwd, 'reports'));

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(scoped.incremental).toBe(false);
    // No cache path at all: Stryker must not write a cache through the link.
    expect(Object.prototype.hasOwnProperty.call(scoped, 'incrementalFile')).toBe(false);
    expect([...scoped.mutate].sort()).toEqual([...EXPECTED_DIFF_RANGES].sort());
  });

  // Round-2 L3: the reuse branch deletes nothing, so a refusal inside the
  // delete helper alone would never fire - containment is checked first.
  it('H-45: a reusable cache behind a reports junction is not reused, and the outside cache and sidecar are left unchanged', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
    // A compact sidecar (this file writes it indented), so any rewrite shows.
    writeFile(cwd, DIFF_SCOPE, JSON.stringify(readJson(cwd, DIFF_SCOPE)));
    const outside = path.join(tmpDir, 'outside');
    fs.renameSync(path.join(cwd, 'reports'), outside);
    symlinkDirSync(outside, path.join(cwd, 'reports'));
    const before = listTree(outside);

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });

    expect(scoped.incremental).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scoped, 'incrementalFile')).toBe(false);
    expect(listTree(outside)).toEqual(before);
  });

  it('H-45: a link or a directory in the cache\'s place is refused, never followed or emptied, and the run goes cache-less', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    writeFile(outside, 'sentinel.txt', 'keep');
    const cacheAbs = path.join(cwd, DIFF_CACHE);
    fs.mkdirSync(path.dirname(cacheAbs), { recursive: true });

    // The cache path itself is a link: neither followed nor unlinked.
    symlinkDirSync(outside, cacheAbs);
    const viaLink = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    expect(viaLink.incremental).toBe(false);
    expect(fs.lstatSync(cacheAbs).isSymbolicLink()).toBe(true);
    expect(listTree(outside)).toEqual({ 'sentinel.txt': 'keep' });
    expect(exists(cwd, DIFF_SCOPE)).toBe(false);

    // A real directory squatting on the cache path, with a junction inside:
    // nothing in it is deleted (no recursive delete exists any more).
    fs.rmSync(cacheAbs);
    writeFile(cwd, `${DIFF_CACHE}/stray.txt`, 'x');
    symlinkDirSync(outside, path.join(cacheAbs, 'inner'));
    const viaDir = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    expect(viaDir.incremental).toBe(false);
    expect(exists(cwd, `${DIFF_CACHE}/stray.txt`)).toBe(true);
    expect(listTree(outside)).toEqual({ 'sentinel.txt': 'keep' });
    expect(exists(cwd, DIFF_SCOPE)).toBe(false);
  });

  it('H-45: a jsonReporter.fileName whose parent is a junction keeps the outside file and exits 1', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');
    const outside = path.join(tmpDir, 'outside');
    writeFile(outside, 'mutation.json', '{"keep":true}');
    symlinkDirSync(outside, path.join(cwd, 'linked'));
    writeFile(
      cwd,
      'lint/mutation/linked.diff.config.mjs',
      "import base from './stryker.config.mjs';\n" +
        "import { withChangedLines } from './changed-ranges.mjs';\n" +
        "export default withChangedLines({ ...base, jsonReporter: { fileName: 'linked/mutation.json' } });\n"
    );

    const result = loadDiffConfigIn(cwd, 'HEAD', {}, 'lint/mutation/linked.diff.config.mjs');

    expect(fs.readFileSync(path.join(outside, 'mutation.json'), 'utf8')).toBe('{"keep":true}');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('outside');
  });

  // Contrast: the cwd itself reached through a link (macOS /var ->
  // /private/var is the everyday case) is a normal layout - every legitimate
  // delete and the sidecar write still happen.
  it('H-45 contrast: a run directory reached through a link still removes the stale report, starts and discards the cache', () => {
    const real = path.join(tmpDir, 'real');
    fs.mkdirSync(real);
    seedDiffRepo(real);
    symlinkDirSync(real, path.join(tmpDir, 'via'));
    const cwd = path.join(tmpDir, 'via', 'app');

    writeFile(cwd, 'reports/mutation/mutation.json', '{"files":{}}');
    writeFile(cwd, DIFF_CACHE, '{"files":{}}');
    writeFile(cwd, DIFF_SCOPE, '{}');
    const empty = loadDiffConfigIn(cwd, 'HEAD');
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stderr).toContain('empty scope');
    expect(exists(cwd, 'reports/mutation/mutation.json')).toBe(false);
    expect(exists(cwd, DIFF_CACHE)).toBe(false);
    expect(exists(cwd, DIFF_SCOPE)).toBe(false);

    const run = () => helper.withChangedLines(baseConfig, { cwd, baseRef: 'main', incremental: true });
    const first = run();
    expect(first.incremental).toBe(true);
    expect(first.incrementalFile).toBe(DIFF_CACHE);
    expect(exists(cwd, DIFF_SCOPE)).toBe(true);

    // Shrink the scope: the cache is discarded (a real delete) and the run
    // still uses a fresh cache.
    writeFile(cwd, DIFF_CACHE, '{"files":{},"previous":true}');
    writeFile(cwd, 'src/calc.ts', 'line1\nline2\nline3\nline5\nline6 added\n');
    const second = run();
    expect(second.incremental).toBe(true);
    expect(exists(cwd, DIFF_CACHE)).toBe(false);
    expect(readJson(cwd, DIFF_SCOPE).mutate).not.toContain('src/calc.ts:2-2');
  });
  }
);

// --- gated execution suite (real Stryker run against the sample) ------------

const SMOKE = process.env.STRYKER_SMOKE;
const SAMPLE_DIR = path.join(
  REPO_ROOT,
  'test',
  'fixtures',
  'mutation',
  'stryker-sample'
);
const SAMPLE_REPORT = path.join(
  SAMPLE_DIR,
  'reports',
  'mutation',
  'mutation.json'
);
const STRYKER_BIN = path.join(
  SAMPLE_DIR,
  'node_modules',
  '@stryker-mutator',
  'core',
  'bin',
  'stryker.js'
);

// Stryker's json report has no top-level score field; the score is derived from
// mutant statuses exactly as Stryker's own summary and quality-check compute it:
//   score = (killed + timeout) / (killed + timeout + survived) * 100
function mutationScoreFromReport(report) {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  for (const file of Object.values(report.files || {})) {
    for (const mutant of file.mutants || []) {
      if (mutant.status === 'Killed') killed += 1;
      else if (mutant.status === 'Timeout') timeout += 1;
      else if (mutant.status === 'Survived') survived += 1;
    }
  }
  const detected = killed + timeout;
  const covered = detected + survived;
  return covered === 0 ? NaN : (detected / covered) * 100;
}

function allMutants(report) {
  return Object.values(report.files || {}).flatMap((file) => file.mutants || []);
}

describe.skipIf(!SMOKE)(
  SMOKE
    ? 'Stryker execution against the sample project'
    : 'Stryker execution (skipped: set STRYKER_SMOKE=1 to run the real mutation run; requires `npm install` in test/fixtures/mutation/stryker-sample first)',
  () => {
    it('deps are installed in the sample (run `npm install` in the sample dir if this fails)', () => {
      expect(
        fs.existsSync(STRYKER_BIN),
        `Stryker is not installed in the sample. Run:\n` +
          `  cd test/fixtures/mutation/stryker-sample && npm install`
      ).toBe(true);
    });

    it(
      'generates mutants and produces a json report with a finite mutation score',
      { timeout: 180000 },
      () => {
        if (!fs.existsSync(STRYKER_BIN)) {
          throw new Error(
            'sample deps missing - run `npm install` in ' +
              'test/fixtures/mutation/stryker-sample'
          );
        }
        // Remove a stale report so we assert on THIS run's output.
        if (fs.existsSync(SAMPLE_REPORT)) {
          fs.rmSync(SAMPLE_REPORT);
        }
        // Spawn the resolved Stryker bin with node (cross-platform; avoids the
        // Windows npx/.cmd execFileSync pitfalls). Equivalent to `stryker run`.
        execFileSync(process.execPath, [STRYKER_BIN, 'run'], {
          cwd: SAMPLE_DIR,
          encoding: 'utf8',
          timeout: 180000,
          stdio: 'pipe',
        });

        expect(
          fs.existsSync(SAMPLE_REPORT),
          `expected Stryker json report at ${SAMPLE_REPORT}`
        ).toBe(true);

        const report = JSON.parse(fs.readFileSync(SAMPLE_REPORT, 'utf8'));

        // Mutants were actually generated.
        const mutantCount = allMutants(report).length;
        expect(mutantCount, 'Stryker must generate at least one mutant').toBeGreaterThan(0);

        // The score is a real, finite number.
        const score = mutationScoreFromReport(report);
        expect(Number.isFinite(score), `mutation score must be finite; got ${score}`).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    );

    // The diff-scoped entry point, end to end: a git repo built from the
    // sample, one changed line in src/calc.ts, and the shipped
    // stryker.diff.config.mjs run through the real Stryker CLI. Every scored
    // mutant in the report must sit on that one line - proving the scope is
    // the changed LINES, not the changed file - and lean-excluded mutators
    // may only ever appear as `Ignored`.
    it(
      'mutation:diff mutates only the changed lines and still produces a scored report',
      // Six Stryker runs on the sample (about 5 s each when measured):
      // 75 s per run below (6 x 75 = 450 s), 600 s for the whole test.
      { timeout: 600000 },
      () => {
        if (!fs.existsSync(STRYKER_BIN)) {
          throw new Error(
            'sample deps missing - run `npm install` in ' +
              'test/fixtures/mutation/stryker-sample'
          );
        }
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-diff-smoke-'));
        try {
          for (const rel of ['package.json', 'vitest.config.ts']) {
            fs.copyFileSync(path.join(SAMPLE_DIR, rel), path.join(repo, rel));
          }
          fs.cpSync(path.join(SAMPLE_DIR, 'src'), path.join(repo, 'src'), { recursive: true });
          fs.cpSync(path.join(SAMPLE_DIR, 'test'), path.join(repo, 'test'), { recursive: true });
          copyMutationAssets(repo);
          // Reuse the sample's installed Stryker + vitest instead of a second
          // install; Stryker symlinks node_modules into its sandbox anyway.
          symlinkDirSync(
            path.join(SAMPLE_DIR, 'node_modules'),
            path.join(repo, 'node_modules')
          );
          fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\nreports\n.stryker-tmp\n');

          const g = initGitRepo(repo);
          g('add', '.');
          g('commit', '-m', 'base');
          g('update-ref', 'refs/remotes/origin/main', 'HEAD');
          g('checkout', '-b', 'feat');

          const calcPath = path.join(repo, 'src', 'calc.ts');
          const calcLines = fs.readFileSync(calcPath, 'utf8').split('\n');
          const changedIndex = calcLines.findIndex((line) => line.includes('return age >= 18;'));
          expect(changedIndex, 'sample calc.ts must still contain the isAdult comparison').toBeGreaterThan(-1);
          calcLines[changedIndex] = calcLines[changedIndex].replace('age >= 18', 'age >= 18 /* changed */');
          fs.writeFileSync(calcPath, calcLines.join('\n'));
          g('add', '.');
          g('commit', '-m', 'touch isAdult');
          const changedLine = changedIndex + 1;

          const { MUTATION_BASE_REF: _drop, ...env } = process.env;
          // A full run FIRST, so the diff run below proves it is immune to
          // the full run's leftovers (incremental cache + report): sharing
          // the incremental state used to merge every full-run mutant into
          // the diff report - the exact report quality-check triages.
          execFileSync(
            process.execPath,
            [STRYKER_BIN, 'run', 'lint/mutation/stryker.config.mjs'],
            { cwd: repo, encoding: 'utf8', timeout: 75000, stdio: 'pipe', env }
          );
          const fullReport = JSON.parse(
            fs.readFileSync(path.join(repo, 'reports', 'mutation', 'mutation.json'), 'utf8')
          );
          expect(
            allMutants(fullReport).filter((m) => m.status !== 'Ignored').length,
            'the full run must score more than the single changed line'
          ).toBeGreaterThan(4);
          // The full run's own cache must survive every diff run below
          // byte for byte (invariant D: the diff run never touches it).
          const fullCache = path.join(repo, 'reports', 'mutation', 'stryker-incremental.json');
          const fullCacheBefore = fs.readFileSync(fullCache, 'utf8');

          execFileSync(
            process.execPath,
            [STRYKER_BIN, 'run', 'lint/mutation/stryker.diff.config.mjs'],
            {
              cwd: repo,
              encoding: 'utf8',
              timeout: 75000,
              stdio: 'pipe',
              env,
            }
          );

          const reportPath = path.join(repo, 'reports', 'mutation', 'mutation.json');
          expect(fs.existsSync(reportPath), `expected Stryker json report at ${reportPath}`).toBe(true);
          const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          const mutants = allMutants(report);
          const scored = mutants.filter((mutant) => mutant.status !== 'Ignored');

          expect(scored.length, 'the changed line must yield at least one scored mutant').toBeGreaterThan(0);
          for (const mutant of scored) {
            expect(
              mutant.location.start.line,
              `mutant ${mutant.id} (${mutant.mutatorName}) lies outside the changed line`
            ).toBe(changedLine);
            // The lean set is in force for everything that counts toward the
            // score; excluded mutators may only appear with status Ignored.
            expect(LEAN_EXCLUDED_MUTATIONS).not.toContain(mutant.mutatorName);
          }
          const score = mutationScoreFromReport(report);
          expect(Number.isFinite(score), `mutation score must be finite; got ${score}`).toBe(true);

          // #92 re-measurement with MUTATION_INCREMENTAL=1, three passes:
          // 1. same scope twice -> every cached result is reused;
          // 2. scope grown by a second changed line -> cache kept, the report
          //    scores both lines and nothing else;
          // 3. scope moved (first line reverted) -> cache discarded, so no
          //    mutant of the old line leaks into the report (the hazard that
          //    keeps incremental off by default; execution-verified, 9.6.1).
          const diffCache = path.join(repo, 'reports', 'mutation', 'stryker-incremental.diff.json');
          const runDiffIncremental = () => {
            const result = spawnSync(
              process.execPath,
              [STRYKER_BIN, 'run', 'lint/mutation/stryker.diff.config.mjs'],
              { cwd: repo, encoding: 'utf8', timeout: 75000, env: { ...env, MUTATION_INCREMENTAL: '1' } }
            );
            expect(result.status, result.stderr).toBe(0);
            const scoredLines = allMutants(JSON.parse(fs.readFileSync(reportPath, 'utf8')))
              .filter((mutant) => mutant.status !== 'Ignored')
              .map((mutant) => mutant.location.start.line);
            return { log: result.stdout + result.stderr, stderr: result.stderr, scoredLines };
          };

          const warm = runDiffIncremental();
          expect(warm.stderr).toContain('starting the diff cache');
          expect(fs.existsSync(diffCache), 'the diff run must write its own cache').toBe(true);
          expect(new Set(warm.scoredLines)).toEqual(new Set([changedLine]));

          const reused = runDiffIncremental();
          expect(reused.stderr).toContain('reusing the diff cache');
          expect(reused.log).toMatch(/([1-9]\d*) of \1 mutant result\(s\) are reused/);
          expect(new Set(reused.scoredLines)).toEqual(new Set([changedLine]));

          const grownLines = fs.readFileSync(calcPath, 'utf8').split('\n');
          const secondIndex = grownLines.findIndex((line) => line.includes('return a + b;'));
          expect(secondIndex, 'sample calc.ts must still contain the add expression').toBeGreaterThan(-1);
          grownLines[secondIndex] = grownLines[secondIndex] + ' // grown';
          fs.writeFileSync(calcPath, grownLines.join('\n'));
          const secondLine = secondIndex + 1;

          const grown = runDiffIncremental();
          expect(grown.stderr).toContain('reusing the diff cache');
          expect(new Set(grown.scoredLines)).toEqual(new Set([changedLine, secondLine]));

          const movedLines = fs.readFileSync(calcPath, 'utf8').split('\n');
          movedLines[changedIndex] = movedLines[changedIndex].replace(' /* changed */', '');
          fs.writeFileSync(calcPath, movedLines.join('\n'));

          const moved = runDiffIncremental();
          expect(moved.stderr).toContain('starting the diff cache');
          expect(moved.scoredLines, 'no mutant of the reverted line may survive in the report').not.toContain(changedLine);
          expect(new Set(moved.scoredLines)).toEqual(new Set([secondLine]));

          expect(
            fs.readFileSync(fullCache, 'utf8'),
            'the diff run must never touch the full run cache'
          ).toBe(fullCacheBefore);
        } finally {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      }
    );
  }
);

// --- PIT (java-springboot) structural checks --------------------------------
//
// Structural, unconditional (no JVM/Gradle needed): assert the shipped
// pitest.gradle snippet has the shape quality-check depends on. String/regex
// checks only - no gradle parser dependency.
//
// EXECUTION-VERIFIED separately: the PIT mechanism was run once end-to-end
// against a real Spring Boot project (platform_backend), narrowed to one class
// + its test, and then fully reverted. pitest core 1.16.1 + pitest-junit5-plugin
// 1.2.1 generated 21 mutants against
// product.repository.query_builders.SearchConditionBuilder (test
// SearchConditionBuilderTest, 45 tests run), killed 16 / survived 5 (76% score,
// 98% line coverage), and wrote the machine-readable
// build/reports/pitest/mutations.xml score report - confirming mutants are
// generated, executed against the tests, and scored. That run needs a JVM +
// network so it is not reproduced here; these checks guard the shipped config's
// structure so it cannot silently drift out of that verified shape. The
// mutationDiff entry point added later follows the same manual-verification
// discipline (see the stack README).

const PITEST_GRADLE_PATH = path.join(
  REPO_ROOT,
  'stacks',
  'java-springboot',
  'lint',
  'mutation',
  'pitest.gradle'
);

describe('shipped PIT pitest.gradle shape (always runs)', () => {
  let source = null;
  let readError = null;
  let withoutLineComments = '';

  beforeAll(() => {
    try {
      source = fs.readFileSync(PITEST_GRADLE_PATH, 'utf8');
      withoutLineComments = source.replace(/\/\/.*$/gm, '');
    } catch (err) {
      readError = err;
    }
  });

  it('is a readable file', () => {
    expect(
      readError,
      readError ? `failed to read pitest.gradle: ${readError.message}` : ''
    ).toBeNull();
    expect(typeof source).toBe('string');
    expect(source.length).toBeGreaterThan(0);
  });

  it('references the info.solidsoft.pitest plugin', () => {
    expect(
      source.includes('info.solidsoft.pitest'),
      'pitest.gradle must reference the info.solidsoft.pitest plugin id'
    ).toBe(true);
  });

  it('sets targetClasses with the __BASE_PACKAGE__ placeholder', () => {
    // lint-scaffolding rewrites __BASE_PACKAGE__ to the product base package.
    // The placeholder must live in the targetClasses assignment so the mutation
    // scope is bound to the product's package, not left global/unset.
    expect(
      /targetClasses\s*=\s*\[[^\]]*__BASE_PACKAGE__/.test(source),
      'targetClasses must be set and contain the __BASE_PACKAGE__ placeholder'
    ).toBe(true);
  });

  it('sets XML output (the machine report quality-check reads)', () => {
    // outputFormats must be assigned and include XML.
    const outputFormatsMatch = source.match(/outputFormats\s*=\s*\[([^\]]*)\]/);
    expect(
      outputFormatsMatch,
      'outputFormats must be set in pitest.gradle'
    ).toBeTruthy();
    expect(
      /['"]XML['"]/.test(outputFormatsMatch[1]),
      'outputFormats must include XML so quality-check can parse the score'
    ).toBe(true);
  });

  it("does NOT set mutationThreshold (there is no score gate - triage is test-recommendation's job)", () => {
    // The word may appear in an explanatory comment; what must NOT exist is an
    // actual `mutationThreshold = <value>` assignment. Strip line comments first
    // so a comment mention never trips this, then look for the assignment.
    expect(
      /mutationThreshold\s*=/.test(withoutLineComments),
      'mutationThreshold must be left unset - there is no mutation-score gate; ' +
        'the test-recommendation skill triages survivors (quality-policy.md), not PIT'
    ).toBe(false);
  });

  it('pins the DEFAULTS mutator group (behaviour-changing mutators only)', () => {
    expect(
      /mutators\s*=\s*\[\s*'DEFAULTS'\s*\]/.test(withoutLineComments),
      "mutators must be pinned to ['DEFAULTS'] so the scope never widens to STRONGER / ALL"
    ).toBe(true);
  });

  it('registers mutationFull / mutationDiff and keys the diff scope on the requested task names, not on property presence', () => {
    expect(withoutLineComments).toContain("tasks.register('mutationFull')");
    expect(withoutLineComments).toContain("tasks.register('mutationDiff')");
    // Gradle task names cannot contain ':' (project-path separator); the JS
    // script names must not leak into the Gradle side.
    expect(/register\(\s*['"]mutation:/.test(withoutLineComments)).toBe(false);
    // An ambient mutationDiffBase (gradle.properties) must never narrow
    // mutationFull or make unrelated builds shell out to git: the property may
    // only be read inside the branch gated on the requested task names. A
    // taskGraph.whenReady listener is forbidden - it is incompatible with the
    // configuration cache (on a cache hit it never fires and the narrowing
    // would silently not apply).
    expect(withoutLineComments).not.toContain('taskGraph.whenReady');
    expect(withoutLineComments).toContain('gradle.startParameter.taskNames');
    const gateIndex = withoutLineComments.indexOf('gradle.startParameter.taskNames');
    const propertyIndex = withoutLineComments.indexOf("findProperty('mutationDiffBase')");
    expect(propertyIndex, 'mutationDiffBase must be read').toBeGreaterThan(-1);
    expect(
      propertyIndex > gateIndex,
      'mutationDiffBase must only be read inside the task-name-gated branch'
    ).toBe(true);
    // Fail-safe: reaching mutationDiff without the narrowing applied (task
    // abbreviation skipping the name gate) must fail loudly.
    expect(withoutLineComments).toContain('if (!mutationDiffScoped)');
  });

  it('keeps the diff run honest: full-suite targetTests, no failWhenNoMutations, inner-class-only globs, no sentinel', () => {
    // PIT derives targetTests from targetClasses when unset, which would
    // silently drop every test not named after the changed class.
    expect(withoutLineComments).toContain('pitest.targetTests = pitest.targetClasses.get()');
    // Changed classes with zero mutation points (interfaces, constants) must
    // complete as an empty scope, not fail the build - for EVERY diff run.
    expect(withoutLineComments).toContain('pitest.failWhenNoMutations = false');
    // FQCN + FQCN$* covers inner classes without swallowing sibling classes
    // that share the name prefix (OrderService* vs OrderServiceImpl).
    expect(withoutLineComments).toContain("[fqcn, fqcn + '$*']");
    // The empty scope disables the pitest task instead of running PIT against
    // a magic sentinel class name.
    expect(withoutLineComments).not.toContain('__EMPTY_SCOPE__');
    expect(withoutLineComments).toContain('enabled = false');
  });

  // #95: a diff run that produces no mutants writes no XML, so a report left
  // by an earlier run would be read as this run's result. The diff path must
  // delete the report directory BEFORE pitest runs - as a task dependency,
  // not a doFirst, because the empty scope disables the pitest task and a
  // disabled task skips its own actions while its dependencies still run.
  it('removes the stale PIT report before every diff run, including the disabled-task empty scope (#95)', () => {
    const diffBlock = withoutLineComments.indexOf('if (mutationDiffRequested)');
    const emptyBranch = withoutLineComments.indexOf('if (changedClasses.isEmpty())');
    const scoped = withoutLineComments.indexOf('mutationDiffScoped = true');
    expect(diffBlock).toBeGreaterThan(-1);
    expect(emptyBranch).toBeGreaterThan(diffBlock);
    expect(scoped).toBeGreaterThan(emptyBranch);

    // Registered lazily and held in a local: a bare task name in dependsOn
    // would resolve through the project's dynamic lookup and realize the
    // task eagerly.
    const register = withoutLineComments.indexOf(
      "def mutationDiffCleanReport = tasks.register('mutationDiffCleanReport') {"
    );
    expect(register, 'clean task registered inside the diff block').toBeGreaterThan(diffBlock);
    expect(register).toBeLessThan(emptyBranch);

    // Wired before the empty-scope branch, so both branches carry it.
    const wiring = withoutLineComments.indexOf(
      "tasks.named('pitest').configure { dependsOn(mutationDiffCleanReport) }"
    );
    expect(wiring, 'dependsOn wired through tasks.named(...).configure').toBeGreaterThan(register);
    expect(wiring).toBeLessThan(emptyBranch);

    // The deletion sits inside the register closure, and it is guarded:
    // reportDir is deleted with everything in it and a product may point it
    // anywhere, so anything outside the build directory must be refused.
    // #159: no Gradle Delete (it may follow a Windows junction inside
    // reportDir) - an inspect-then-delete doLast that never follows links
    // (executed for real by the PITEST_GRADLE suite below).
    expect(withoutLineComments).not.toMatch(/tasks\.register\('mutationDiffCleanReport',\s*Delete\)/);
    expect(withoutLineComments).not.toContain('delete pitest.reportDir');
    const deleteLine = withoutLineComments.indexOf('Files.delete(quarantine)');
    expect(deleteLine, 'delete inside the register closure').toBeGreaterThan(register);
    expect(deleteLine).toBeLessThan(wiring);
    const closure = withoutLineComments.slice(register, deleteLine);
    expect(closure, 'reportDir confined to the build directory').toContain('layout.buildDirectory');
    expect(closure).toContain('throw new GradleException');
    expect(closure, 'real-path containment').toContain('toRealPath()');
    expect(closure, 'never follows links while inspecting').toContain('LinkOption.NOFOLLOW_LINKS');
    expect(closure).not.toContain('FileVisitOption.FOLLOW_LINKS');
    // Inspection finishes before the first delete: a refusal deletes nothing.
    const refusal = closure.lastIndexOf('if (!found.outside.isEmpty())');
    expect(refusal, 'refuses before deleting').toBeGreaterThan(-1);
    // ...and before reportDir is moved aside: only a whole-directory move
    // that succeeded lets anything be deleted (#159).
    const move = closure.indexOf('StandardCopyOption.ATOMIC_MOVE');
    expect(move, 'moved aside atomically').toBeGreaterThan(refusal);
    expect(closure.indexOf('Files.delete(')).toBeGreaterThan(move);
    // Parents are matched by identity, never by a case-insensitive name.
    expect(closure).toContain('Files.isSameFile(');
    expect(closure).not.toContain('equalsIgnoreCase');

    // Registered once, wired once, never from a doFirst.
    expect(withoutLineComments.match(/tasks\.register\('mutationDiffCleanReport'/g)).toHaveLength(1);
    expect(withoutLineComments.match(/dependsOn\(mutationDiffCleanReport\)/g)).toHaveLength(1);
    expect(withoutLineComments).not.toMatch(/doFirst[\s\S]{0,300}reportDir/);
  });
});

// --- PIT clean task execution (gated: PITEST_GRADLE) -------------------------
//
// #159 (H-45): mutationDiffCleanReport deletes the PIT report directory before
// every diff run. These tests run the REAL task in a throwaway Gradle project
// that applies the shipped pitest.gradle, and plant a junction (Windows) or
// directory symlink (POSIX) above and inside reportDir pointing at a
// directory in the same temp sandbox. The task must refuse and delete
// nothing; a normal reportDir - also with the project reached through a link
// - must still be deleted.
//
// Gated because it needs a JDK, a Gradle on hand and (first run) the plugin
// portal: set PITEST_GRADLE to the gradle executable (CI: the `gradle` job of
// .github/workflows/test.yml). The project resolves the pitest plugin only;
// the diff is empty, so the pitest task is disabled and PIT itself never runs
// - only the clean task does.
const PITEST_GRADLE = process.env.PITEST_GRADLE;
const PITEST_PLUGIN_VERSION = process.env.PITEST_PLUGIN_VERSION || '1.19.0';

describe.skipIf(!PITEST_GRADLE)(
  PITEST_GRADLE
    ? 'pitest.gradle mutationDiffCleanReport execution (#159)'
    : 'pitest.gradle mutationDiffCleanReport execution (skipped: set PITEST_GRADLE=<gradle executable> to run)',
  () => {
    let tmpDir;

    // Opted in, so a missing link capability must fail - never let the CI
    // job pass on skipped tests.
    it('can create directory links here', () => {
      expect(DIR_SYMLINK_SKIP_REASON).toBeNull();
    });

    beforeEach(() => {
      // Long-name real path: the Windows runner's TEMP is an 8.3 short name
      // (RUNNER~1), while Gradle prints the canonical project path.
      tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pitest-clean-')));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    // A committed, empty-diff Gradle project: mutationDiff against HEAD is an
    // empty scope, so only mutationDiffCleanReport does any work.
    function seedGradleProject(dir) {
      const g = initGitRepo(dir);
      writeFile(dir, 'settings.gradle', "rootProject.name = 'pitest-clean-fixture'\n");
      writeFile(
        dir,
        'build.gradle',
        "plugins {\n    id 'java'\n" +
          `    id 'info.solidsoft.pitest' version '${PITEST_PLUGIN_VERSION}'\n}\n` +
          // Only so the configuration cache can store the pitest task's
          // classpath; PIT itself never runs (the task is disabled).
          'repositories { mavenCentral() }\n' +
          "apply from: 'lint/mutation/pitest.gradle'\n"
      );
      writeFile(dir, '.gitignore', 'build/\n.gradle/\n');
      fs.mkdirSync(path.join(dir, 'lint', 'mutation'), { recursive: true });
      fs.copyFileSync(PITEST_GRADLE_PATH, path.join(dir, 'lint', 'mutation', 'pitest.gradle'));
      g('add', '.');
      g('commit', '-m', 'fixture');
      return g;
    }

    function runClean(projectDir, extraArgs = []) {
      const args = ['mutationDiff', '-PmutationDiffBase=HEAD', '--console=plain', '--stacktrace', ...extraArgs];
      const result = spawnSync(PITEST_GRADLE, args, {
        cwd: projectDir,
        encoding: 'utf8',
        // gradle.bat cannot be spawned without a shell on Windows.
        shell: process.platform === 'win32',
        timeout: 240000,
      });
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    }

    it('refuses a reportDir reached through a junction above it and deletes nothing outside', () => {
      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const outside = path.join(tmpDir, 'outside');
      writeFile(outside, 'pitest/sentinel.txt', 'keep');
      fs.mkdirSync(path.join(project, 'build'), { recursive: true });
      symlinkDirSync(outside, path.join(project, 'build', 'reports'));

      const result = runClean(project);

      expect(fs.existsSync(path.join(outside, 'pitest', 'sentinel.txt')), result.output).toBe(true);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('resolves outside the build directory');
      expect(result.output).toContain('nothing was deleted');
    }, 300000);

    it('refuses a reportDir with a junction inside it and deletes nothing at all', () => {
      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const outside = path.join(tmpDir, 'outside');
      writeFile(outside, 'sentinel.txt', 'keep');
      const reportDir = path.join(project, 'build', 'reports', 'pitest');
      writeFile(reportDir, 'mutations.xml', '<mutations/>');
      symlinkDirSync(outside, path.join(reportDir, 'x'));

      const result = runClean(project);

      expect(fs.existsSync(path.join(outside, 'sentinel.txt')), result.output).toBe(true);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('contains entries that resolve outside it');
      expect(result.output).toContain(path.join('pitest', 'x'));
      // Two-phase: the inspection failed, so even the regular report stays.
      expect(fs.existsSync(path.join(reportDir, 'mutations.xml'))).toBe(true);
    }, 300000);

    // Windows only: a directory entry whose name ends with a dot, created
    // through the extended-length path form. The JVM lists it but opens it
    // under a normalized name, i.e. as a missing file.
    it.skipIf(process.platform !== 'win32')('an entry that is listed but cannot be opened stops the run with nothing deleted', () => {
      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const outside = path.join(tmpDir, 'outside');
      writeFile(outside, 'sentinel.txt', 'keep');
      const reportDir = path.join(project, 'build', 'reports', 'pitest');
      writeFile(reportDir, 'mutations.xml', '<mutations/>');
      fs.symlinkSync(outside, '\\\\?\\' + path.join(reportDir, 'x.'), 'junction');

      const result = runClean(project);

      expect(fs.existsSync(path.join(outside, 'sentinel.txt')), result.output).toBe(true);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('nothing was deleted');
      expect(result.output).toContain('could not be inspected');
      expect(fs.existsSync(path.join(reportDir, 'mutations.xml'))).toBe(true);
    }, 300000);

    // Windows: the read-only attribute. POSIX: a non-writable directory
    // (not testable as root, which ignores the mode). Order-independent: on
    // POSIX the only undeletable entry is a directory whose own contents ARE
    // deletable, and deletes go deepest first - so an unguarded cleanup
    // always deletes sub/deeper/file.xml before it fails, whatever order the
    // directory listings come back in.
    it.skipIf(process.platform !== 'win32' && process.getuid?.() === 0)('an entry that cannot be deleted stops the run with nothing deleted', () => {
      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const reportDir = path.join(project, 'build', 'reports', 'pitest');
      writeFile(reportDir, 'a-first.xml', '<a/>');
      writeFile(reportDir, 'sub/deeper/file.xml', '<f/>');
      const deeperFile = path.join(reportDir, 'sub', 'deeper', 'file.xml');
      const lockedParent = path.join(reportDir, 'sub');
      // Windows: a read-only file; POSIX: sub is not writable, so
      // sub/deeper cannot be unlinked.
      const locked =
        process.platform === 'win32' ? path.join(lockedParent, 'z-locked.xml') : path.join(lockedParent, 'deeper');
      if (process.platform === 'win32') {
        writeFile(lockedParent, 'z-locked.xml', '<z/>');
        fs.chmodSync(locked, 0o444);
      } else {
        fs.chmodSync(lockedParent, 0o555);
      }
      try {
        const result = runClean(project);

        expect(result.status, result.output).not.toBe(0);
        expect(result.output).toContain('cannot be deleted');
        expect(result.output).toContain('nothing was deleted');
        expect(result.output).toContain(locked);
        expect(fs.existsSync(path.join(reportDir, 'a-first.xml'))).toBe(true);
        expect(fs.existsSync(deeperFile), 'deletable entries below the locked one survive too').toBe(true);
        expect(fs.existsSync(locked)).toBe(true);
      } finally {
        if (process.platform === 'win32') fs.chmodSync(locked, 0o666);
        else fs.chmodSync(lockedParent, 0o755);
      }
    }, 300000);

    // Starts a child process that holds `what` and resolves once it does
    // (Windows): a file opened without delete sharing, or a directory used as
    // the child's working directory - neither can be seen by inspecting the
    // tree beforehand. Returns a function that ends the child.
    async function holdInChild(what, kind) {
      const child =
        kind === 'open-file'
          ? spawn(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$f = [IO.File]::Open('${what.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); 'ready'; Start-Sleep -Seconds 300`,
              ],
              { stdio: ['ignore', 'pipe', 'inherit'] }
            )
          : spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
              cwd: what,
              stdio: ['ignore', 'pipe', 'inherit'],
            });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await new Promise((resolve, reject) => {
        let seen = '';
        child.stdout.on('data', (chunk) => {
          seen += chunk;
          if (seen.includes('ready')) resolve();
        });
        child.once('error', reject);
        exited.then((code) => reject(new Error(`holder exited early (${code})`)));
      });
      return async () => {
        child.kill();
        await exited;
      };
    }

    // #159: a delete denial that inspection cannot see must not leave a
    // half-deleted report. On Windows both of these also block renaming
    // reportDir, so the run stops before anything is deleted.
    for (const kind of ['open-file', 'working-directory']) {
      it.skipIf(process.platform !== 'win32')(`a report entry held by another process (${kind}) stops the run with nothing deleted`, async () => {
        const project = path.join(tmpDir, 'project');
        fs.mkdirSync(project);
        seedGradleProject(project);
        const reportDir = path.join(project, 'build', 'reports', 'pitest');
        writeFile(reportDir, 'a-first.xml', '<a/>');
        writeFile(reportDir, 'sub/z-held.xml', '<z/>');
        const held = kind === 'open-file' ? path.join(reportDir, 'sub', 'z-held.xml') : path.join(reportDir, 'sub');
        const release = await holdInChild(held, kind);
        let result;
        try {
          result = runClean(project);
        } finally {
          await release();
        }

        expect(result.status, result.output).not.toBe(0);
        expect(result.output).toContain('could not be moved aside');
        expect(result.output).toContain('nothing was deleted');
        expect(fs.existsSync(path.join(reportDir, 'a-first.xml')), result.output).toBe(true);
        expect(fs.existsSync(path.join(reportDir, 'sub', 'z-held.xml'))).toBe(true);
      }, 300000);
    }

    // A denial that does not block the rename (here: an ACL that denies the
    // delete) fails while deleting the moved-aside copy. reportDir itself is
    // gone - no stale report can be read - and the run names what remains.
    it.skipIf(process.platform !== 'win32')('a delete denied after the report was moved aside names the remaining directory and leaves no stale report', ({ skip }) => {
      // Everyone (by SID, locale-independent): no DELETE on the file, no
      // delete-child on its directory.
      const everyone = '*S-1-1-0';
      const icacls = (...args) => execFileSync('icacls.exe', args, { stdio: 'ignore' });
      const denyDelete = (dir, file) => {
        icacls(path.join(dir, file), '/deny', `${everyone}:(D)`);
        icacls(dir, '/deny', `${everyone}:(DC)`);
      };
      const allowDelete = (dir, file) => {
        for (const target of [dir, path.join(dir, file)]) {
          try {
            icacls(target, '/remove:d', everyone);
          } catch {
            // already gone
          }
        }
      };
      // Some accounts (an elevated CI runner) are not stopped by the deny;
      // probe first so the test cannot pass without exercising the denial.
      const probe = path.join(tmpDir, 'acl-probe');
      writeFile(probe, 'f.txt', 'x');
      denyDelete(probe, 'f.txt');
      let denied = false;
      try {
        fs.unlinkSync(path.join(probe, 'f.txt'));
      } catch {
        denied = true;
      }
      allowDelete(probe, 'f.txt');
      if (!denied) skip('a deny-delete ACL does not stop this account');

      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const reportsDir = path.join(project, 'build', 'reports');
      const reportDir = path.join(reportsDir, 'pitest');
      writeFile(reportDir, 'mutations.xml', '<mutations/>');
      writeFile(reportDir, 'sub/z-denied.xml', '<z/>');
      denyDelete(path.join(reportDir, 'sub'), 'z-denied.xml');
      let quarantine = null;
      try {
        const result = runClean(project);
        const left = fs.readdirSync(reportsDir).filter((name) => name.startsWith('.pitest.helm-delete-'));
        if (left.length === 1) quarantine = path.join(reportsDir, left[0]);

        expect(result.status, result.output).not.toBe(0);
        expect(fs.existsSync(reportDir), 'reportDir itself is gone').toBe(false);
        expect(quarantine, result.output).not.toBeNull();
        expect(result.output).toContain(`was moved aside to ${quarantine}`);
        expect(result.output).toContain('no stale report remains');
        expect(fs.existsSync(path.join(quarantine, 'sub', 'z-denied.xml'))).toBe(true);
      } finally {
        allowDelete(path.join(quarantine ?? reportDir, 'sub'), 'z-denied.xml');
      }
    }, 300000);

    it('leaves a leftover moved-aside directory from an earlier run alone and warns about it', () => {
      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const reportsDir = path.join(project, 'build', 'reports');
      writeFile(reportsDir, 'pitest/mutations.xml', '<mutations/>');
      const leftover = path.join(reportsDir, '.pitest.helm-delete-earlier');
      writeFile(leftover, 'kept.txt', 'keep');

      const result = runClean(project);

      expect(result.status, result.output).toBe(0);
      expect(fs.existsSync(path.join(reportsDir, 'pitest'))).toBe(false);
      expect(fs.readFileSync(path.join(leftover, 'kept.txt'), 'utf8')).toBe('keep');
      expect(result.output).toContain(`left alone: ${leftover}`);
    }, 300000);

    // #159: a case-sensitive directory on Windows can hold two siblings that
    // differ only in case; a parent matched by name, ignoring case, would
    // accept a junction into the other one. Above and inside reportDir.
    it.skipIf(process.platform !== 'win32')('a junction into a differently-cased sibling is refused, above and inside reportDir', ({ skip }) => {
      const cs = path.join(tmpDir, 'cs');
      if (!makeCaseSensitiveDir(cs)) skip('case-sensitive directories are not supported here');
      const project = path.join(cs, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const twin = path.join(cs, 'PROJECT');
      writeFile(twin, 'build/reports/pitest/x/sentinel.txt', 'keep');
      const twinSentinel = path.join(twin, 'build', 'reports', 'pitest', 'x', 'sentinel.txt');

      fs.mkdirSync(path.join(project, 'build'));
      symlinkDirSync(path.join(twin, 'build', 'reports'), path.join(project, 'build', 'reports'));
      const above = runClean(project);
      expect(fs.existsSync(twinSentinel), above.output).toBe(true);
      expect(above.status, above.output).not.toBe(0);
      expect(above.output).toContain('nothing was deleted');

      fs.rmdirSync(path.join(project, 'build', 'reports'));
      const reportDir = path.join(project, 'build', 'reports', 'pitest');
      writeFile(reportDir, 'mutations.xml', '<mutations/>');
      symlinkDirSync(path.join(twin, 'build', 'reports', 'pitest', 'x'), path.join(reportDir, 'x'));
      const inside = runClean(project);
      expect(fs.existsSync(twinSentinel), inside.output).toBe(true);
      expect(inside.status, inside.output).not.toBe(0);
      expect(inside.output).toContain('nothing was deleted');
      expect(fs.existsSync(path.join(reportDir, 'mutations.xml'))).toBe(true);
    }, 300000);

    // #159: the tree is walked iteratively - a deep report tree neither
    // overflows the stack nor is refused.
    it('deletes a deeply nested report tree', () => {
      const project = path.join(tmpDir, 'project');
      fs.mkdirSync(project);
      seedGradleProject(project);
      const reportDir = path.join(project, 'build', 'reports', 'pitest');
      const deep = path.join(reportDir, ...Array.from({ length: 400 }, () => 'd'));
      writeFile(deep, 'leaf.xml', '<leaf/>');

      const result = runClean(project);

      expect(result.status, result.output).toBe(0);
      expect(fs.existsSync(reportDir)).toBe(false);
    }, 300000);

    it('contrast: deletes a normal reportDir, also when the project is reached through a link, and keeps build/reports', () => {
      const real = path.join(tmpDir, 'real');
      fs.mkdirSync(real);
      seedGradleProject(real);
      symlinkDirSync(real, path.join(tmpDir, 'via'));
      const project = path.join(tmpDir, 'via');
      writeFile(project, 'build/reports/pitest/mutations.xml', '<mutations/>');
      writeFile(project, 'build/reports/pitest/nested/index.html', '<html/>');
      writeFile(project, 'build/reports/other-tool.txt', 'keep');

      // Under the configuration cache too: the task action must not reach
      // project state at execution time.
      const result = runClean(project, ['--configuration-cache']);

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('empty scope');
      expect(result.output).toContain('Configuration cache entry stored');
      expect(fs.existsSync(path.join(real, 'build', 'reports', 'pitest'))).toBe(false);
      expect(fs.readFileSync(path.join(real, 'build', 'reports', 'other-tool.txt'), 'utf8')).toBe('keep');
    }, 300000);
  }
);
