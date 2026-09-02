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
const ARCHUNIT_TEMPLATE = path.join(
  REPO_ROOT,
  'stacks',
  'java-springboot',
  'lint',
  'archunit',
  'ArchitectureRulesTest.java'
);
// The ArchUnit template has @ArchTest rules that cannot run without a JVM +
// Gradle project, so it is verified manually (see the java-springboot lint
// README). These structural assertions are the automated backstop that catches
// accidental edits to the template's shape.
const EXPECTED_ARCHTEST_COUNT = 3;

// One entry per module group in checkstyle.xml. The execution test asserts
// every module name appears among the Violation.java findings, so a module
// that "looks right" but never fires cannot ship.
const GROUPS = {
  correctness: ['AvoidStarImport', 'RegexpSinglelineJava', 'EqualsHashCode'],
  'error-handling': ['EmptyCatchBlock', 'IllegalCatch'],
  // security reuses RegexpSinglelineJava (a second instance bans
  // Runtime.exec/ProcessBuilder) plus IllegalImport (sun.*).
  security: ['IllegalImport', 'RegexpSinglelineJava'],
  'dead-code': ['UnusedImports', 'RedundantImport', 'UnusedLocalVariable'],
  complexity: [
    'MethodLength',
    'CyclomaticComplexity',
    'ParameterNumber',
    'NestedIfDepth',
  ],
  hardcode: ['MagicNumber'],
};

// Flattened set of every module name any group claims, for the reverse
// (xml -> GROUPS) completeness check below. Structural modules are not part of
// any concern group. SuppressWarningsFilter/SuppressWarningsHolder (#117) are
// the line-level suppression wiring: they never themselves report a finding
// (a filter removes findings; a holder only records annotation state), so
// they cannot appear among the Violation.java findings the execution test
// asserts on and do not belong in GROUPS - they are structural like Checker/
// TreeWalker.
const STRUCTURAL_MODULES = new Set([
  'Checker',
  'TreeWalker',
  'SuppressWarningsFilter',
  'SuppressWarningsHolder',
]);
const KNOWN_MODULES = new Set(Object.values(GROUPS).flat());

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

  it('the documented group labels match GROUPS exactly', () => {
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

  // Reverse direction (QA M4): every module declared in the config must belong
  // to a known group. Adding a <module> to checkstyle.xml without updating
  // GROUPS (and thus the execution coverage) fails here, so the config can
  // never drift ahead of what the test actually verifies.
  it('every module declared in the config maps to a known group', () => {
    const declared = Array.from(
      xml.matchAll(/<module name="([^"]+)"/g),
      (m) => m[1]
    );
    const unmapped = Array.from(new Set(declared)).filter(
      (name) => !STRUCTURAL_MODULES.has(name) && !KNOWN_MODULES.has(name)
    );
    expect(
      unmapped,
      `these modules are in checkstyle.xml but not in any GROUPS entry: ` +
        `${unmapped.join(', ')} - add them to a group (and to the execution ` +
        `coverage) or they ship unverified`
    ).toEqual([]);
  });

  // Line-level suppression wiring (#117): SuppressWarningsFilter must sit
  // directly under Checker (it filters findings reported by TreeWalker, so it
  // cannot itself be inside TreeWalker), and SuppressWarningsHolder must sit
  // inside TreeWalker (it walks the syntax tree to record @SuppressWarnings
  // annotations, which only TreeWalker-scope modules can do). This is a
  // position check, not just a presence check, because a misplaced filter or
  // holder silently fails to wire the suppression mechanism together.
  it('SuppressWarningsFilter is under Checker and SuppressWarningsHolder is under TreeWalker (#117)', () => {
    const checkerOpen = xml.indexOf('<module name="Checker">');
    const treeWalkerOpen = xml.indexOf('<module name="TreeWalker">');
    const filterAt = xml.indexOf('<module name="SuppressWarningsFilter"/>');
    const holderAt = xml.indexOf('<module name="SuppressWarningsHolder"/>');

    expect(checkerOpen, 'Checker module not found').toBeGreaterThanOrEqual(0);
    expect(treeWalkerOpen, 'TreeWalker module not found').toBeGreaterThanOrEqual(0);
    expect(filterAt, 'SuppressWarningsFilter module not found').toBeGreaterThanOrEqual(0);
    expect(holderAt, 'SuppressWarningsHolder module not found').toBeGreaterThanOrEqual(0);

    expect(
      filterAt > checkerOpen && filterAt < treeWalkerOpen,
      'SuppressWarningsFilter must be declared under Checker, before TreeWalker opens'
    ).toBe(true);
    expect(
      holderAt > treeWalkerOpen,
      'SuppressWarningsHolder must be declared inside TreeWalker'
    ).toBe(true);
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

// --- ArchUnit template structural guard (QA M7) -------------------------------
// The ArchUnit rules need a JVM + a real Spring Boot project to execute, so
// they are verified manually and cannot be run here. These structural checks
// are the automated backstop: if an edit breaks the template's placeholder,
// its ArchUnit imports, or the expected rule count, this fails - so the README
// claim that the template ships in a known shape stays honest.
describe('ArchUnit template shape (always runs)', () => {
  const java = fs.readFileSync(ARCHUNIT_TEMPLATE, 'utf8');

  it('still uses the __BASE_PACKAGE__ placeholder', () => {
    expect(
      java,
      'template must keep __BASE_PACKAGE__ so the scaffolding step can substitute it'
    ).toContain('__BASE_PACKAGE__');
  });

  it('imports the ArchUnit library', () => {
    expect(java).toMatch(/import\s+com\.tngtech\.archunit\./);
  });

  it(`declares exactly ${EXPECTED_ARCHTEST_COUNT} @ArchTest rules`, () => {
    // Match the annotation on a rule field (`@ArchTest\n static final ...`),
    // not the `{@code @ArchTest}` mention in the class Javadoc.
    const archTests = (java.match(/@ArchTest\s+static\b/g) || []).length;
    expect(
      archTests,
      `expected ${EXPECTED_ARCHTEST_COUNT} @ArchTest rule fields; found ${archTests}`
    ).toBe(EXPECTED_ARCHTEST_COUNT);
  });

  it('is annotated for analysis and excludes tests', () => {
    expect(java).toMatch(/@AnalyzeClasses\s*\(/);
    expect(java).toContain('ImportOption.DoNotIncludeTests');
  });
});
