const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { PACKAGE_ROOT } = require('./utils');
const gate = require('../templates/hooks/quality-gate.cjs');

// 3.7.0 (C3h): the gate's extension points in .ai-dev-helm.json - gate.controlPlane, gate.exemptDocs, gate.harness,
// and the files of gate.script / reviewBudgetScript in the control plane - read from the repository the call is
// judged in; the manifest itself is control plane; a manifest that cannot be read blocks every gated call.

const HOOK = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('the configuration in the decisions (ctx stub)', () => {
  const ctxOf = (over = {}) => {
    const values = {
      branch: 'feat',
      head: HEAD,
      flag: null,
      isAncestor: false,
      diffSinceFlag: null,
      diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
      ...over,
    };
    const ctx = {};
    for (const key of Object.keys(values)) Object.defineProperty(ctx, key, { get: () => values[key], enumerable: true });
    return ctx;
  };
  const config = (over = {}) => ({ controlPlane: [], exemptDocs: [], harness: [], ...over });
  const base = (files) => ({ diffSinceBase: { files, overrideChanged: false } });

  test('exemptDocs adds documents to the harness-only exemption, documents only', () => {
    const doc = base(['documents/development/lint-coverage-map.md']);
    expect(gate.classify('git push origin HEAD:main', ctxOf(doc)).decision).toBe('block');
    const exempt = { gateConfig: config({ exemptDocs: [/^documents\/development\/lint-coverage-map\.md$/] }) };
    expect(gate.classify('git push origin HEAD:main', ctxOf({ ...doc, ...exempt }))).toEqual({ decision: 'allow' });
    // A script is code even when a pattern names it.
    const script = { ...base(['documents/development/check.sh']), gateConfig: config({ exemptDocs: [/^documents\/development\//] }) };
    expect(gate.classify('git push origin HEAD:main', ctxOf(script)).decision).toBe('block');
  });

  test('controlPlane wins over the exemption, and makes a flag on an ancestor stale', () => {
    const files = ['documents/development/lint-coverage-map.md'];
    const both = config({ exemptDocs: [/^documents\/development\/lint-coverage-map\.md$/], controlPlane: [/^documents\/development\/lint-coverage-map\.md$/i] });
    const verdict = gate.classify('git push origin HEAD:main', ctxOf({ ...base(files), gateConfig: both }));
    expect(verdict).toMatchObject({ decision: 'block', rule: '3' });
    expect(verdict.reason).toMatch(/Gate control-plane changed: documents\/development\/lint-coverage-map\.md/);
    // After a flag: the same file is control plane, so the flag does not cover it.
    const after = ctxOf({ flag: { commit: 'b'.repeat(40) }, isAncestor: true, diffSinceFlag: { files, overrideChanged: false }, gateConfig: both, ...base(files) });
    expect(gate.classify('git push origin HEAD:main', after).reason).toMatch(/Gate control-plane changed/);
  });

  test('harness adds paths a speed-mode flag never takes in', () => {
    const speed = { flag: { commit: HEAD, mode: 'speed' }, ...base(['.github/workflows/ci.yml']) };
    expect(gate.classify('git push origin HEAD:main', ctxOf(speed))).toEqual({ decision: 'allow' });
    const verdict = gate.classify('git push origin HEAD:main', ctxOf({ ...speed, gateConfig: config({ harness: [/^\.github\/workflows\/.*$/i] }) }));
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toMatch(/Speed-mode flag cannot take in harness changes.*\.github\/workflows\/ci\.yml/);
  });

  test('a broken configuration blocks the gated calls only', () => {
    const broken = ctxOf({ gateConfig: { error: '.ai-dev-helm.json is not valid JSON' }, flag: { commit: HEAD } });
    const verdict = gate.classify('git push origin HEAD:main', broken);
    expect(verdict).toMatchObject({ decision: 'block', rule: '5' });
    expect(verdict.reason).toMatch(/gate configuration in \.ai-dev-helm\.json cannot be read \(\.ai-dev-helm\.json is not valid JSON\)/);
    for (const command of ['git push origin feat', 'git status', 'git push']) expect(gate.classify(command, broken), command).toEqual({ decision: 'allow' });
  });
});

describe('the configuration read by the hook (integration)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-config-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // A repository whose main (origin/main) holds `onMain` files, then a feature branch with `onFeature` commits.
  const repo = (name, { onMain = {}, onFeature = {} } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const g = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    const put = (files) => {
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
        g('add', '-f', file);
      }
    };
    g('init', '-q', '-b', 'main');
    put({ 'app.js': '1\n', ...onMain });
    g('commit', '-q', '-m', 'init');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('checkout', '-q', '-b', 'feat');
    put(Object.keys(onFeature).length ? onFeature : { 'code.js': 'x\n' });
    g('commit', '-q', '-m', 'feature');
    return { dir, head: g('rev-parse', 'HEAD'), write: (file, content) => fs.writeFileSync(path.join(dir, file), content) };
  };
  const manifest = (value) => (typeof value === 'string' ? value : JSON.stringify({ version: '3.7.0', ...value }, null, 2));
  const run = (cwd, command) => {
    const result = spawnSync(process.execPath, [HOOK], { cwd, input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', timeout: 30000 });
    return result.stdout.trim() ? JSON.parse(result.stdout) : { decision: 'allow' };
  };
  const speedFlag = (r) => r.write('.quality-check-passed', JSON.stringify({ branch: 'feat', commit: r.head, mode: 'speed', deferredReviewIssue: 1 }));

  test('gate.exemptDocs in the product\'s manifest exempts its documents', () => {
    const doc = { 'documents/development/lint-coverage-map.md': '# map\n' };
    const plain = repo('plain', { onFeature: doc });
    expect(run(plain.dir, 'git push origin HEAD:main').decision).toBe('block');
    const declared = repo('declared', { onMain: { '.ai-dev-helm.json': manifest({ gate: { exemptDocs: ['documents/development/lint-coverage-map.md'] } }) }, onFeature: doc });
    expect(run(declared.dir, 'git push origin HEAD:main')).toEqual({ decision: 'allow' });
  });

  test('gate.controlPlane and the declared gate / review-budget files are control plane', () => {
    const doc = { 'documents/development/lint-coverage-map.md': '# map\n' };
    const control = repo('control', { onMain: { '.ai-dev-helm.json': manifest({ gate: { exemptDocs: ['documents/**'], controlPlane: ['documents/development/lint-coverage-map.md'] } }) }, onFeature: doc });
    expect(run(control.dir, 'git push origin HEAD:main').reason).toMatch(/Gate control-plane changed: documents\/development\/lint-coverage-map\.md/);
    // gate.script / reviewBudgetScript: a speed-mode flag never takes their change in, though nothing lists them.
    for (const [name, decl, file] of [['script', { gate: { script: 'scripts/gate.mjs' } }, 'scripts/gate.mjs'], ['budget', { reviewBudgetScript: './scripts/rb.cjs' }, 'scripts/rb.cjs']]) {
      const undeclared = repo(`${name}-plain`, { onFeature: { [file]: 'x\n' } });
      speedFlag(undeclared);
      expect(run(undeclared.dir, 'git push origin HEAD:main'), name).toEqual({ decision: 'allow' });
      const r = repo(name, { onMain: { '.ai-dev-helm.json': manifest(decl) }, onFeature: { [file]: 'x\n' } });
      speedFlag(r);
      expect(run(r.dir, 'git push origin HEAD:main').reason, name).toMatch(new RegExp(`Speed-mode flag cannot take in harness changes.*${file.replace(/[./]/g, '\\$&')}`));
    }
  });

  test('gate.harness adds paths a speed-mode flag never takes in', () => {
    const ci = { '.github/workflows/ci.yml': 'on: push\n' };
    const r = repo('harness', { onMain: { '.ai-dev-helm.json': manifest({ gate: { harness: ['.github/workflows/'] } }) }, onFeature: ci });
    speedFlag(r);
    expect(run(r.dir, 'git push origin HEAD:main').reason).toMatch(/Speed-mode flag cannot take in harness changes.*\.github\/workflows\/ci\.yml/);
  });

  test('.ai-dev-helm.json itself is control plane: changing it is never exempt', () => {
    const r = repo('manifest', { onFeature: { '.ai-dev-helm.json': manifest({ gate: { exemptDocs: ['documents/**'] } }), 'documents/development/x.md': '# x\n' } });
    expect(run(r.dir, 'git push origin HEAD:main').reason).toMatch(/Gate control-plane changed: \.ai-dev-helm\.json/);
  });

  test('a manifest that cannot be read blocks the gated calls, and nothing else', () => {
    const cases = [
      ['{ "version": "3.7.0", ', /is not valid JSON/],
      ['[]', /root of \.ai-dev-helm\.json is not an object/],
      [manifest({ gate: [] }), /gate is not an object/],
      [manifest({ gate: { controlPlane: 'scripts/**' } }), /gate\.controlPlane is not an array/],
      [manifest({ gate: { exemptDocs: ['/abs/x.md'] } }), /gate\.exemptDocs holds "\/abs\/x\.md"/],
      [manifest({ gate: { harness: [7] } }), /gate\.harness holds 7/],
      [manifest({ gate: { script: '../outside.mjs' } }), /gate\.script "\.\.\/outside\.mjs" is not a relative path/],
      [manifest({ reviewBudgetScript: 'scripts/rb.txt' }), /reviewBudgetScript "scripts\/rb\.txt" is not a relative path/],
    ];
    const r = repo('broken');
    r.write('.quality-check-passed', JSON.stringify({ branch: 'feat', commit: r.head }));
    expect(run(r.dir, 'git push origin HEAD:main')).toEqual({ decision: 'allow' }); // the flag covers HEAD
    for (const [text, why] of cases) {
      r.write('.ai-dev-helm.json', text);
      const verdict = run(r.dir, 'git push origin HEAD:main');
      expect(verdict.decision, text).toBe('block');
      expect(verdict.reason, text).toMatch(/The gate configuration in \.ai-dev-helm\.json cannot be read/);
      expect(verdict.reason, text).toMatch(why);
      expect(run(r.dir, 'git push origin feat'), text).toEqual({ decision: 'allow' });
    }
    fs.rmSync(path.join(r.dir, '.ai-dev-helm.json'));
    fs.mkdirSync(path.join(r.dir, '.ai-dev-helm.json'));
    expect(run(r.dir, 'gh pr merge 1').reason).toMatch(/is not a regular file/);
  });

  test('`**/` is zero or more directories, not any text; a `.` segment in a declared script is refused (cycle 1)', () => {
    // Break: until cycle 1 `**/README.md` exempted src/NOT_README.md, and scripts/./gate.cjs left the gate out of the
    // control plane.
    const glob = (name, files) => repo(name, { onMain: { '.ai-dev-helm.json': manifest({ gate: { exemptDocs: ['**/README.md', 'docs/**/guide.md'] } }) }, onFeature: files });
    for (const [name, file, expected] of [
      ['readme-root', 'README.md', 'allow'], ['readme-deep', 'a/b/README.md', 'allow'], ['guide', 'docs/a/guide.md', 'allow'], ['guide-top', 'docs/guide.md', 'allow'],
      ['not-readme', 'src/NOT_README.md', 'block'], ['glued', 'srcREADME.md', 'block'], ['userguide', 'docs/userguide.md', 'block'], ['userguide-deep', 'docs/a/userguide.md', 'block'],
    ]) {
      expect(run(glob(name, { [file]: '# x\n' }).dir, 'git push origin HEAD:main').decision, file).toBe(expected);
    }
    const dotted = repo('dotted', { onMain: { '.ai-dev-helm.json': manifest({ gate: { script: 'scripts/./gate.cjs' } }) } });
    expect(run(dotted.dir, 'git push origin HEAD:main').reason).toMatch(/gate\.script "scripts\/\.\/gate\.cjs" is not a relative path/);
  });

  test('only a committed manifest counts: an untracked, modified or deleted one blocks the gated calls (cycle 1)', () => {
    // Break: until cycle 1 an untracked {"gate":{"exemptDocs":["docs/**"]}} exempted the unreviewed docs push.
    const doc = { 'docs/x.md': '# x\n' };
    const untracked = repo('untracked', { onFeature: doc });
    expect(run(untracked.dir, 'git push origin HEAD:main').reason).toMatch(/Quality check not passed/);
    untracked.write('.ai-dev-helm.json', manifest({ gate: { exemptDocs: ['docs/**'] } }));
    const verdict = run(untracked.dir, 'git push origin HEAD:main');
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toMatch(/\.ai-dev-helm\.json has changes that are not committed/);
    expect(run(untracked.dir, 'git push origin feat')).toEqual({ decision: 'allow' });
    const committed = repo('modified', { onMain: { '.ai-dev-helm.json': manifest({}) }, onFeature: doc });
    committed.write('.ai-dev-helm.json', manifest({ gate: { exemptDocs: ['docs/**'] } }));
    expect(run(committed.dir, 'gh pr merge 1').reason).toMatch(/has changes that are not committed/);
    fs.rmSync(path.join(committed.dir, '.ai-dev-helm.json'));
    expect(run(committed.dir, 'git push origin HEAD:main').reason).toMatch(/has changes that are not committed/);
    // Cycle 2: compared with HEAD's blob, so a change git status does not show still blocks.
    const hidden = repo('hidden', { onMain: { '.ai-dev-helm.json': manifest({}) }, onFeature: doc });
    execFileSync('git', ['update-index', '--skip-worktree', '.ai-dev-helm.json'], { cwd: hidden.dir });
    hidden.write('.ai-dev-helm.json', manifest({ gate: { exemptDocs: ['docs/**'] } }));
    expect(run(hidden.dir, 'git push origin HEAD:main').reason).toMatch(/has changes that are not committed/);
    // The committed file with CRLF line endings in the work tree is the same file.
    const crlf = repo('crlf', { onMain: { '.ai-dev-helm.json': manifest({ gate: { exemptDocs: ['docs/**'] } }) }, onFeature: doc });
    crlf.write('.ai-dev-helm.json', manifest({ gate: { exemptDocs: ['docs/**'] } }).replace(/\n/g, '\r\n'));
    expect(run(crlf.dir, 'git push origin HEAD:main')).toEqual({ decision: 'allow' });
  });

  test.skipIf(process.platform !== 'win32')('a differently cased untracked manifest on a case-insensitive file system blocks (cycle 2)', () => {
    const r = repo('cased', { onFeature: { 'docs/x.md': '# x\n' } });
    r.write('.AI-DEV-HELM.JSON', manifest({ gate: { exemptDocs: ['docs/**'] } }));
    expect(run(r.dir, 'git push origin HEAD:main').reason).toMatch(/has changes that are not committed/);
  });

  test('the configuration is read from the repository a -C / cd moves the call to', () => {
    const here = repo('here');
    const doc = { 'documents/development/lint-coverage-map.md': '# map\n' };
    const there = repo('there', { onMain: { '.ai-dev-helm.json': manifest({ gate: { exemptDocs: ['documents/development/*.md'] } }) }, onFeature: doc });
    expect(run(here.dir, `git -C ../there push origin HEAD:main`)).toEqual({ decision: 'allow' });
    expect(run(here.dir, 'cd ../there && git push origin HEAD:main')).toEqual({ decision: 'allow' });
    there.write('.ai-dev-helm.json', '{');
    const verdict = run(here.dir, 'git -C ../there push origin HEAD:main');
    expect(verdict.reason).toMatch(/This push\/merge was judged in .*there.*gate configuration in \.ai-dev-helm\.json cannot be read/);
    // The payload repository's own broken manifest does not reach a call judged in another repository.
    here.write('.ai-dev-helm.json', '{');
    there.write('.ai-dev-helm.json', manifest({ gate: { exemptDocs: ['documents/development/*.md'] } }));
    expect(run(here.dir, 'git -C ../there push origin HEAD:main')).toEqual({ decision: 'allow' });
  });
});
