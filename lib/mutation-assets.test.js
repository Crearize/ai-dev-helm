const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

// Meta test for the shipped mutation-testing assets.
//
// Two layers, same contract as lib/checkstyle-assets.test.js and
// lib/eslint-assets.test.js:
//   - Structural checks (always run): the shipped Stryker config is a loadable
//     ESM module with the shape quality-check depends on. Needs no Stryker
//     install - just imports the config file.
//   - Gated smoke test (STRYKER_SMOKE=1): runs the REAL Stryker CLI against a
//     minimal sample project (test/fixtures/mutation/stryker-sample) and
//     asserts a json report with a finite, numeric mutation score is produced.
//     A config that "looks right" but never computes a score cannot ship.
//
// Stryker + its vitest runner are NOT harness-root devDependencies (they would
// pull a large tree into every install); they live in the sample fixture's own
// package.json. So the execution half is gated on STRYKER_SMOKE, and the sample
// must have its deps installed (`npm install` in the sample dir) before the
// gate is enabled. Verified against @stryker-mutator/core 9.x / Node 22:
// 24 mutants, 18 killed / 6 survived, score 75.00%.

const REPO_ROOT = path.resolve(__dirname, '..');

// --- Stryker (nextjs-react) structural checks -------------------------------

const STRYKER_CONFIG_PATH = path.join(
  REPO_ROOT,
  'stacks',
  'nextjs-react',
  'lint',
  'mutation',
  'stryker.config.mjs'
);

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

  it('does NOT set thresholds.break (gating is quality-check\'s job, not Stryker\'s)', () => {
    // thresholds may be present (report coloring hints) but break must be unset
    // so Stryker never fails the run on score.
    const thresholds = config.thresholds || {};
    expect(
      'break' in thresholds ? thresholds.break : undefined,
      'thresholds.break must be left unset - the mutation-score gate lives in ' +
        'quality-policy.md and is applied by quality-check, not by Stryker'
    ).toBeUndefined();
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
        const mutantCount = Object.values(report.files || {}).reduce(
          (sum, file) => sum + (file.mutants ? file.mutants.length : 0),
          0
        );
        expect(mutantCount, 'Stryker must generate at least one mutant').toBeGreaterThan(0);

        // The score is a real, finite number.
        const score = mutationScoreFromReport(report);
        expect(Number.isFinite(score), `mutation score must be finite; got ${score}`).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
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
// structure so it cannot silently drift out of that verified shape.

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

  beforeAll(() => {
    try {
      source = fs.readFileSync(PITEST_GRADLE_PATH, 'utf8');
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

  it("does NOT set mutationThreshold (gating is quality-check's job, not PIT's)", () => {
    // The word may appear in an explanatory comment; what must NOT exist is an
    // actual `mutationThreshold = <value>` assignment. Strip line comments first
    // so a comment mention never trips this, then look for the assignment.
    const withoutLineComments = source.replace(/\/\/.*$/gm, '');
    expect(
      /mutationThreshold\s*=/.test(withoutLineComments),
      'mutationThreshold must be left unset - the mutation-score gate lives in ' +
        'quality-policy.md and is applied by quality-check, not by PIT'
    ).toBe(false);
  });
});
