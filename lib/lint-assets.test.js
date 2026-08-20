const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Meta smoke test for shipped ast-grep lint assets.
//
// Guarantee: every rule YAML we ship has been EXECUTED against real fixtures:
//   - violation fixture => >= 1 finding (no false negative)
//   - ok fixture        => 0 findings   (no false positive)
// A rule that "looks right" but never ran is the failure mode this prevents.

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'ast-grep');

// --- ast-grep binary resolution -------------------------------------------
// @ast-grep/cli ships a Node JS shim at the package root ("ast-grep" with a
// node shebang) that spawns the platform-native binary. Running that shim via
// process.execPath works on every OS including Windows, and avoids `npx`
// (which, outside this repo or with a broken install, silently downloads the
// UNRELATED "ast-grep@0.1.0" npm package). require.resolve works because the
// package declares no "exports" field.
let astGrepShim = null;
let astGrepResolveError = null;
try {
  astGrepShim = require.resolve('@ast-grep/cli/ast-grep');
} catch (err) {
  astGrepResolveError = err;
}

const EXT_BY_LANGUAGE = {
  typescript: '.ts',
  tsx: '.tsx',
  javascript: '.js',
  java: '.java',
  kotlin: '.kt',
  python: '.py',
};

function walkYamlFiles(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkYamlFiles(full, acc);
    } else if (/\.ya?ml$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function collectRuleFiles() {
  const files = [];
  // Generic, stack-independent rules.
  walkYamlFiles(path.join(REPO_ROOT, 'shared', 'lint', 'ast-grep'), files);
  // Stack-specific rules (stacks/*/lint/ast-grep). Empty today; this picks
  // them up automatically as soon as a stack ships rule files.
  const stacksDir = path.join(REPO_ROOT, 'stacks');
  if (fs.existsSync(stacksDir)) {
    for (const entry of fs.readdirSync(stacksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      walkYamlFiles(path.join(stacksDir, entry.name, 'lint', 'ast-grep'), files);
    }
  }
  return files.sort();
}

// Minimal extraction of the flat top-level `key: value` scalar fields we
// validate (id/language/message/severity). Intentionally line-based: we do
// not want a YAML parser dependency just for this, and rule authors keep
// these four fields as plain top-level scalars.
function parseTopLevelScalars(content) {
  const fields = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]+(\S.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

// Runs ast-grep with exactly one rule file against exactly one target file
// and returns the parsed JSON match array. ast-grep exits 1 when a rule with
// severity error matched, so exit code 1 with parseable JSON is success.
function runAstGrep(ruleFile, targetFile) {
  const args = [astGrepShim, 'scan', '--rule', ruleFile, '--json=compact', targetFile];
  let stdout;
  try {
    stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const out = typeof err.stdout === 'string' ? err.stdout : '';
    if (out.trim().startsWith('[')) {
      stdout = out; // exit code 1 = findings reported; still valid JSON
    } else {
      const stderr = typeof err.stderr === 'string' ? err.stderr : '';
      throw new Error(
        `ast-grep failed for rule ${ruleFile}:\n${stderr || err.message}`
      );
    }
  }
  return JSON.parse(stdout);
}

function findFixture(fixtureDir, stem) {
  if (!fs.existsSync(fixtureDir)) return [];
  return fs
    .readdirSync(fixtureDir)
    .filter((name) => name.startsWith(`${stem}.`))
    .map((name) => path.join(fixtureDir, name));
}

// Counts the `// Violation N:` markers a violation fixture uses to label each
// distinct case it exercises. The rule must fire once per marked case, so the
// marker count is the expected finding count. This turns the smoke test into a
// completeness check: a rule that catches 1 of 3 marked cases (a partial
// regression) now fails instead of staying green on a single lucky hit.
function countViolationMarkers(content) {
  const matches = content.match(/\/\/\s*Violation\b/g);
  return matches ? matches.length : 0;
}

const ruleFiles = collectRuleFiles();

describe('ast-grep lint assets (meta smoke test)', () => {
  it('ast-grep CLI is installed (this suite must never silently skip)', () => {
    if (astGrepResolveError) {
      throw new Error(
        '@ast-grep/cli is not installed - run `npm install`. ' +
          'This test is the false-negative guard for shipped lint assets ' +
          'and must not be skipped.\n' +
          astGrepResolveError.message
      );
    }
    expect(astGrepShim).toBeTruthy();
  });

  it('finds at least one shipped rule file (empty glob must fail, not pass)', () => {
    expect(ruleFiles.length).toBeGreaterThan(0);
  });

  for (const ruleFile of ruleFiles) {
    const relPath = path.relative(REPO_ROOT, ruleFile).replace(/\\/g, '/');
    const stem = path.basename(ruleFile).replace(/\.ya?ml$/, '');
    const fixtureDir = path.join(FIXTURE_ROOT, stem);

    describe(relPath, () => {
      const content = fs.readFileSync(ruleFile, 'utf8');
      const fields = parseTopLevelScalars(content);

      it('declares id, language, message, severity; id matches filename', () => {
        expect(fields.id, 'missing top-level id').toBeTruthy();
        expect(fields.language, 'missing top-level language').toBeTruthy();
        expect(fields.message, 'missing top-level message').toBeTruthy();
        expect(fields.severity, 'missing top-level severity').toBeTruthy();
        expect(fields.id).toBe(stem);
      });

      const expectedExt = fields.language
        ? EXT_BY_LANGUAGE[fields.language.toLowerCase()]
        : undefined;
      const violations = findFixture(fixtureDir, 'violation');
      const oks = findFixture(fixtureDir, 'ok');

      it('has violation.* and ok.* fixtures matching the rule language', () => {
        expect(
          expectedExt,
          `unknown language "${fields.language}" - extend EXT_BY_LANGUAGE`
        ).toBeTruthy();
        expect(
          violations,
          `expected exactly one ${path.join('test/fixtures/ast-grep', stem, 'violation' + (expectedExt || '.*'))}`
        ).toHaveLength(1);
        expect(
          oks,
          `expected exactly one ${path.join('test/fixtures/ast-grep', stem, 'ok' + (expectedExt || '.*'))}`
        ).toHaveLength(1);
        expect(path.extname(violations[0])).toBe(expectedExt);
        expect(path.extname(oks[0])).toBe(expectedExt);
      });

      it('detects one finding per `// Violation N:` case (no false negative, no partial regression)', () => {
        expect(violations).toHaveLength(1);
        const fixtureText = fs.readFileSync(violations[0], 'utf8');
        const markerCount = countViolationMarkers(fixtureText);
        const matches = runAstGrep(ruleFile, violations[0]);
        expect(
          matches.length,
          `rule ${stem} produced NO findings on its violation fixture - the rule does not actually fire`
        ).toBeGreaterThan(0);
        // Every violation fixture must label each case with `// Violation N:`
        // and the rule must fire exactly once per case. This is what makes a
        // partial regression (rule stops catching one of several cases) fail.
        expect(
          markerCount,
          `violation fixture for ${stem} has no \`// Violation N:\` markers - ` +
            'label each case so partial regressions are detectable'
        ).toBeGreaterThan(0);
        expect(
          matches.length,
          `rule ${stem} matched ${matches.length} case(s) but its violation ` +
            `fixture marks ${markerCount} - it misses a case or double-counts one`
        ).toBe(markerCount);
        for (const match of matches) {
          expect(match.ruleId).toBe(stem);
        }
      });

      it('detects 0 findings in the ok fixture (no false positive)', () => {
        expect(oks).toHaveLength(1);
        const matches = runAstGrep(ruleFile, oks[0]);
        expect(
          matches,
          `rule ${stem} flagged conforming code in its ok fixture`
        ).toHaveLength(0);
      });
    });
  }
});
