const fs = require('fs');
const os = require('os');
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
// Never `npx` (which, outside this repo or with a broken install, silently
// downloads the UNRELATED "ast-grep@0.1.0" npm package). Resolution order
// (#160 - the same order the lint-scaffolding SKILL documents for products):
//   (1) the platform package's native binary
//       (`@ast-grep/cli-win32-x64-msvc/ast-grep.exe` and so on);
//   (2) `@ast-grep/cli/ast-grep` - a JS shim with a node shebang, run through
//       process.execPath. On Windows npm never replaces it with the binary,
//       so this is how an install without any `.exe` next to it still runs;
//       when postinstall did replace it (Unix), it is run directly;
//   (3) Windows only: `node_modules/.bin/ast-grep.cmd` through `cmd /c`.
// require.resolve works on these subpaths because the packages declare no
// "exports" field. `root` / `platform` / `arch` are injectable so the order
// itself is tested below against throwaway install layouts.
const AST_GREP_PLATFORM_PACKAGES = {
  'win32-x64': '@ast-grep/cli-win32-x64-msvc',
  'win32-arm64': '@ast-grep/cli-win32-arm64-msvc',
  'win32-ia32': '@ast-grep/cli-win32-ia32-msvc',
  'darwin-x64': '@ast-grep/cli-darwin-x64',
  'darwin-arm64': '@ast-grep/cli-darwin-arm64',
  // glibc builds only; on musl these do not run, so (1) is skipped there.
  'linux-x64': '@ast-grep/cli-linux-x64-gnu',
  'linux-arm64': '@ast-grep/cli-linux-arm64-gnu',
};

function isGlibc() {
  try {
    return Boolean(process.report.getReport().header.glibcVersionRuntime);
  } catch {
    return false;
  }
}

// A file that starts with "#!" is a script (the JS shim), not the binary.
function isScript(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
  return head.toString('latin1') === '#!';
}

function resolveAstGrepCommand({
  root = REPO_ROOT,
  platform = process.platform,
  arch = process.arch,
  glibc = platform === 'linux' ? isGlibc() : false,
} = {}) {
  const tryResolve = (id) => {
    try {
      return require.resolve(id, { paths: [root] });
    } catch {
      return null;
    }
  };
  const pkg = AST_GREP_PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (pkg && (platform !== 'linux' || glibc)) {
    const manifest = tryResolve(`${pkg}/package.json`);
    if (manifest) {
      const binary = path.join(
        path.dirname(manifest),
        platform === 'win32' ? 'ast-grep.exe' : 'ast-grep'
      );
      if (fs.existsSync(binary)) return { kind: 'native', file: binary, prefix: [] };
    }
  }
  const shim = tryResolve('@ast-grep/cli/ast-grep');
  if (shim) {
    return isScript(shim)
      ? { kind: 'shim', file: process.execPath, prefix: [shim] }
      : { kind: 'native', file: shim, prefix: [] };
  }
  if (platform === 'win32') {
    const cmd = path.join(root, 'node_modules', '.bin', 'ast-grep.cmd');
    if (fs.existsSync(cmd)) return { kind: 'cmd', file: cmd, prefix: [] };
  }
  return null;
}

