'use strict';

// 3.7.0 (C7a, #225): quality-context --merge-only - "only the base was taken in since the flag".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkMergeOnly } = require('./quality-check-context');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
let dir;

function git(...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 && !(args[0] === 'merge' && r.status === 1)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const head = () => git('rev-parse', 'HEAD').stdout.trim();
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return head(); };

// main: f.txt (8 lines); feat changes line 2 (the flag commit P); main then changes line 7 and other.txt.
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-merge-only-'));
  git('init', '-q', '-b', 'main');
  write('f.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
  write('other.txt', 'x\n');
  commit('base');
  git('checkout', '-q', '-b', 'feat');
  write('f.txt', 'a\nb-feature\nc\nd\ne\nf\ng\nh\n');
  const p = commit('feature');
  git('checkout', '-q', 'main');
  write('f.txt', 'a\nb\nc\nd\ne\nf\ng-main\nh\n');
  write('other.txt', 'x\ny\n');
  commit('main moves');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('checkout', '-q', 'feat');
  return p;
}

afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

test('a merge of main, and a rebase onto it, are "only the base taken in"', () => {
  const p = setup();
  git('merge', '-q', '--no-edit', 'main');
  expect(checkMergeOnly({ dir, since: p })).toMatchObject({ same: true, base: 'origin/main' });
  git('checkout', '-q', '-b', 'rebased', p);
  git('rebase', '-q', 'main');
  expect(checkMergeOnly({ dir, since: p }).same).toBe(true);
});

test('a commit after the merge, or a binary change, is not', () => {
  const p = setup();
  git('merge', '-q', '--no-edit', 'main');
  write('extra.txt', 'z\n');
  commit('after the merge');
  expect(checkMergeOnly({ dir, since: p })).toMatchObject({ same: false, paths: ['extra.txt'] });
  git('reset', '-q', '--hard', 'HEAD~1');
  fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2]));
  git('add', '-A');
  git('commit', '-q', '--amend', '--no-edit');
  expect(checkMergeOnly({ dir, since: p })).toMatchObject({ same: false, paths: ['logo.bin'] });
});

test('a conflict resolved by hand is not, even when it keeps the PR lines', () => {
  setup();
  git('checkout', '-q', '-b', 'conflict', 'feat');
  write('f.txt', 'a\nb-feature\nc\nd\ne\nf\ng-feature\nh\n');
  const p = commit('touches the line main changed');
  git('merge', '-q', '--no-edit', 'main');
  write('f.txt', 'a\nb-feature\nc\nd\ne\nf\ng-feature\ng-main\nh\n');
  commit('resolved');
  const r = checkMergeOnly({ dir, since: p });
  expect(r.same).toBe(false);
  expect(r.paths).toContain('f.txt');
});

test('no verdict without a base ref or a known commit; the CLI exits 0 / 1 / 2', () => {
  const p = setup();
  expect(() => checkMergeOnly({ dir, since: 'not-hex' })).toThrow(/--since must be the commit/);
  expect(() => checkMergeOnly({ dir, since: 'deadbeefdeadbeef' })).toThrow(/is not a commit/);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'quality-context', '--merge-only', ...args], { cwd: dir, encoding: 'utf8' });
  git('merge', '-q', '--no-edit', 'main');
  const yes = run('--since', p);
  expect(yes.status).toBe(0);
  expect(yes.stdout).toMatch(/^merge-only: YES/m);
  write('extra.txt', 'z\n');
  commit('after');
  const no = run('--since', p);
  expect(no.status).toBe(1);
  expect(no.stdout).toMatch(/^merge-only: NO/m);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  git('branch', '-q', '-m', 'main', 'trunk-renamed');
  const none = run('--since', p);
  expect(none.status).toBe(2);
}, 60000);
