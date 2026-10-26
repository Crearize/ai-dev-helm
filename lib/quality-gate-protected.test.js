'use strict';

// 3.7.1 (#227): the gate's D1-D4 - Monitor (D1), the declared protected branches (D2, platform's former gate's
// release protection and its main-passed route), the declared denied commands (D3, platform's Render rule) and
// Cursor's input and output (D4). The cases of platform's former gate (scripts/agent-shell-safety-hook.test.mjs at
// 2ef265c0b, listed in results/platform-3.7.0.md) are carried over here. Without a declaration every decision is
// the 3.7.0 one - the other quality-gate tests run unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');
const { PACKAGE_ROOT } = require('./utils');
const { classify } = require('../templates/hooks/quality-gate.cjs');
const workflow = require('./workflow');

const HOOK = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');

// The gate is one file with a fixed public API (lib/quality-gate-api.test.js), so its internals are read here by
// evaluating the file in a sandbox - the hook itself does not run.
function internals(names) {
  const source = fs.readFileSync(HOOK, 'utf8').replace(/^#!.*/, '');
  const sandbox = { require, module: { exports: {} }, process, Buffer, console, __filename: HOOK, __dirname: path.dirname(HOOK) };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(`${source}\n;this.__internals = { ${names.join(', ')} };`, sandbox);
  return sandbox.__internals;
}
const { parseDeclarations, mergeDeclarations } = internals(['parseDeclarations', 'mergeDeclarations']);

// platform's Render rule (results/platform-3.7.0.md, 1), written without nested quantifiers.
const RENDER = {
  all: [
    '(?:-X|--request)[\\s=]*["\']?PUT\\b|(?:^|\\s)-Method\\s+Put\\b|(?:^|\\s)PUT\\s+https?://',
    'api\\.render\\.com',
    '/env-vars/?(?:[?#\\s"\'`]|$)',
  ],
  reason: 'Render API の PUT /env-vars は全置換のため禁止です。個別の環境変数の更新には PUT /env-vars/{key} を使ってください。',
};

describe('declarations: the same check as lib/workflow.js, nothing dropped in silence', () => {
  const samples = [
    undefined, ['release'], ['release', 'hotfix/x', 'v1.2'], [], ['main', 'release'], 'release', [1], ['-f'], ['a b'],
    ['rel*'], [null], {}, ['release', ''],
  ];
  test('protectedBranches is an error in the gate exactly when workflow.js reports one', () => {
    for (const list of samples) {
      const wf = list === undefined ? {} : { protectedBranches: list };
      const lib = workflow.extrasErrors({ workflow: wf }).some((e) => /protectedBranches|workflow must be/.test(e));
      const gate = parseDeclarations(JSON.stringify({ workflow: wf })).branchesError !== null;
      expect(gate, JSON.stringify(list)).toBe(lib);
    }
    for (const wf of [[], null, 'x', 1]) {
      expect(parseDeclarations(JSON.stringify({ workflow: wf })).branchesError, JSON.stringify(wf)).toBe('workflow must be an object');
      expect(workflow.extrasErrors({ workflow: wf })).toContain('workflow must be an object');
    }
    expect(parseDeclarations('{').branchesError).toMatch(/not valid JSON/);
    expect(parseDeclarations('[]').branchesError).toMatch(/root/);
  });

  test('denyCommands: shape and limits, and one entry per declaration across HEAD and the trunk', () => {
    const deny = (list) => parseDeclarations(JSON.stringify({ gate: { denyCommands: list } }));
    expect(deny([RENDER]).denyError).toBeNull();
    expect(deny([RENDER]).deny[0].all).toHaveLength(3);
    const long = 'x'.repeat(513);
    for (const [bad, why] of [
      ['x', /array of at most 32/], [Array(33).fill(RENDER), /array of at most 32/], [[1], /\[0\] is not an object/],
      [[{ all: [], reason: 'r' }], /all must be an array of 1-8/], [[{ all: Array(9).fill('a'), reason: 'r' }], /1-8/],
      [[{ all: ['('], reason: 'r' }], /not a valid regular expression/], [[{ all: [long], reason: 'r' }], /1-512/],
      [[{ all: [''], reason: 'r' }], /1-512/], [[{ all: ['a'] }], /reason must be/], [[{ all: ['a'], reason: 'r'.repeat(501) }], /reason must be/],
    ]) {
      const d = deny(bad);
      expect(d.denyError, JSON.stringify(bad).slice(0, 60)).toMatch(why);
      expect(d.deny).toEqual([]);
    }
    expect(parseDeclarations(JSON.stringify({ gate: 'x' })).denyError).toBe('gate is not an object');
    const both = mergeDeclarations([deny([RENDER]), deny([RENDER, { all: ['b'], reason: 'r' }])]);
    expect(both.deny.map((r) => r.reason)).toEqual([RENDER.reason, 'r']);
    const broken = mergeDeclarations([parseDeclarations(JSON.stringify({ workflow: { protectedBranches: ['release'] } })), parseDeclarations('{')]);
    expect(broken.branches).toEqual([]);
    expect(broken.branchesError).toMatch(/not valid JSON/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The decisions with a stub ctx (platform's former gate's cases)
// ---------------------------------------------------------------------------------------------------------------
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const stub = (over = {}) => {
  const values = {
    branch: 'feat',
    head: HEAD,
    flag: null,
    isAncestor: false,
    diffSinceFlag: null,
    diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
    declarations: { branches: ['release'], branchesError: null, deny: [], denyError: null },
    mainPassed: () => false,
    mergePassed: () => false,
    ...over,
  };
  const ctx = {};
  for (const key of Object.keys(values)) Object.defineProperty(ctx, key, { get: () => values[key], enumerable: true });
  return ctx;
};
const flagged = { flag: { commit: HEAD }, isAncestor: true };
const verdict = (command, ctx, shell) => classify(command, ctx, shell);

describe('D2: a declared protected branch is judged like main', () => {
  test('delete, force, --mirror and --all are refused even with a flag', () => {
    for (const command of [
      'git push origin :release', 'git push origin --delete release', 'git push --delete origin release', 'git push -d origin release',
      'git push --force origin release', 'git push -f origin release', 'git push -uf origin release', 'git push origin +feat:release',
      'git push --force-with-lease origin release', 'git push origin refs/heads/release --force', 'git push --mirror origin', 'git push --all origin',
    ]) {
      const v = verdict(command, stub(flagged));
      expect(v.decision, command).toBe('block');
      expect(v.rule, command).toBe('2');
    }
    expect(verdict('git push --force origin release', stub(flagged)).reason).toMatch(/main\/master \(or the protected branch release\)/);
    // Without the declaration release is an ordinary branch (3.7.0).
    const plain = stub({ ...flagged, declarations: null });
    expect(verdict('git push origin --delete release', plain)).toEqual({ decision: 'allow' });
    expect(verdict('git push --force origin release', plain)).toEqual({ decision: 'allow' }); // not a candidate in 3.7.0
  });

  test('every refspec form into release needs a flag; release-bound pushes and merges on release too', () => {
    for (const command of ['git push origin release', 'git push origin HEAD:release', 'git push origin feat:refs/heads/release', 'git push origin @:release']) {
      expect(verdict(command, stub()).decision, command).toBe('block');
    }
    for (const command of ['git push', 'git push origin', 'git push origin HEAD', 'git push origin @', 'git merge feat', 'git pull origin feat', 'git rebase feat']) {
      expect(verdict(command, stub({ branch: 'release' })).decision, command).toBe('block');
      expect(verdict(command, stub({ branch: 'feat' })), command).toEqual({ decision: 'allow' });
    }
    // @{push} on release from a feature branch (H-19(d)).
    expect(verdict('git push', stub({ pushTarget: 'origin/release' })).decision).toBe('block');
    // With a flag on HEAD the push goes through, as to main.
    expect(verdict('git push origin HEAD:release', stub(flagged))).toEqual({ decision: 'allow' });
  });

  test('a push of content main already has needs no flag (main-passed route); origin/main unknown is no route', () => {
    const passed = { mainPassed: (src) => src === 'HEAD' || src === 'origin/main' };
    expect(verdict('git push origin HEAD:release', stub(passed))).toEqual({ decision: 'allow' });
    expect(verdict('git push', stub({ ...passed, branch: 'release' }))).toEqual({ decision: 'allow' });
    expect(verdict('git push origin origin/main:release', stub(passed))).toEqual({ decision: 'allow' });
    // Not passed (content main lacks) or not knowable (null): judged with the flag.
    expect(verdict('git push origin HEAD:release', stub({ mainPassed: () => false })).decision).toBe('block');
    expect(verdict('git push origin HEAD:release', stub({ mainPassed: () => null })).decision).toBe('block');
    expect(verdict('git push origin other:release', stub(passed)).reason).toMatch(/Push from the branch itself/);
    // A push that reaches main as well is judged as a push to main.
    expect(verdict('git push origin HEAD:release HEAD:main', stub(passed)).decision).toBe('block');
    // Force and delete stay refused.
    expect(verdict('git push --force origin HEAD:release', stub(passed)).decision).toBe('block');
  });

  test('on release, git merge <rev> of what origin/main holds needs no flag', () => {
    const passed = { branch: 'release', mergePassed: (rev) => ['origin/main', '0123abc'].includes(rev) };
    for (const command of ['git merge origin/main', 'git merge 0123abc', 'git merge --ff-only 0123abc', 'git merge --no-ff -m "release 1.2" 0123abc']) {
      expect(verdict(command, stub(passed)), command).toEqual({ decision: 'allow' });
    }
    expect(verdict('git merge feat', stub(passed)).decision).toBe('block');
    expect(verdict('git merge origin/main', stub({ branch: 'release', mergePassed: () => false })).decision).toBe('block');
    // The sync forms of release itself, as on main.
    expect(verdict('git pull', stub({ branch: 'release' }))).toEqual({ decision: 'allow' });
    expect(verdict('git checkout release && git pull && git branch -d feat', stub({ branch: 'feat' }))).toEqual({ decision: 'allow' });
  });

  test('the harness-only and release exemptions are main\'s only', () => {
    const harness = { diffSinceBase: { files: ['CLAUDE.md'], overrideChanged: false } };
    expect(verdict('git push origin HEAD:main', stub(harness))).toEqual({ decision: 'allow' });
    expect(verdict('git push origin HEAD:release', stub(harness)).decision).toBe('block');
    const release = { diffSinceBase: { files: ['CHANGELOG.md'], overrideChanged: false, releaseOnly: true } };
    expect(verdict('git push origin HEAD:main', stub(release))).toEqual({ decision: 'allow' });
    expect(verdict('git push origin HEAD:release', stub(release)).decision).toBe('block');
    // After a flag, a harness-only diff passes on main and needs a new check on release.
    const since = { flag: { commit: 'b'.repeat(40) }, isAncestor: true, diffSinceFlag: { files: ['CLAUDE.md'], overrideChanged: false } };
    expect(verdict('git push origin HEAD:main', stub(since))).toEqual({ decision: 'allow' });
    expect(verdict('git push origin HEAD:release', stub(since)).reason).toMatch(/Code changed after the last quality check/);
    // A speed-mode flag counts on release as on main.
    expect(verdict('git push origin HEAD:release', stub({ flag: { commit: HEAD, mode: 'speed' } }))).toEqual({ decision: 'allow' });
  });

  test('trunk rewrites of release, and a declaration that cannot be read', () => {
    expect(verdict('git branch -f release feat', stub({ protectedMentioned: true })).decision).toBe('block');
    expect(verdict('git branch -f release feat', stub({ protectedMentioned: false }))).toEqual({ decision: 'allow' });
    const broken = stub({ declarations: { branches: [], branchesError: 'workflow.protectedBranches must be an array of branch names', deny: [], denyError: null } });
    const v = verdict('git push origin feat', broken);
    expect(v).toMatchObject({ decision: 'block', rule: '5' });
    expect(v.reason).toMatch(/declarations in the committed \.ai-dev-helm\.json cannot be read \(workflow\.protectedBranches must be an array/);
    for (const command of ['git status', 'git commit -m "push later"', 'npm test']) expect(verdict(command, broken), command).toEqual({ decision: 'allow' });
  });
});

describe('D3: the product\'s denied commands', () => {
  const declared = (deny) => ({ denyMentioned: true, declarations: { branches: [], branchesError: null, deny, denyError: null } });
  const render = parseDeclarations(JSON.stringify({ gate: { denyCommands: [RENDER] } })).deny;

  test('the Render rule refuses the full replacement and lets one key and GET through', () => {
    for (const [command, shell] of [
      ['curl -X PUT https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl --request PUT https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl -XPUT "https://api.render.com/v1/services/srv/env-vars?x=1"', 'posix'],
      ['curl -X PUT \\\n  https://api.render.com/v1/services/srv/env-vars -d @vars.json', 'posix'],
      ['Invoke-RestMethod -Method Put https://api.render.com/v1/services/srv/env-vars/', 'powershell'],
    ]) {
      expect(verdict(command, stub(declared(render)), shell), command).toEqual({ decision: 'block', rule: '2', reason: RENDER.reason });
    }
    for (const command of ['curl --request PUT https://api.render.com/v1/services/srv/env-vars/SAFE_KEY', 'curl https://api.render.com/v1/services/srv/env-vars', 'curl -X GET https://api.render.com/v1/services/srv/env-vars']) {
      expect(verdict(command, stub(declared(render))), command).toEqual({ decision: 'allow' });
    }
    // Not read when the work tree's manifest does not mention them.
    expect(verdict('curl -X PUT https://api.render.com/v1/services/srv/env-vars', stub({ ...declared(render), denyMentioned: false }))).toEqual({ decision: 'allow' });
  });

  test('the example in hook-contract is this rule', () => {
    const doc = fs.readFileSync(path.join(PACKAGE_ROOT, 'skills', 'project', 'quality-check', 'references', 'hook-contract.md'), 'utf8').replace(/\r\n/g, '\n');
    const block = /\n```json\n([\s\S]*?)\n```/.exec(doc);
    expect(JSON.parse(block[1]).gate.denyCommands).toEqual([RENDER]);
  });

  test('a broken declaration blocks the commands with a gate word only', () => {
    const broken = stub({ denyMentioned: true, declarations: { branches: [], branchesError: null, deny: [], denyError: 'gate.denyCommands[0].all[0] is not a valid regular expression' } });
    expect(verdict('git push origin feat', broken).reason).toMatch(/cannot be read \(gate\.denyCommands\[0\]/);
    expect(verdict('curl -X PUT https://api.render.com/v1/services/srv/env-vars', broken)).toEqual({ decision: 'allow' });
  });

  test('a pathological command is judged within a second', () => {
    const ctx = stub(declared(render));
    for (const command of [
      `curl -X${' '.repeat(60000)}GET https://api.render.com/v1/services/srv/env-vars`,
      `curl -Method${' '.repeat(60000)}x api.render.com/env-vars`,
      `git ${Array.from({ length: 500 }, () => '"a"').join(' ')} notpush`,
    ]) {
      const start = Date.now();
      classify(command, ctx);
      expect(Date.now() - start, command.slice(0, 20)).toBeLessThan(1000);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The hook itself: real repositories (D1-D4)
// ---------------------------------------------------------------------------------------------------------------
describe('the hook (integration)', { timeout: 120000 }, () => {
  let root;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-protected-')); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  // main (= origin/main) with the manifest, release (= origin/release) cut from it, and feat with a code commit.
  const repo = (name, manifest = { workflow: { protectedBranches: ['release'] } }) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const g = gitIn(dir);
    const put = (file, content) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content); g('add', '-f', file); };
    g('init', '-q', '-b', 'main');
    put('app.js', '1\n');
    if (manifest !== null) put('.ai-dev-helm.json', typeof manifest === 'string' ? manifest : JSON.stringify({ version: '3.7.1', ...manifest }, null, 2));
    g('commit', '-q', '-m', 'init');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('branch', 'release');
    g('update-ref', 'refs/remotes/origin/release', 'HEAD');
    g('checkout', '-q', '-b', 'feat');
    put('code.js', 'x\n');
    g('commit', '-q', '-m', 'feature');
    return { dir, g, put, flag: () => fs.writeFileSync(path.join(dir, '.quality-check-passed'), JSON.stringify({ branch: g('branch', '--show-current'), commit: g('rev-parse', 'HEAD') })) };
  };
  const hook = (cwd, payload, args = []) => spawnSync(process.execPath, [HOOK, ...args], { cwd, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 30000 });
  const run = (cwd, command, tool = 'Bash') => {
    const r = hook(cwd, { cwd, tool_name: tool, tool_input: { command } });
    return r.stdout.trim() ? JSON.parse(r.stdout) : { decision: 'allow' };
  };

  test('D1: Monitor is a shell call; only a WebSocket source is not judged', () => {
    const r = repo('monitor', null);
    expect(run(r.dir, 'git push origin main', 'Monitor').decision).toBe('block');
    expect(run(r.dir, 'git status', 'Monitor')).toEqual({ decision: 'allow' });
    const ws = hook(r.dir, { cwd: r.dir, tool_name: 'Monitor', tool_input: { ws: { url: 'wss://example.com/s' }, description: 'x', timeout_ms: 1000 } });
    expect(ws.stdout.trim()).toBe('');
    const neither = hook(r.dir, { cwd: r.dir, tool_name: 'Monitor', tool_input: { description: 'x', timeout_ms: 1000 } });
    expect(JSON.parse(neither.stdout).decision).toBe('block');
  });

  test('D2: release protected by the committed declaration (HEAD and the trunk, never the working tree)', () => {
    const r = repo('release');
    r.flag();
    for (const command of ['git push origin :release', 'git push origin --delete release', 'git push --force origin release']) {
      expect(run(r.dir, command).decision, command).toBe('block');
    }
    fs.rmSync(path.join(r.dir, '.quality-check-passed'), { force: true });
    expect(run(r.dir, 'git push origin HEAD:release').decision).toBe('block');
    r.g('checkout', '-q', 'release');
    r.put('hotfix.js', 'h\n');
    r.g('commit', '-q', '-m', 'hotfix on release');
    expect(run(r.dir, 'git push').decision).toBe('block');
    expect(run(r.dir, 'git merge feat').decision).toBe('block');
    // The declaration removed in the working tree only: still protected.
    fs.writeFileSync(path.join(r.dir, '.ai-dev-helm.json'), '{}\n');
    expect(run(r.dir, 'git push origin release').decision).toBe('block');
    r.g('checkout', '--', '.ai-dev-helm.json');
    // A feature branch that commits the removal: the trunk's declaration still counts.
    r.g('checkout', '-q', 'feat');
    r.put('.ai-dev-helm.json', '{"version":"3.7.1"}\n');
    r.g('commit', '-q', '-m', 'drop the declaration');
    fs.rmSync(path.join(r.dir, '.quality-check-passed'), { force: true });
    const v = run(r.dir, 'git push origin HEAD:release');
    expect(v.decision).toBe('block'); // a candidate only because release is in T
    expect(v.reason).toMatch(/Gate control-plane changed: \.ai-dev-helm\.json/);
    // The same repository without the declaration: release is an ordinary branch (3.7.0).
    const plain = repo('plain', {});
    expect(run(plain.dir, 'git push origin HEAD:release')).toEqual({ decision: 'allow' });
    expect(run(plain.dir, 'git push origin --delete release')).toEqual({ decision: 'allow' });
  });

  test('D2: platform\'s release procedure goes through without a flag; content main lacks does not; no origin/main is no route', () => {
    const r = repo('procedure');
    // feat is merged into main (origin/main moves); release takes in main by its SHA, then is pushed.
    r.g('checkout', '-q', 'main');
    r.g('merge', '-q', '--ff-only', 'feat');
    r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const sha = r.g('rev-parse', 'HEAD');
    r.g('checkout', '-q', 'release');
    expect(run(r.dir, `git merge --no-ff -m "release" ${sha}`)).toEqual({ decision: 'allow' });
    expect(run(r.dir, 'git merge origin/main')).toEqual({ decision: 'allow' });
    r.g('merge', '-q', '--no-ff', '-m', 'release', sha);
    expect(run(r.dir, 'git push origin release')).toEqual({ decision: 'allow' });
    expect(run(r.dir, 'git push')).toEqual({ decision: 'allow' });
    expect(run(r.dir, 'git push origin origin/main:release')).toEqual({ decision: 'allow' });
    // A commit on release that main lacks: the push and further merges need a flag.
    r.put('hotfix.js', 'h\n');
    r.g('commit', '-q', '-m', 'hotfix');
    expect(run(r.dir, 'git push origin release').decision).toBe('block');
    // main moves on: taking it in now merges into a release that holds content main lacks.
    r.g('checkout', '-q', 'main');
    r.put('next.js', 'n\n');
    r.g('commit', '-q', '-m', 'next');
    r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.g('checkout', '-q', 'release');
    expect(run(r.dir, 'git merge origin/main').decision).toBe('block');
    // Without origin/main (a local main only) the route is not used.
    const local = repo('no-origin');
    local.g('checkout', '-q', 'release');
    local.g('update-ref', '-d', 'refs/remotes/origin/main');
    expect(run(local.dir, 'git push origin release').decision).toBe('block');
  });

  test('D2: a declaration that cannot be read blocks the commands with a gate word, and says so on stderr otherwise', () => {
    const r = repo('broken', { workflow: { protectedBranches: 'release' } });
    const v = run(r.dir, 'git push origin feat');
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/workflow\.protectedBranches must be an array of branch names/);
    const status = hook(r.dir, { cwd: r.dir, tool_name: 'Bash', tool_input: { command: 'git branch -f release feat' } });
    expect(status.stdout.trim()).toBe('');
    expect(status.stderr).toMatch(/protectedBranches must be an array/);
    expect(run(r.dir, 'git status')).toEqual({ decision: 'allow' });
  });

  test('D3: the Render rule in the committed manifest, for Claude, Codex and Cursor alike', () => {
    const r = repo('render', { gate: { denyCommands: [RENDER] } });
    expect(run(r.dir, 'curl -X PUT https://api.render.com/v1/services/srv/env-vars')).toMatchObject({ decision: 'block', reason: RENDER.reason });
    expect(run(r.dir, 'Invoke-RestMethod -Method Put https://api.render.com/v1/services/srv/env-vars/', 'PowerShell').decision).toBe('block');
    expect(run(r.dir, 'curl --request PUT https://api.render.com/v1/services/srv/env-vars/SAFE_KEY')).toEqual({ decision: 'allow' });
    expect(run(r.dir, 'curl https://api.render.com/v1/services/srv/env-vars')).toEqual({ decision: 'allow' });
    const cursor = hook(r.dir, { hook_event_name: 'beforeShellExecution', command: 'curl -X PUT https://api.render.com/v1/services/srv/env-vars', cwd: r.dir }, ['cursor']);
    expect(JSON.parse(cursor.stdout)).toEqual({ permission: 'deny', user_message: RENDER.reason, agent_message: RENDER.reason });
    const broken = repo('render-broken', { gate: { denyCommands: [{ all: ['('], reason: 'x' }] } });
    expect(run(broken.dir, 'git push origin feat').reason).toMatch(/gate\.denyCommands\[0\]\.all\[0\] is not a valid regular expression/);
    const ls = hook(broken.dir, { cwd: broken.dir, tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(ls.stdout.trim()).toBe('');
    expect(ls.stderr).toMatch(/is not a valid regular expression/);
  });

  test('D4: Cursor\'s input and output', () => {
    const r = repo('cursor', null);
    const cursor = (payload) => hook(r.dir, payload, ['cursor']);
    const denied = cursor({ hook_event_name: 'beforeShellExecution', command: 'git push origin HEAD:main', cwd: r.dir });
    const out = JSON.parse(denied.stdout);
    expect(out.permission).toBe('deny');
    expect(out.user_message).toMatch(/Quality check not passed/);
    expect(out.agent_message).toBe(out.user_message);
    expect(JSON.parse(cursor({ command: 'npm test', cwd: r.dir }).stdout)).toEqual({ permission: 'allow' });
    // Unreadable JSON: fail-open #1 with a note; JSON without a command string: refused.
    const junk = cursor('not json');
    expect(JSON.parse(junk.stdout)).toEqual({ permission: 'allow' });
    expect(junk.stderr).toMatch(/unreadable hook payload/);
    expect(JSON.parse(cursor({ cwd: r.dir }).stdout).permission).toBe('deny');
    expect(JSON.parse(cursor(null).stdout).permission).toBe('deny');
    // Outside a repository: fail-open #2, an explicit allow.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-cursor-outside-'));
    try {
      expect(JSON.parse(hook(outside, { command: 'git push origin main', cwd: outside }, ['cursor']).stdout)).toEqual({ permission: 'allow' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