// Turns a resolved command plus arguments into execFileSync's (file, args,
// options). A `.cmd` cannot be spawned directly (Node refuses since the
// CVE-2024-27980 fix), so it goes through `cmd.exe /d /s /c "<line>"` with
// verbatim arguments; every argument is quoted, and characters cmd would
// still interpret inside quotes are refused rather than escaped. Trailing
// backslashes are doubled so the CRT argument parser does not read the
// closing quote as \" (`"C:\dir\"` would otherwise swallow the next
// argument). Without ComSpec, cmd.exe is taken from System32 by absolute
// path - never a PATH / cwd lookup, which a planted cmd.exe could hijack.
function astGrepInvocation(command, args) {
  if (command.kind !== 'cmd') {
    return { file: command.file, args: [...command.prefix, ...args], options: {} };
  }
  const parts = [command.file, ...args].map((arg) => {
    if (/["%!\r\n]/.test(arg)) {
      throw new Error(`refusing to pass ${JSON.stringify(arg)} through cmd.exe`);
    }
    return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
  });
  return {
    file:
      process.env.ComSpec ||
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', `"${parts.join(' ')}"`],
    options: { windowsVerbatimArguments: true },
  };
}

const astGrepCommand = resolveAstGrepCommand();
const astGrepResolveError = astGrepCommand
  ? null
  : new Error(
      'none of the platform binary, @ast-grep/cli/ast-grep, or ' +
        'node_modules/.bin/ast-grep.cmd could be resolved from ' +
        REPO_ROOT
    );

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
  const { file, args, options } = astGrepInvocation(astGrepCommand, [
    'scan',
    '--rule',
    ruleFile,
    '--json=compact',
    targetFile,
  ]);
  let stdout;
  try {
    stdout = execFileSync(file, args, {
      ...options,
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

// Resolution order (#160): exercised against throwaway install layouts, so the
// Windows branches are covered on every OS, and against the real install, so
// the windows-latest CI job proves the shim-only route actually runs there.
describe('ast-grep CLI resolution order (#160)', () => {
  let tmp;

  beforeEach(() => {
    // realpath: require.resolve returns real paths, and the macOS tmpdir
    // (/var/folders/...) is a symlink to /private/var/folders/...
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grep-resolve-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel, content) {
    const file = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  const SHIM = '#!/usr/bin/env node\n';
  const BINARY = 'MZ not a script';

  it('Windows without any ast-grep.exe: runs the JS shim through node', () => {
    const shim = write('node_modules/@ast-grep/cli/ast-grep', SHIM);
    write('node_modules/.bin/ast-grep.cmd', '@ECHO off\n');
    expect(resolveAstGrepCommand({ root: tmp, platform: 'win32', arch: 'x64' })).toEqual({
      kind: 'shim',
      file: process.execPath,
      prefix: [shim],
    });
  });

  it('prefers the platform package binary over the shim', () => {
    write('node_modules/@ast-grep/cli/ast-grep', SHIM);
    write('node_modules/@ast-grep/cli-win32-x64-msvc/package.json', '{}');
    const exe = write('node_modules/@ast-grep/cli-win32-x64-msvc/ast-grep.exe', BINARY);
    expect(resolveAstGrepCommand({ root: tmp, platform: 'win32', arch: 'x64' })).toEqual({
      kind: 'native',
      file: exe,
      prefix: [],
    });
  });

  it('skips a platform package that has no binary in it', () => {
    const shim = write('node_modules/@ast-grep/cli/ast-grep', SHIM);
    write('node_modules/@ast-grep/cli-win32-x64-msvc/package.json', '{}');
    expect(resolveAstGrepCommand({ root: tmp, platform: 'win32', arch: 'x64' }).prefix).toEqual([shim]);
  });

  it('skips the glibc package on musl Linux and runs a postinstall-replaced binary directly', () => {
    write('node_modules/@ast-grep/cli-linux-x64-gnu/package.json', '{}');
    write('node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep', BINARY);
    const replaced = write('node_modules/@ast-grep/cli/ast-grep', BINARY);
    expect(
      resolveAstGrepCommand({ root: tmp, platform: 'linux', arch: 'x64', glibc: false })
    ).toEqual({ kind: 'native', file: replaced, prefix: [] });
  });

  it('falls back to node_modules/.bin/ast-grep.cmd on Windows only', () => {
    const cmd = write('node_modules/.bin/ast-grep.cmd', '@ECHO off\n');
    expect(resolveAstGrepCommand({ root: tmp, platform: 'win32', arch: 'x64' })).toEqual({
      kind: 'cmd',
      file: cmd,
      prefix: [],
    });
    expect(resolveAstGrepCommand({ root: tmp, platform: 'linux', arch: 'x64', glibc: true })).toBeNull();
  });

  it('returns null when nothing is installed (the suite then fails, never skips)', () => {
    expect(resolveAstGrepCommand({ root: tmp, platform: 'win32', arch: 'x64' })).toBeNull();
  });

  it('passes .cmd arguments to cmd.exe quoted and verbatim, and refuses ones cmd would expand', () => {
    const invocation = astGrepInvocation({ kind: 'cmd', file: 'C:\\a b\\ast-grep.cmd', prefix: [] }, [
      'scan',
      'C:\\x y\\r.yml',
    ]);
    expect(invocation.args).toEqual(['/d', '/s', '/c', '""C:\\a b\\ast-grep.cmd" "scan" "C:\\x y\\r.yml""']);
    expect(invocation.options).toEqual({ windowsVerbatimArguments: true });
    expect(() => astGrepInvocation({ kind: 'cmd', file: 'a.cmd', prefix: [] }, ['%PATH%'])).toThrow(/refusing/);
  });

  it('doubles trailing backslashes so a .cmd argument cannot swallow its closing quote', () => {
    const invocation = astGrepInvocation({ kind: 'cmd', file: 'a.cmd', prefix: [] }, [
      'C:\\dir\\',
      'C:\\two\\\\',
      'C:\\mid\\x',
    ]);
    expect(invocation.args[3]).toBe('""a.cmd" "C:\\dir\\\\" "C:\\two\\\\\\\\" "C:\\mid\\x""');
  });

  it('uses an absolute System32 cmd.exe when ComSpec is unset (no PATH / cwd lookup)', () => {
    const saved = { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot };
    const cmd = { kind: 'cmd', file: 'a.cmd', prefix: [] };
    try {
      delete process.env.ComSpec;
      process.env.SystemRoot = 'D:\\Win';
      expect(astGrepInvocation(cmd, []).file).toBe(path.join('D:\\Win', 'System32', 'cmd.exe'));
      delete process.env.SystemRoot;
      expect(astGrepInvocation(cmd, []).file).toBe(path.join('C:\\Windows', 'System32', 'cmd.exe'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // Each suppression guard carries its own copy of the annotation matcher (a
  // rule file cannot import another file's utils). Drift between the copies
  // would reopen #160 in one rule only.
  it('the three suppression guards carry an identical suppress-warnings-annotation util', () => {
    const dir = path.join(REPO_ROOT, 'shared', 'lint', 'ast-grep', 'error-handling');
    const blocks = [
      'no-blanket-suppress-warnings-java.yml',
      'no-non-literal-suppress-warnings-java.yml',
      'no-type-scope-illegal-catch-suppression-java.yml',
    ].map((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      const match = /^utils:\n([\s\S]*?)^rule:/m.exec(text);
      expect(match, `${name} must declare utils: before rule:`).toBeTruthy();
      expect(match[1]).toContain('  suppress-warnings-annotation:\n');
      return match[1];
    });
    expect(blocks[1]).toBe(blocks[0]);
    expect(blocks[2]).toBe(blocks[0]);
  });

  it('the real install runs through the JS shim alone (the route a Windows install without .exe takes)', () => {
    const shim = require.resolve('@ast-grep/cli/ast-grep');
    if (process.platform === 'win32') {
      // npm keeps the shim on Windows (its global wrappers call it through node).
      expect(isScript(shim), 'on Windows @ast-grep/cli/ast-grep must stay the JS shim').toBe(true);
    }
    if (!isScript(shim)) return; // Unix with postinstall: the shim became the binary
    const out = execFileSync(process.execPath, [shim, '--version'], { encoding: 'utf8', timeout: 30000 });
    expect(out).toMatch(/ast-grep \d+\.\d+\.\d+/);
  });

  it.skipIf(process.platform !== 'win32')(
    'the real install runs through node_modules/.bin/ast-grep.cmd on Windows',
    () => {
      const cmd = path.join(REPO_ROOT, 'node_modules', '.bin', 'ast-grep.cmd');
      const { file, args, options } = astGrepInvocation({ kind: 'cmd', file: cmd, prefix: [] }, ['--version']);
      const out = execFileSync(file, args, { ...options, encoding: 'utf8', timeout: 30000 });
      expect(out).toMatch(/ast-grep \d+\.\d+\.\d+/);
    }
  );
});

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
    expect(astGrepCommand).toBeTruthy();
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
