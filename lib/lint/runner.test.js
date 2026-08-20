const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { runLint } = require('./runner');
const { checks: registry } = require('./checks');

const CLI_PATH = path.join(__dirname, '..', '..', 'bin', 'cli.js');

describe('lint runner', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-runner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a file under tmpDir, creating parent directories */
  function write(relPath, content) {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  // Turn tmpDir into a git repo (same pattern as scan.test.js). Also
  // sandboxes the config search: findConfigFile stops at the git root.
  const initRepo = () => {
    const g = (...args) =>
      execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
        cwd: tmpDir,
        encoding: 'utf8',
      }).trim();
    g('init', '-b', 'main');
    g('config', 'core.autocrlf', 'false');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    return g;
  };

  describe('runLint', () => {
    it('reports file-scope violations with exitCode 1 and formatted output', () => {
      initRepo();
      write('src/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({ dir: tmpDir });

      expect(result.exitCode).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        file: 'src/app.js',
        line: 1,
        check: 'secrets',
      });
      expect(result.output).toContain(
        'src/app.js:1 [secrets] hardcoded secret (generic-credential) (Catalog: B1)'
      );
      expect(result.output).toContain('1 problem(s) found');
    });

    it('returns exitCode 0 and No problems found on a clean tree', () => {
      initRepo();
      write('src/app.js', 'const x = 1;\n');

      const result = runLint({ dir: tmpDir });

      expect(result.exitCode).toBe(0);
      expect(result.violations).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.output).toContain('No problems found');
    });

    it('a check disabled via the config file produces no violations', () => {
      initRepo();
      write(
        '.ai-dev-helm-lint.json',
        JSON.stringify({ checks: { secrets: { enabled: false } } })
      );
      write('src/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({ dir: tmpDir });

      expect(result.violations.filter((v) => v.check === 'secrets')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });

    it('honors an explicit configPath', () => {
      initRepo();
      const cfg = write(
        'custom-lint.json',
        JSON.stringify({
          exclude: ['custom-lint.json'],
          checks: { secrets: { enabled: false } },
        })
      );
      write('src/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({ dir: tmpDir, configPath: cfg });

      expect(result.violations.filter((v) => v.check === 'secrets')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });

    it('missing explicit configPath yields exitCode 2', () => {
      initRepo();

      const result = runLint({
        dir: tmpDir,
        configPath: path.join(tmpDir, 'nope.json'),
      });

      expect(result.exitCode).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toMatch(/not found/);
      expect(result.violations).toEqual([]);
    });

    it('broken config JSON yields exitCode 2 and runs nothing', () => {
      initRepo();
      write('.ai-dev-helm-lint.json', '{ broken');
      write('src/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({ dir: tmpDir });

      expect(result.exitCode).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toMatch(/Failed to parse/);
      expect(result.violations).toEqual([]);
    });

    it('only filter restricts execution to the named checks', () => {
      initRepo();
      write(
        'src/app.js',
        'const password = "hunter2secret";\n// TODO fix this\n'
      );

      const result = runLint({ dir: tmpDir, only: ['todo-deadline'] });

      expect(result.exitCode).toBe(1);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.every((v) => v.check === 'todo-deadline')).toBe(
        true
      );
    });

    it('an explicit only overrides a default-disabled check (no silent no-op)', () => {
      // branch-naming is defaultEnabled: false; naming it explicitly must run it.
      const g = initRepo();
      write('src/app.js', 'const x = 1;\n');
      g('add', '.');
      g('commit', '-m', 'init');
      g('checkout', '-b', 'Bad_Branch_Name');

      const result = runLint({ dir: tmpDir, only: ['branch-naming'] });

      expect(result.violations.some((v) => v.check === 'branch-naming')).toBe(
        true
      );
    });

    it('unknown names in only yield exitCode 2 naming them', () => {
      initRepo();
      write('src/app.js', 'const x = 1;\n');

      const result = runLint({ dir: tmpDir, only: ['secrets', 'nope'] });

      expect(result.exitCode).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('nope');
      expect(result.violations).toEqual([]);
    });

    it('config warnings surface with warning: prefix, not as errors', () => {
      initRepo();
      write(
        '.ai-dev-helm-lint.json',
        JSON.stringify({ checks: { 'not-a-check': { enabled: false } } })
      );
      write('src/app.js', 'const x = 1;\n');

      const result = runLint({ dir: tmpDir });

      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('not-a-check');
      expect(result.output).toContain('warning:');
    });

    it('fail-closed: a throwing check records one error, exitCode 2, others still run', () => {
      initRepo();
      write('src/app.js', 'const password = "hunter2secret";\nconst y = 2;\n');
      write('src/other.js', 'const z = 3;\n');
      const fakeFile = {
        name: 'boom-file',
        defaultEnabled: true,
        scope: 'file',
        run() {
          throw new Error('kaput');
        },
      };
      const fakeRepo = {
        name: 'boom-repo',
        defaultEnabled: true,
        scope: 'repo',
        run() {
          throw new Error('busted');
        },
      };
      registry.push(fakeFile, fakeRepo);

      let result;
      try {
        result = runLint({ dir: tmpDir });
      } finally {
        registry.splice(registry.indexOf(fakeFile), 1);
        registry.splice(registry.indexOf(fakeRepo), 1);
      }

      expect(result.exitCode).toBe(2);
      expect(
        result.errors.filter((e) => e === "check 'boom-file' failed: kaput")
      ).toHaveLength(1);
      expect(
        result.errors.filter((e) => e === "check 'boom-repo' failed: busted")
      ).toHaveLength(1);
      // the healthy checks still produced their violations
      expect(
        result.violations.some(
          (v) => v.check === 'secrets' && v.file === 'src/app.js'
        )
      ).toBe(true);
    });

    it('sorts violations by file (nulls first), then line, then check', () => {
      initRepo();
      write('b.js', 'const password = "hunter2secret";\n');
      write(
        'a.js',
        '// TODO password: "hunter2secretxx"\nconst x = 1;\nconst password = "hunter2secret";\n'
      );
      const fakeRepo = {
        name: 'zz-fake-repo',
        defaultEnabled: true,
        scope: 'repo',
        run() {
          return [
            { file: null, line: null, check: 'zz-fake-repo', message: 'repo-wide' },
          ];
        },
      };
      registry.push(fakeRepo);

      let result;
      try {
        result = runLint({ dir: tmpDir });
      } finally {
        registry.splice(registry.indexOf(fakeRepo), 1);
      }

      const keys = result.violations.map(
        (v) => `${v.file}:${v.line}:${v.check}`
      );
      expect(keys).toEqual([
        'null:null:zz-fake-repo',
        'a.js:1:secrets',
        'a.js:1:todo-deadline',
        'a.js:3:secrets',
        'b.js:1:secrets',
      ]);
      // file-less violations print without a file prefix
      expect(result.output).toContain('[zz-fake-repo] repo-wide');
    });

    it('json mode: output is { violations, skipped }, pretty-printed', () => {
      initRepo();
      write('src/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({ dir: tmpDir, json: true });

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.output);
      expect(parsed.violations).toEqual(result.violations);
      expect(parsed).toHaveProperty('skipped');
      expect(Array.isArray(parsed.skipped)).toBe(true);
      expect(result.output).toContain('\n  '); // pretty, 2-space indent
    });

    it('surfaces skipped binary files (C7)', () => {
      initRepo();
      write('src/app.js', 'const x = 1;\n');
      fs.writeFileSync(
        path.join(tmpDir, 'blob.bin'),
        Buffer.from([0x00, 0x01, 0x02, 0x03])
      );

      const result = runLint({ dir: tmpDir });

      expect(result.skipped).toEqual([{ file: 'blob.bin', reason: 'binary' }]);
      expect(result.output).toContain('warning: skipped blob.bin (binary)');
    });

    it('a positional matching no files is an error, exit 2 (C6)', () => {
      initRepo();
      write('src/app.js', 'const x = 1;\n');

      const result = runLint({ dir: tmpDir, paths: ['src/typo.ts'] });

      expect(result.exitCode).toBe(2);
      expect(result.errors.some((e) => e.includes('src/typo.ts'))).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('accepts an absolute positional by relativizing it to dir (C6)', () => {
      initRepo();
      write('src/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({
        dir: tmpDir,
        paths: [path.join(tmpDir, 'src')],
      });

      expect(result.exitCode).toBe(1);
      expect(result.violations.every((v) => v.file.startsWith('src/'))).toBe(
        true
      );
    });

    it('restricts scanning to the given paths', () => {
      initRepo();
      write('src/app.js', 'const password = "hunter2secret";\n');
      write('other/app.js', 'const password = "hunter2secret";\n');

      const result = runLint({ dir: tmpDir, paths: ['other'] });

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].file).toBe('other/app.js');
    });
  });

  describe('lint CLI (integration)', () => {
    /** Seed tmpDir as a committed git project with the given files */
    function makeProject(files) {
      const g = initRepo();
      for (const [rel, content] of Object.entries(files)) {
        write(rel, content);
      }
      g('add', '.');
      g('commit', '-m', 'chore: init');
    }

    const VIOLATING_FILES = {
      'src/app.ts': [
        "import x from './does-not-exist';",
        'const apiKey = "sk_live_abcdef123456";',
        '// TODO implement later',
        '',
      ].join('\n'),
    };

    /** Run the real CLI in tmpDir, returning { status, stdout, stderr } */
    function runCli(args) {
      try {
        const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
          cwd: tmpDir,
          encoding: 'utf8',
        });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        return {
          status: err.status,
          stdout: err.stdout || '',
          stderr: err.stderr || '',
        };
      }
    }

    it('exits 1 on a violating project, printing tagged lines and a summary', () => {
      makeProject(VIOLATING_FILES);

      const { status, stdout } = runCli(['lint']);

      expect(status).toBe(1);
      expect(stdout).toContain('[secrets]');
      expect(stdout).toContain('[todo-deadline]');
      expect(stdout).toContain('[import-exists]');
      expect(stdout).toContain('problem(s) found');
    });

    it('exits 0 on a conforming project', () => {
      makeProject({ 'src/ok.ts': 'export const x = 1;\n' });

      const { status, stdout } = runCli(['lint']);

      expect(status).toBe(0);
      expect(stdout).toContain('No problems found');
    });

    it('--json prints a parseable JSON array of violations', () => {
      makeProject(VIOLATING_FILES);

      const { status, stdout } = runCli(['lint', '--json']);

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed.violations)).toBe(true);
      const checks = new Set(parsed.violations.map((v) => v.check));
      expect(checks.has('secrets')).toBe(true);
      expect(checks.has('todo-deadline')).toBe(true);
      expect(checks.has('import-exists')).toBe(true);
    });

    it('--checks secrets runs only the secrets check', () => {
      makeProject(VIOLATING_FILES);

      const { status, stdout } = runCli(['lint', '--checks', 'secrets']);

      expect(status).toBe(1);
      expect(stdout).toContain('[secrets]');
      expect(stdout).not.toContain('[todo-deadline]');
      expect(stdout).not.toContain('[import-exists]');
    });

    it('--checks with an unknown name exits 2', () => {
      makeProject({ 'src/ok.ts': 'export const x = 1;\n' });

      const { status, stderr } = runCli(['lint', '--checks', 'nope']);

      expect(status).toBe(2);
      expect(stderr).toContain('nope');
    });
  });
});
