const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const branchNaming = require('./branch-naming');
const { checks } = require('./index');

/** Defaults mirrored from lib/lint/config.js DEFAULT_OPTIONS */
const DEFAULT_OPTIONS = {
  pattern: '^(feat|fix|chore|docs|refactor|test|ci|perf)/[a-z0-9._-]+$',
  exempt: ['main', 'master', 'develop'],
};

describe('branch-naming check', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-branch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** git wrapper matching the runner contract: trimmed stdout, null on failure */
  function makeGit(cwd) {
    return (args) => {
      try {
        return execFileSync('git', args, {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
    };
  }

  /** Turn tmpDir into a git repo with one commit on `branch` */
  function initRepo(branch) {
    const g = (...args) =>
      execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
        cwd: tmpDir,
        encoding: 'utf8',
      }).trim();
    g('init', '-b', branch);
    g('config', 'core.autocrlf', 'false');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    g('commit', '--allow-empty', '-m', 'chore: init');
    return g;
  }

  function run(options = DEFAULT_OPTIONS) {
    return branchNaming.run({
      repoRoot: tmpDir,
      options,
      git: makeGit(tmpDir),
    });
  }

  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(branchNaming.name).toBe('branch-naming');
      expect(branchNaming.defaultEnabled).toBe(true);
      expect(branchNaming.scope).toBe('repo');
      expect(typeof branchNaming.run).toBe('function');
    });

    it('registry exposes the real module', () => {
      const entry = checks.find((c) => c.name === 'branch-naming');
      expect(entry).toBe(branchNaming);
      expect(typeof entry.run).toBe('function');
    });
  });

  it('accepts a conforming branch name', () => {
    initRepo('feat/x-1');
    expect(run()).toEqual([]);
  });

  it('reports a nonconforming branch name', () => {
    initRepo('Feature/Bad_Name');
    const violations = run();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: null,
      line: null,
      check: 'branch-naming',
      message:
        "branch name 'Feature/Bad_Name' does not match pattern (Catalog: C7)",
    });
  });

  it('exempts branches listed in options.exempt', () => {
    initRepo('main');
    expect(run()).toEqual([]);
  });

  it('reports nothing on detached HEAD', () => {
    const g = initRepo('WeirdBranch');
    g('checkout', '--detach');
    expect(run()).toEqual([]);
  });

  it('reports nothing outside a git repo', () => {
    // tmpDir is not a repo: git returns null
    expect(run()).toEqual([]);
  });
});
