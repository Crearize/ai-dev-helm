// 3.4.3 (E1): `ai-dev-helm integrate-check`, the read-only pre-check of the
// remote-less integration. Every case runs real git: a repository whose
// checkout has `main` open, and a feature worktree beside it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { integrateCheck, IntegrateCheckError } = require('./integrate-check');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
let tmp;
let main;
let wt;

const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
  '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir, encoding: 'utf8' }).trim();
const put = (dir, file, text = `${file}\n`) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const commitIn = (dir, files, msg) => {
  const g = gitIn(dir);
  for (const f of files) put(dir, f);
  g('add', '-f', '--', ...files);
  g('commit', '-q', '-m', msg);
};
let g;
let w;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-integrate-')));
  main = path.join(tmp, 'main');
  wt = path.join(tmp, 'wt');
  fs.mkdirSync(main);
  g = gitIn(main);
  g('init', '-q', '-b', 'main');
  commitIn(main, ['app.js', 'Readme.md', 'docs/guide.md'], 'init');
  g('worktree', 'add', '-q', '-b', 'feature', wt);
  w = gitIn(wt);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const check = () => integrateCheck({ dir: wt, main });
const kinds = (r) => r.problems.map((p) => p.kind);
// A snapshot of everything the check must leave alone.
const state = () => [g('rev-parse', 'HEAD'), g('symbolic-ref', '-q', 'HEAD'), g('status', '--porcelain=v1', '--untracked-files=all', '--ignored'), w('rev-parse', 'HEAD')].join('\n');
const caseInsensitiveFs = () => {
  put(tmp, 'CaseProbe.txt');
  return fs.existsSync(path.join(tmp, 'caseprobe.txt'));
};
// The integration the documents prescribe, after an OK.
const integrate = () => {
  g('switch', '-q', '--detach');
  w('push', '-q', '.', 'HEAD:main');
  g('switch', '-q', 'main');
};

