const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const commitMessage = require('./commit-message');
const { checks } = require('./index');

/** Default mirrored from lib/lint/config.js DEFAULT_OPTIONS */
const DEFAULT_OPTIONS = {
  pattern: '^(feat|fix|chore|docs|refactor|test|ci|perf|revert)(\\(.+\\))?!?: .+',
};

describe('commit-message check', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-commit-test-'));
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

  /** Turn tmpDir into a git repo on `branch`; returns a raw git helper */
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
    return g;
  }

  /** Empty commit with the given subject */
  function commit(g, subject) {
    g('commit', '--allow-empty', '-m', subject);
  }

  function run(options = DEFAULT_OPTIONS) {
    return commitMessage.run({
      repoRoot: tmpDir,
      options,
      git: makeGit(tmpDir),
    });
  }

  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(commitMessage.name).toBe('commit-message');
      expect(commitMessage.defaultEnabled).toBe(false);
      expect(commitMessage.scope).toBe('repo');
      expect(typeof commitMessage.run).toBe('function');
    });

    it('registry exposes the real module', () => {
      const entry = checks.find((c) => c.name === 'commit-message');
      expect(entry).toBe(commitMessage);
      expect(typeof entry.run).toBe('function');
    });
  });

  it('accepts conforming commits on a feature branch off main', () => {
    const g = initRepo('main');
    commit(g, 'nonconforming main commit stays out of range');
    g('checkout', '-b', 'feat/x');
    commit(g, 'feat: add thing');
    commit(g, 'fix(scope): correct thing');
    expect(run()).toEqual([]);
  });

  it('reports a nonconforming subject with its short hash', () => {
    const g = initRepo('main');
    commit(g, 'chore: init');
    g('checkout', '-b', 'feat/x');
    commit(g, 'bad subject line');
    const short = g('rev-parse', '--short', 'HEAD');
    const violations = run();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: null,
      line: null,
      check: 'commit-message',
      message: `commit ${short}: message does not match pattern (Catalog: C7)`,
    });
  });

  it('skips merge commits', () => {
    const g = initRepo('main');
    commit(g, 'chore: init');
    g('checkout', '-b', 'feat/side');
    commit(g, 'feat: side work');
    g('checkout', '-b', 'feat/target', 'main');
    commit(g, 'feat: target work');
    g('merge', '--no-ff', '--no-edit', 'feat/side');
    // merge commit subject ("Merge branch ...") does not match the pattern
    expect(run()).toEqual([]);
  });

  it('skips revert commits', () => {
    const g = initRepo('main');
    commit(g, 'chore: init');
    g('checkout', '-b', 'feat/x');
    commit(g, 'Revert "feat: add thing"');
    expect(run()).toEqual([]);
  });

  it('uses the local main merge-base when origin/main is absent', () => {
    const g = initRepo('main');
    commit(g, 'totally nonconforming commit on main');
    g('checkout', '-b', 'feat/x');
    commit(g, 'feat: good');
    // merge-base path scans only feat/x commits; the fallback (last 20)
    // would have reported the nonconforming main commit
    expect(run()).toEqual([]);
  });

  it('falls back to existing commits when there is no main and fewer than 20 commits', () => {
    const g = initRepo('feat/no-main');
    commit(g, 'feat: one');
    commit(g, 'bad two');
    commit(g, 'fix: three');
    const violations = run();
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('does not match pattern');
  });

  it('uses the local master merge-base on a master-based repo (C9)', () => {
    const g = initRepo('master');
    // Historical commits on master must stay out of range (not flagged)
    commit(g, 'legacy noncompliant commit one');
    commit(g, 'legacy noncompliant commit two');
    g('checkout', '-b', 'feat/x');
    commit(g, 'feat: good change');
    commit(g, 'nonconforming feature commit');
    const violations = run();
    // Only the feature-branch nonconforming commit is reported, not history
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('does not match pattern');
  });

  it('uses develop as a base branch when present (C9)', () => {
    const g = initRepo('develop');
    commit(g, 'legacy noncompliant on develop');
    g('checkout', '-b', 'feat/y');
    commit(g, 'feat: ok');
    expect(run()).toEqual([]);
  });

  it('reports nothing when the branch is at main (empty range)', () => {
    const g = initRepo('main');
    commit(g, 'nonconforming but out of range');
    expect(run()).toEqual([]);
  });

  it('reports nothing outside a git repo', () => {
    expect(run()).toEqual([]);
  });
});
