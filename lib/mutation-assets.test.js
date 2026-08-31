const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync, spawnSync } = require('child_process');

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
  fs.symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(dir, 'app', 'node_modules'),
    'dir'
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

describe('changed-ranges.mjs (diff scope for mutation:diff)', () => {
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('resolves the default base ref by probing origin/main and fails loudly when no base exists', () => {
    const g = seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    expect(helper.resolveBaseRef({ cwd })).toBe('origin/main');

    g('update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => helper.resolveBaseRef({ cwd })).toThrow(/no base ref found/);
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

  it('withChangedLines narrows mutate, disables incremental, and refuses a config without explicit mutate globs', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    const scoped = helper.withChangedLines(baseConfig, { cwd, baseRef: 'main' });
    expect([...scoped.mutate].sort()).toEqual([...EXPECTED_DIFF_RANGES].sort());
    // Everything else is inherited from the base config untouched - except
    // incremental, which is full-run state and must not leak into the diff
    // run's report.
    expect(scoped.testRunner).toBe(baseConfig.testRunner);
    expect(scoped.mutator).toEqual(baseConfig.mutator);
    expect(scoped.incremental).toBe(false);

    expect(() => helper.withChangedLines({}, { cwd, baseRef: 'main' })).toThrow(
      /must define explicit `mutate` globs/
    );
  });

  // The diff config is what a product actually runs (`stryker run
  // lint/mutation/stryker.diff.config.mjs`). It resolves the base ref from
  // MUTATION_BASE_REF (default: origin/main probing) and exits the process on
  // an empty scope, so it is exercised in a child process rather than
  // imported into this worker.
  const loadDiffConfigIn = (cwd, baseRef) => {
    const { MUTATION_BASE_REF: _drop, ...env } = process.env;
    if (baseRef !== undefined) env.MUTATION_BASE_REF = baseRef;
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const mod = await import(process.argv[1]); console.log(JSON.stringify(mod.default));',
        '--',
        pathToFileURL(path.join(cwd, 'lint', 'mutation', 'stryker.diff.config.mjs')).href,
      ],
      { cwd, encoding: 'utf8', env }
    );
  };

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
    // quality-check would read yesterday's mutants as today's.
    writeFile(cwd, 'reports/mutation/mutation.json', '{"files":{}}');

    const result = loadDiffConfigIn(cwd, 'HEAD');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('empty scope');
    // process.exit(0) inside the config: the importing script never prints.
    expect(result.stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(cwd, 'reports', 'mutation', 'mutation.json'))).toBe(false);
  });

  it('stryker.diff.config.mjs fails loudly (nonzero) when the scope cannot be derived', () => {
    seedDiffRepo(tmpDir);
    const cwd = path.join(tmpDir, 'app');

    const result = loadDiffConfigIn(cwd, 'no-such-ref');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot resolve the merge base');
  });
});

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
      { timeout: 180000 },
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
          fs.symlinkSync(
            path.join(SAMPLE_DIR, 'node_modules'),
            path.join(repo, 'node_modules'),
            'dir'
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
            { cwd: repo, encoding: 'utf8', timeout: 180000, stdio: 'pipe', env }
          );
          const fullReport = JSON.parse(
            fs.readFileSync(path.join(repo, 'reports', 'mutation', 'mutation.json'), 'utf8')
          );
          expect(
            allMutants(fullReport).filter((m) => m.status !== 'Ignored').length,
            'the full run must score more than the single changed line'
          ).toBeGreaterThan(4);

          execFileSync(
            process.execPath,
            [STRYKER_BIN, 'run', 'lint/mutation/stryker.diff.config.mjs'],
            {
              cwd: repo,
              encoding: 'utf8',
              timeout: 180000,
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
});