describe('integrate-check (3.4.3, E1)', () => {
  test('every git call runs without optional locks', () => {
    expect(fs.readFileSync(path.join(__dirname, 'integrate-check.js'), 'utf8')).toContain("env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }");
  });

  test('passes with unrelated untracked and ignored files, leaves everything as it was, and the integration then works', () => {
    commitIn(wt, ['src/new.js'], 'add');
    put(main, 'customer/report.xlsx', 'the user\'s own material\n');
    fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), 'local.env\n');
    put(main, 'local.env', 'ignored, the user\'s\n');
    const before = state();
    const r = check();
    expect(r).toMatchObject({ ok: true, problems: [], exitCode: 0 });
    expect(r.lines.join('\n')).not.toMatch(/report\.xlsx|local\.env/); // unrelated files are not looked at
    expect(state()).toBe(before);
    integrate();
    expect(g('rev-parse', 'HEAD')).toBe(w('rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(main, 'customer/report.xlsx'), 'utf8')).toBe('the user\'s own material\n');
  });

  test('a feature that adds nothing passes', () => {
    put(wt, 'app.js', 'changed\n');
    w('commit', '-q', '-am', 'modify');
    put(main, 'scratch.txt');
    const r = check();
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toContain('the 0 path(s) the feature adds');
  });

  test('an uncommitted change to a tracked file is reported by name', () => {
    commitIn(wt, ['src/new.js'], 'add');
    put(main, 'app.js', 'edited by the user\n');
    const r = check();
    expect(kinds(r)).toEqual(['tracked-change']);
    expect(r.problems[0].path).toBe('app.js');
    expect(r.exitCode).toBe(1);
  });

  test('main not being an ancestor is reported, and alone it says to merge and re-check without stopping', () => {
    commitIn(wt, ['src/new.js'], 'add');
    commitIn(main, ['other.js'], 'main moved on');
    const r = check();
    expect(kinds(r)).toEqual(['not-ancestor']);
    expect(r.onlyNotAncestor).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.lines[r.lines.length - 1]).toBe('integrate-check: NG (main is not an ancestor only) - merge main into the feature, re-run quality-check, then run integrate-check again (not exception X3: the main checkout is not touched; do not stop)');
  });

  test('a path both the trunk and the feature added is not a collision (two-point comparison)', () => {
    commitIn(wt, ['shared.md'], 'feature adds shared.md');
    commitIn(main, ['shared.md'], 'main adds shared.md too');
    const r = check();
    expect(kinds(r)).toEqual(['not-ancestor']); // no tracked-case / untracked report for shared.md
    expect(r.onlyNotAncestor).toBe(true);
  });

  test('with another problem besides the ancestor, it stops at X3', () => {
    commitIn(wt, ['src/new.js'], 'add');
    commitIn(main, ['other.js'], 'main moved on');
    put(main, 'app.js', 'edited\n');
    const r = check();
    expect(kinds(r).sort()).toEqual(['not-ancestor', 'tracked-change']);
    expect(r.onlyNotAncestor).toBe(false);
    expect(r.lines[r.lines.length - 1]).toContain('(exception X3)');
  });

  test('a rename staged in the main checkout is a tracked change, named once', () => {
    commitIn(wt, ['src/new.js'], 'add');
    g('mv', 'app.js', 'moved.js');
    const r = check();
    expect(r.problems).toEqual([{ kind: 'tracked-change', path: 'moved.js', detail: 'R ' }]);
  });

  test('a new file staged in the main checkout at a feature path is a tracked change, not a case collision', () => {
    commitIn(wt, ['src/new.js'], 'add');
    put(main, 'src/new.js', 'staged by the user\n');
    g('add', 'src/new.js');
    const r = check();
    expect(kinds(r)).toEqual(['tracked-change']);
    expect(r.lines.join('\n')).not.toContain('another case');
  });

  test('skip-worktree and assume-unchanged files the feature changes are reported', () => {
    put(wt, 'app.js', 'feature change\n');
    put(wt, 'Readme.md', 'feature change\n');
    w('commit', '-q', '-am', 'change both');
    g('update-index', '--skip-worktree', 'app.js');
    put(main, 'app.js', 'hidden local edit\n');
    g('update-index', '--assume-unchanged', 'Readme.md');
    put(main, 'Readme.md', 'hidden local edit\n');
    expect(g('status', '--porcelain', '--untracked-files=no')).toBe(''); // git status shows neither
    const r = check();
    expect(r.problems).toEqual([{ kind: 'assume-unchanged', path: 'Readme.md' }, { kind: 'skip-worktree', path: 'app.js' }]);
    expect(r.lines.join('\n')).toContain('app.js: skip-worktree');
  });

  test('a skip-worktree file the feature does not change is left alone', () => {
    commitIn(wt, ['src/new.js'], 'add');
    g('update-index', '--skip-worktree', 'app.js');
    put(main, 'app.js', 'hidden local edit\n');
    expect(check().ok).toBe(true);
  });

  test('--trunk master works on a repository whose trunk is master', () => {
    const repo = path.join(tmp, 'm2');
    fs.mkdirSync(repo);
    const g2 = gitIn(repo);
    g2('init', '-q', '-b', 'master');
    commitIn(repo, ['a.txt'], 'init');
    const wt2 = path.join(tmp, 'wt2');
    g2('worktree', 'add', '-q', '-b', 'topic', wt2);
    commitIn(wt2, ['b.txt'], 'add');
    put(repo, 'b.txt', 'the user\'s\n');
    const r = integrateCheck({ dir: wt2, main: repo, trunk: 'master' });
    expect(r.problems).toEqual([{ kind: 'untracked', path: 'b.txt', found: 'b.txt' }]);
    expect(r.lines[0]).toContain('topic -> master');
    expect(() => integrateCheck({ dir: wt2, main: repo })).toThrow(/branch main does not exist/);
  });

  test('a main checkout that is not on the trunk is reported', () => {
    commitIn(wt, ['src/new.js'], 'add');
    g('switch', '-q', '--detach');
    expect(kinds(check())).toEqual(['main-not-on-trunk']);
  });

  test('an untracked file at a path the feature adds is reported; without the check the final switch fails', () => {
    commitIn(wt, ['src/new.js'], 'add');
    put(main, 'src/new.js', 'the user\'s draft\n');
    const r = check();
    expect(r.problems).toEqual([{ kind: 'untracked', path: 'src/new.js', found: 'src/new.js' }]);
    expect(r.lines.join('\n')).toContain('src/new.js: an untracked file');
    g('switch', '-q', '--detach');
    w('push', '-q', '.', 'HEAD:main');
    expect(() => g('switch', '-q', 'main')).toThrow();
  });

  test('the target of a rename counts as added', () => {
    fs.mkdirSync(path.join(wt, 'lib'));
    w('mv', 'app.js', 'lib/app.js');
    w('commit', '-q', '-m', 'move');
    put(main, 'lib/app.js', 'the user\'s\n');
    expect(check().problems).toEqual([{ kind: 'untracked', path: 'lib/app.js', found: 'lib/app.js' }]);
  });

  test('a non-ASCII name is matched as it is, whatever core.quotePath says', () => {
    g('config', 'core.quotePath', 'true');
    commitIn(wt, ['資料/顧客一覧.txt'], 'list');
    put(main, '資料/顧客一覧.txt', 'the user\'s\n');
    const r = check();
    expect(r.problems).toEqual([{ kind: 'untracked', path: '資料/顧客一覧.txt', found: '資料/顧客一覧.txt' }]);
    expect(r.lines.join('\n')).toContain('資料/顧客一覧.txt');
  });

  test('a case-only difference follows the file system', () => {
    commitIn(wt, ['src/code.js'], 'add');
    put(main, 'src/Code.js', 'the user\'s\n');
    const r = check();
    if (caseInsensitiveFs()) {
      expect(r.problems).toEqual([{ kind: 'untracked', path: 'src/code.js', found: 'src/Code.js' }]);
      expect(r.lines.join('\n')).toContain('src/code.js (on disk: src/Code.js)');
    } else {
      expect(r.ok).toBe(true); // two different files: git switch does not touch Code.js
    }
  });

  test('a case-only rename of a tracked file is git\'s to handle, not a collision', () => {
    w('mv', 'Readme.md', 'README.tmp');
    w('mv', 'README.tmp', 'README.md');
    w('commit', '-q', '-m', 'rename case');
    expect(check().ok).toBe(true);
  });

  test('an ignored file at a feature path is reported (git would overwrite it silently)', () => {
    fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), 'secret.env\n');
    commitIn(wt, ['secret.env'], 'template');
    put(main, 'secret.env', 'the user\'s keys\n');
    expect(check().problems).toEqual([{ kind: 'ignored', path: 'secret.env', found: 'secret.env' }]);
  });

  test('glob characters in a feature path match only that path', () => {
    commitIn(wt, ['app/[id]/page.tsx'], 'page');
    put(main, 'app/i/page.tsx', 'the user\'s\n'); // a glob reading of app/[id]/page.tsx would match this
    expect(check().ok).toBe(true);
    put(main, 'app/[id]/page.tsx', 'the user\'s\n');
    expect(check().problems).toEqual([{ kind: 'untracked', path: 'app/[id]/page.tsx', found: 'app/[id]/page.tsx' }]);
  });

  test('a directory holding only ignored files is reported', () => {
    commitIn(wt, ['cache'], 'cache as a file');
    fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '*.tmp\n');
    put(main, 'cache/a.tmp', 'ignored\n');
    const r = check();
    expect(r.problems).toEqual([{ kind: 'directory', path: 'cache', found: 'cache', detail: '1 untracked or ignored file(s)', files: ['cache/a.tmp'] }]);
  });

  test('a directory at a feature path is reported when it holds untracked or ignored files, and passes when empty', () => {
    commitIn(wt, ['notes'], 'notes as a file');
    fs.mkdirSync(path.join(main, 'notes'));
    expect(check().ok).toBe(true); // git replaces an empty directory
    put(main, 'notes/a.txt', 'the user\'s\n');
    const r = check();
    expect(kinds(r)).toEqual(['directory']);
    expect(r.problems[0].files).toEqual(['notes/a.txt']);
  });

  test('a parent of a feature path that is a file is reported; without the check the final switch fails', () => {
    commitIn(wt, ['out/report.md'], 'report');
    put(main, 'out', 'the user\'s file named out\n');
    const r = check();
    expect(r.problems).toEqual([{ kind: 'parent-is-file', path: 'out/report.md', found: 'out', detail: 'untracked' }]);
    expect(r.lines.join('\n')).toContain('      out/report.md: a parent of it is an untracked file: out'); // no "(on disk: ...)", right article
    g('switch', '-q', '--detach');
    w('push', '-q', '.', 'HEAD:main');
    expect(() => g('switch', '-q', 'main')).toThrow();
    expect(fs.readFileSync(path.join(main, 'out'), 'utf8')).toBe('the user\'s file named out\n');
  });

  test('a tracked file the feature turns into a directory is git\'s to handle', () => {
    w('rm', '-q', 'app.js');
    commitIn(wt, ['app.js/index.js'], 'file to directory');
    expect(check().ok).toBe(true);
    integrate();
    expect(fs.statSync(path.join(main, 'app.js')).isDirectory()).toBe(true);
  });

  test('refuses to run on the main checkout itself, on another repository, or with an unknown trunk', () => {
    expect(() => integrateCheck({ dir: main, main })).toThrow(IntegrateCheckError);
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    gitIn(other)('init', '-q', '-b', 'main');
    commitIn(other, ['x'], 'x');
    expect(() => integrateCheck({ dir: wt, main: other })).toThrow(/not a worktree of the same repository/);
    expect(() => integrateCheck({ dir: wt, main, trunk: 'trunk' })).toThrow(/branch trunk does not exist/);
    expect(() => integrateCheck({ dir: main, main: wt })).toThrow(/is on main/);
  });

  test('CLI: exit 0 / 1 / 2 and the report on stdout', () => {
    commitIn(wt, ['src/new.js'], 'add');
    const run = (...args) => spawnSync(process.execPath, [CLI, 'integrate-check', ...args], { cwd: wt, encoding: 'utf8' });
    const ok = run('--main', main);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('integrate-check: OK');
    put(main, 'src/new.js', 'x\n');
    const ng = run('--main', main);
    expect(ng.status).toBe(1);
    expect(ng.stdout).toContain('src/new.js: an untracked file');
    expect(ng.stdout).toContain('change nothing; report the above in the final message and wait for the owner (exception X3)');
    const bad = run('--main', path.join(tmp, 'nowhere'));
    expect(bad.status).toBe(2);
    // Usage errors are exit 2 too, never a verdict.
    expect(run().status).toBe(2);
    expect(run('--main', main, '--no-such-option').status).toBe(2);
    // --main is relative to the current directory, not to --dir.
    fs.rmSync(path.join(main, 'src/new.js'));
    const rel = spawnSync(process.execPath, [CLI, 'integrate-check', '--dir', wt, '--main', 'main'], { cwd: tmp, encoding: 'utf8' });
    expect(rel.status, rel.stderr).toBe(0);
    expect(rel.stdout.startsWith('integrate-check: feature -> main')).toBe(true);
  });
});
