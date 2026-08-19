const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Meta test for the shipped Checkstyle asset
// (stacks/java-springboot/lint/checkstyle/checkstyle.xml).
//
// Guarantee (same contract as lib/lint-assets.test.js and
// lib/eslint-assets.test.js): the config has been EXECUTED with the real
// Checkstyle CLI against a violating fixture (every module fires - no false
// negatives) and a conforming fixture (zero findings - no false positives).
//
// Checkstyle needs a JVM + the all-in-one JAR, which are not npm-installable,
// so the execution half of this suite is gated on CHECKSTYLE_JAR (path to
// checkstyle-X.Y.Z-all.jar from
// https://github.com/checkstyle/checkstyle/releases). The static half always
// runs. Verified against Checkstyle 14.0.0 / Java 21.

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(
  REPO_ROOT,
  'stacks',
  'java-springboot',
  'lint',
  'checkstyle',
  'checkstyle.xml'
);
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'checkstyle');

// One entry per module group in checkstyle.xml. The execution test asserts
// every module name appears among the Violation.java findings, so a module
// that "looks right" but never fires cannot ship.
const GROUPS = {
  correctness: ['AvoidStarImport', 'RegexpSinglelineJava', 'EqualsHashCode'],
  'error-handling': ['EmptyCatchBlock', 'IllegalCatch'],
  'dead-code': ['UnusedImports', 'RedundantImport', 'UnusedLocalVariable'],
  complexity: [
    'MethodLength',
    'CyclomaticComplexity',
    'ParameterNumber',
    'NestedIfDepth',
  ],
  hardcode: ['MagicNumber'],
};

// --- unconditional static checks ---------------------------------------------

describe('checkstyle.xml static shape (always runs)', () => {
  const xml = fs.readFileSync(CONFIG_PATH, 'utf8');

  it('is well-formed enough: XML declaration, DOCTYPE, Checker root', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toMatch(/<!DOCTYPE module PUBLIC/);
    expect(xml).toMatch(/<module name="Checker">/);
    expect(xml).toMatch(/<module name="TreeWalker">/);
    expect(xml).toMatch(/<\/module>\s*$/);
    // Every <module ...> opens with a matched close (self-closing or paired).
    const opens = (xml.match(/<module name="/g) || []).length;
    const closes =
      (xml.match(/<\/module>/g) || []).length +
      (xml.match(/<module name="[^"]*"\s*\/>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('declares UTF-8 charset on the Checker', () => {
    expect(xml).toMatch(
      /<property name="charset" value="UTF-8"\s*\/>/
    );
  });

  it('carries exactly the five documented group labels', () => {
    const labels = Array.from(
      xml.matchAll(/<!--\s*group:\s*([a-z-]+)/g),
      (m) => m[1]
    );
    expect(labels.sort()).toEqual(Object.keys(GROUPS).sort());
  });

  it('every asserted module name is declared in the config', () => {
    for (const modules of Object.values(GROUPS)) {
      for (const name of modules) {
        expect(
          xml,
          `module ${name} must be declared in checkstyle.xml`
        ).toContain(`<module name="${name}"`);
      }
    }
  });
});

// --- gated execution suite ----------------------------------------------------

const JAR = process.env.CHECKSTYLE_JAR;

describe.skipIf(!JAR)(
  JAR
    ? 'checkstyle execution against fixtures'
    : 'checkstyle execution (skipped: set CHECKSTYLE_JAR=<path to checkstyle-all.jar> to run)',
  () => {
    let lines = null;

    function run() {
      if (lines) {
        return lines;
      }
      let stdout;
      try {
        stdout = execFileSync(
          'java',
          ['-jar', JAR, '-c', CONFIG_PATH, FIXTURE_DIR],
          { encoding: 'utf8', timeout: 60000 }
        );
      } catch (err) {
        // Checkstyle exits non-zero when [ERROR] findings exist - expected
        // for Violation.java. A missing stdout means java itself failed.
        if (typeof err.stdout !== 'string' || err.stdout.length === 0) {
          throw err;
        }
        stdout = err.stdout;
      }
      lines = stdout.split(/\r?\n/).filter((l) => /^\[(ERROR|WARN)\]/.test(l));
      return lines;
    }

    it(
      'Violation.java triggers every module of every group',
      { timeout: 60000 },
      () => {
        const findings = run().filter((l) => l.includes('Violation.java'));
        expect(findings.length).toBeGreaterThan(0);
        for (const [group, modules] of Object.entries(GROUPS)) {
          for (const name of modules) {
            expect(
              findings.some((l) => l.includes(`[${name}]`)),
              `group ${group}: module ${name} must fire on Violation.java; ` +
                `got:\n${findings.join('\n')}`
            ).toBe(true);
          }
        }
      }
    );

    it(
      'Ok.java yields zero findings (errors and warnings)',
      { timeout: 60000 },
      () => {
        const findings = run().filter((l) => l.includes('Ok.java'));
        expect(
          findings,
          `Ok.java must be clean; got:\n${findings.join('\n')}`
        ).toEqual([]);
      }
    );
  }
);
