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
const { pathToFileURL } = require('url');
const { PACKAGE_ROOT } = require('./utils');
const { classify } = require('../templates/hooks/quality-gate.cjs');
const workflow = require('./workflow');

const HOOK = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');

// The gate is one file with a fixed public API (lib/quality-gate-api.test.js), so its internals are read here by
// evaluating the file in a sandbox - the hook itself does not run. `execFileSync`, when given, stands in for
// child_process's (the git the gate runs).
function internals(names, execFileSync = null) {
  const source = fs.readFileSync(HOOK, 'utf8').replace(/^#!.*/, '');
  const load = (m) => (m === 'child_process' && execFileSync ? { ...require(m), execFileSync } : require(m));
  const sandbox = { require: load, module: { exports: {} }, process, Buffer, console, __filename: HOOK, __dirname: path.dirname(HOOK) };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(`${source}\n;this.__internals = { ${names.join(', ')} };`, sandbox);
  return sandbox.__internals;
}
const { parseDeclarations, combineDeclarations, treeMode } = internals(['parseDeclarations', 'combineDeclarations', 'treeMode']);

// platform's Render rule (results/platform-3.7.0.md, 1), written without nested quantifiers.
const RENDER = {
  all: [
    '(?:-X|--request)[\\s=]*["\']?PUT\\b|(?:^|\\s)(?:-T|--upload-file)(?:\\s|=)|(?:^|\\s)-T(?:["\'@]|-(?:\\s|$)|\\S*[./\\\\])|(?:^|\\s)-Method[\\s:]*["\']?Put\\b|(?:^|\\s)PUT\\s+(?:https?://|\\S*api\\.render\\.com)',
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
    const both = combineDeclarations(deny([RENDER]), deny([RENDER, { all: ['b'], reason: 'r' }])).decl;
    expect(both.deny.map((r) => r.reason)).toEqual([RENDER.reason, 'r']);
    const broken = combineDeclarations(parseDeclarations('{}'), parseDeclarations('{"workflow":{"protectedBranches":["hotfix"]},')).decl;
    expect(broken.branches).toEqual([]);
    expect(broken.branchesError).toMatch(/not valid JSON/);
  });

  test('each version reads each kind as none, read or broken; a value broken at the trunk gives way only to HEAD reading that kind', () => {
    const decl = (doc) => parseDeclarations(typeof doc === 'string' ? doc : JSON.stringify(doc));
    const fixed = decl({ workflow: { protectedBranches: ['release'] }, gate: { denyCommands: [RENDER] } });
    // The trunk's text broken around both words, HEAD reading both: HEAD's declarations alone, the trunk's error reported.
    const brokenBoth = '{ "workflow": { "protectedBranches": ["release"] }, "gate": { "denyCommands": [] }, ';
    const healed = combineDeclarations(fixed, decl(brokenBoth));
    expect(healed.decl).toMatchObject({ branches: ['release'], branchesError: null, denyError: null, gitError: null });
    expect(healed.decl.deny).toHaveLength(1);
    expect(healed.skipped).toEqual(['.ai-dev-helm.json is not valid JSON']);
    // C2-H1: HEAD reads one kind only (a branch cut before the other kind was declared). The trunk's text names both, so
    // the kind HEAD does not declare stays an error - in either direction.
    const denyOnly = combineDeclarations(decl({ gate: { denyCommands: [RENDER] } }), decl(brokenBoth));
    expect(denyOnly.decl.branchesError).toMatch(/not valid JSON/);
    expect(denyOnly.decl.branches).toEqual([]);
    expect(denyOnly.decl.deny).toHaveLength(1);
    const branchesOnly = combineDeclarations(decl({ workflow: { protectedBranches: ['release'] } }), decl(brokenBoth));
    expect(branchesOnly.decl).toMatchObject({ branches: ['release'], branchesError: null });
    expect(branchesOnly.decl.denyError).toMatch(/not valid JSON/);
    // C2-H2: a trunk text that names neither kind declares neither, broken or not: nothing to stand for, no error -
    // the 3.7.0 decision (whatever HEAD has).
    for (const trunk of ['{', '[]', '"x"', JSON.stringify({ workflow: 'x', gate: 5 }), '{"version": "3.7.0", ']) {
      for (const head of [null, {}, { version: '3.7.1' }]) {
        const v = combineDeclarations(head === null ? null : decl(head), decl(trunk));
        expect(v, `${JSON.stringify(head)} / ${trunk}`).toEqual({ decl: { branches: [], branchesError: null, deny: [], denyError: null, gitError: null }, skipped: [] });
      }
      // A HEAD that declares: its declarations, nothing skipped (the trunk declared nothing).
      const v = combineDeclarations(fixed, decl(trunk));
      expect(v.decl).toMatchObject({ branches: ['release'], branchesError: null, denyError: null });
      expect(v.skipped).toEqual([]);
    }
    // The same holds at HEAD: a broken HEAD text that names neither kind reads as none (the trunk's declarations stand).
    expect(combineDeclarations(decl('{'), fixed).decl).toMatchObject({ branches: ['release'], branchesError: null, denyError: null });
    // HEAD not declaring the broken kind (cut before the declaration, one that removed it, no manifest at HEAD): the
    // trunk's error stands - such a branch must not lose the trunk's protection.
    for (const head of [null, {}, { version: '3.7.1' }, { workflow: {} }, { gate: {} }, { notes: 'protectedBranches' }]) {
      for (const trunk of ['{"workflow":{"protectedBranches":["release"]},', '["protectedBranches"]', JSON.stringify({ workflow: { protectedBranches: 'release' } }), JSON.stringify({ workflow: 'protectedBranches' })]) {
        const v = combineDeclarations(head === null ? null : decl(head), decl(trunk));
        expect(v.decl.branchesError, `${JSON.stringify(head)} / ${trunk}`).not.toBeNull();
        expect(v.decl.branches).toEqual([]);
        expect(v.skipped).toEqual([]);
      }
    }
    // An empty array is a reading: the way to drop a declaration while the trunk's is broken (C2-M4).
    expect(combineDeclarations(decl({ gate: { denyCommands: [] } }), decl({ gate: { denyCommands: [{ all: ['('], reason: 'x' }] } })).decl).toMatchObject({ deny: [], denyError: null });
    // A kind broken in a readable trunk file: only HEAD declaring that same kind stands for it.
    const brokenDeny = decl({ workflow: { protectedBranches: ['release'] }, gate: { denyCommands: [{ all: ['('], reason: 'x' }] } });
    const partial = combineDeclarations(decl({ gate: { denyCommands: [RENDER] } }), brokenDeny);
    expect(partial.decl).toMatchObject({ branches: ['release'], branchesError: null, denyError: null });
    expect(partial.decl.deny.map((r) => r.reason)).toEqual([RENDER.reason]);
    expect(partial.skipped).toHaveLength(1);
    expect(combineDeclarations(decl({ gate: { denyCommands: [RENDER] } }), decl({ workflow: { protectedBranches: 'release' } })).decl.branchesError).toMatch(/must be an array/);
    expect(combineDeclarations(decl({}), brokenDeny).decl.denyError).toMatch(/not a valid regular expression/);
    expect(combineDeclarations(decl({ workflow: { protectedBranches: ['release'] } }), brokenDeny).decl.denyError).toMatch(/not a valid regular expression/);
    // Broken at HEAD in a kind it names: an error, whatever the trunk.
    expect(combineDeclarations(decl(brokenBoth), fixed).decl.branchesError).toMatch(/not valid JSON/);
    expect(combineDeclarations(decl(brokenBoth), decl(brokenBoth)).decl.denyError).toMatch(/not valid JSON/);
    expect(combineDeclarations(decl({ workflow: { protectedBranches: 'x' } }), fixed).decl.branchesError).toMatch(/must be an array/);
    // A version git could not give (a partial clone without the blob, a failure): an error HEAD cannot stand for.
    for (const [head, trunk] of [[fixed, { unreadable: 'gone' }], [{ unreadable: 'gone' }, fixed], [{ unreadable: 'gone' }, null]]) {
      const v = combineDeclarations(head, trunk).decl;
      expect(v).toMatchObject({ branches: [], deny: [], branchesError: 'gone', denyError: 'gone', gitError: 'gone' });
    }
    expect(combineDeclarations(fixed, null)).toEqual({ decl: { branches: ['release'], branchesError: null, deny: fixed.deny, denyError: null, gitError: null }, skipped: [] });
    expect(combineDeclarations(null, null).decl).toMatchObject({ branches: [], deny: [], branchesError: null, denyError: null });
  });

  test('a root tree is read entry by entry (SHA-1 and SHA-256 object names)', () => {
    const entry = (mode, name, bytes) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.alloc(bytes, 0x20)]);
    for (const bytes of [20, 32]) {
      const tree = (entries) => ({ oid: 'a'.repeat(bytes * 2), content: Buffer.concat(entries) });
      // An object name of spaces does not end an entry early.
      const t = tree([entry('100644', '.ai-dev-helm.jso', bytes), entry('40000', 'lib', bytes), entry('100644', '.ai-dev-helm.json', bytes)]);
      expect(treeMode(t, '.ai-dev-helm.json')).toBe('100644');
      expect(treeMode(tree([entry('120000', '.ai-dev-helm.json', bytes)]), '.ai-dev-helm.json')).toBe('120000'); // C3-H1
      expect(treeMode(tree([entry('100644', '.ai-dev-helm.jsonx', bytes), entry('100644', 'x .ai-dev-helm.json', bytes)]), '.ai-dev-helm.json')).toBe(false);
      expect(treeMode(tree([]), '.ai-dev-helm.json')).toBe(false);
      expect(treeMode({ oid: t.oid, content: t.content.slice(0, -1) }, '.ai-dev-helm.json')).toBeNull();
    }
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
    // The refusal names the protected branch.
    expect(verdict('git push origin HEAD:release', stub()).reason).toMatch(/^Quality check not passed\. Run the quality-check skill before merging into main \(or the protected branch release\) - /);
    // With a flag on HEAD the push goes through, as to main.
    expect(verdict('git push origin HEAD:release', stub(flagged))).toEqual({ decision: 'allow' });
  });

  test('a push of content main already has needs no flag (main-passed route); origin/main unknown is no route', () => {
    const passed = { mainPassed: (src) => src === 'HEAD' || src === 'origin/main' };
    expect(verdict('git push origin HEAD:release', stub(passed))).toEqual({ decision: 'allow' });
    expect(verdict('git push', stub({ ...passed, branch: 'release' }))).toEqual({ decision: 'allow' });
    expect(verdict('git push origin origin/main:release', stub(passed))).toEqual({ decision: 'allow' });
    // A feature branch whose @{push} is origin/release, holding only what main has (H-19(d)).
    expect(verdict('git push', stub({ ...passed, pushTarget: 'origin/release' }))).toEqual({ decision: 'allow' });
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
    // C2-M4: a branch that drops the key keeps the trunk's error - the reason says how to drop one.
    expect(v.reason).toMatch(/to drop a declaration, set it to an empty array \(\[\]\) first, and remove the key after that is in the trunk/);
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
      ['curl -T vars.json https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl --upload-file=vars.json https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ["Invoke-RestMethod -Method 'Put' https://api.render.com/v1/services/srv/env-vars", 'powershell'],
      ['Invoke-RestMethod -Method:Put https://api.render.com/v1/services/srv/env-vars', 'powershell'],
      ['http PUT api.render.com/v1/services/srv/env-vars < vars.json', 'posix'],
      ['curl https://api.render.com/v1/services/srv/env-vars -T vars.json', 'posix'],
      ['curl -T - https://api.render.com/v1/services/srv/env-vars < vars.json', 'posix'],
      ['curl -T "my vars.json" https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl -Tvars.json https://api.render.com/v1/services/srv/env-vars', 'posix'],
    ]) {
      expect(verdict(command, stub(declared(render)), shell), command).toEqual({ decision: 'block', rule: '2', reason: RENDER.reason });
    }
    for (const command of ['curl --request PUT https://api.render.com/v1/services/srv/env-vars/SAFE_KEY', 'curl https://api.render.com/v1/services/srv/env-vars', 'curl -X GET https://api.render.com/v1/services/srv/env-vars', 'curl -T v.txt https://api.render.com/v1/services/srv/env-vars/SAFE_KEY']) {
      expect(verdict(command, stub(declared(render))), command).toEqual({ decision: 'allow' });
    }
    // C3-H2: every `-T` / `--upload-file` followed by a space or `=` is an upload, whatever its argument (as in aef0433's
    // example) - a variable, a process substitution, a file without an extension.
    for (const [command, shell] of [
      ['curl -T $VARS https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl -T ${VARS} https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl -T <(jq . vars.json) https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl -T vars https://api.render.com/v1/services/srv/env-vars', 'posix'],
      ['curl.exe -T $F https://api.render.com/v1/services/srv/env-vars', 'powershell'],
      ['curl.exe -T $env:BODY https://api.render.com/v1/services/srv/env-vars', 'powershell'],
      ['curl --upload-file $VARS https://api.render.com/v1/services/srv/env-vars', 'posix'],
    ]) {
      expect(verdict(command, stub(declared(render)), shell), command).toEqual({ decision: 'block', rule: '2', reason: RENDER.reason });
    }
    // The limit of that (hook-contract): the patterns ignore case, so `-T` is also `-t` - a GET of the list with
    // `column -t` / `xargs -t` / `sort -t` in the same command is refused too (split the command).
    for (const command of [
      'curl -s https://api.render.com/v1/services/srv/env-vars | column -t -s,',
      'echo srv | xargs -t curl https://api.render.com/v1/services/srv/env-vars',
      'curl -s https://api.render.com/v1/services/srv/env-vars | sort -t. -k1',
    ]) {
      expect(verdict(command, stub(declared(render))), command).toEqual({ decision: 'block', rule: '2', reason: RENDER.reason });
    }
    for (const command of ['curl -s https://api.render.com/v1/services/srv/env-vars | column', 'curl -s https://api.render.com/v1/services/srv/env-vars | column -t', 'curl -s https://api.render.com/v1/services/srv/env-vars | sort -t, -k1']) {
      expect(verdict(command, stub(declared(render))), command).toEqual({ decision: 'allow' });
    }
    // Past the command budget the patterns are not tried, so a declaration refuses the command (the denied form can
    // sit behind a large body); without one, such a command is judged as in 3.7.0.
    const body = 'A'.repeat(70000);
    for (const command of [`curl -X PUT --data-binary "${body}" https://api.render.com/v1/services/srv/env-vars`, `echo ${body}; npm test`]) {
      const v = verdict(command, stub(declared(render)));
      expect(v.decision).toBe('block');
      expect(v.reason).toMatch(/too long to check against the denied commands/);
      expect(verdict(command, stub({ denyMentioned: false, declarations: null }))).toEqual({ decision: 'allow' });
    }
    expect(verdict(`echo ${'é'.repeat(40000)}`, stub(declared(render))).reason).toMatch(/too long to check/); // bytes, not characters
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
      `Invoke-RestMethod -Method${':'.repeat(60000)}x api.render.com/env-vars`,
      `http PUT ${'a'.repeat(60000)} /env-vars`,
      `curl${' PUT'.repeat(15000)} api.render.com/env-vars`,
      `curl -T${' '.repeat(60000)}x api.render.com/env-vars`,
      `curl -T ${'a'.repeat(60000)} api.render.com/env-vars`,
      `curl${' -t a'.repeat(15000)} api.render.com/env-vars`,
      `git ${Array.from({ length: 500 }, () => '"a"').join(' ')} notpush`,
    ]) {
      const start = Date.now();
      classify(command, ctx);
      expect(Date.now() - start, command.slice(0, 20)).toBeLessThan(1000);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Reading the declarations with a stand-in git (makeCtx): the failures a real repository cannot be made to show
// ---------------------------------------------------------------------------------------------------------------
describe('reading the declarations: a git failure other than "not a repository" is unreadable, not none', () => {
  const failure = (status) => Object.assign(new Error('git failed'), { status, stderr: '' });
  // A root tree object holding `.ai-dev-helm.json` (mode `mode`), as one `cat-file --batch` answer.
  const treeAnswer = (mode = '100644') => {
    const content = Buffer.concat([Buffer.from(`${mode} .ai-dev-helm.json\0`), Buffer.alloc(20, 1)]);
    return Buffer.concat([Buffer.from(`${'c'.repeat(40)} tree ${content.length}\n`), content, Buffer.from('\n')]);
  };
  // One `cat-file --batch` answer for HEAD and the four BASE_REFS, each asked as `<name>:<manifest>`, `<name>`,
  // `<name>^{tree}`. `versions`: { HEAD: manifest text, ... } - a name not given is missing.
  const batch = (input, versions) => Buffer.concat(input.split('\n').filter(Boolean).map((line) => {
    const name = line.replace(/(:\.ai-dev-helm\.json|\^\{tree\})$/, '');
    if (!(name in versions)) return Buffer.from(`${line} missing\n`);
    if (line.endsWith(':.ai-dev-helm.json')) return Buffer.from(`${'b'.repeat(40)} blob ${Buffer.byteLength(versions[name])}\n${versions[name]}\n`);
    if (line.endsWith('^{tree}')) return treeAnswer();
    return Buffer.from(`${'d'.repeat(40)} commit 1\nx\n`);
  }));
  const ctxWith = (cwd, answer) => {
    const calls = [];
    const { makeCtx } = internals(['makeCtx'], (cmd, args, opts) => {
      const sub = args.includes('cat-file') ? 'cat-file' : args.includes('rev-parse') ? 'rev-parse' : args.find((a) => !a.startsWith('-') && !a.includes('='));
      calls.push(sub);
      const r = answer(sub, opts);
      if (r instanceof Error) throw r;
      return r;
    });
    return { ctx: makeCtx(cwd), calls };
  };
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-ctx-'));
    fs.mkdirSync(path.join(dir, '.git'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('C2-H5: cat-file and rev-parse both failing without 128 (a timeout) block a command with a gate word', () => {
    const { ctx } = ctxWith(dir, () => failure(null));
    expect(ctx.declarations).toMatchObject({ gitError: 'git failed or timed out', branches: [], deny: [] });
    expect(ctx.state.failure).toBe('git-error');
    const v = classify('git push origin HEAD:release', ctx);
    expect(v).toMatchObject({ decision: 'block', rule: '5' });
    expect(v.reason).toMatch(/^git could not read the committed \.ai-dev-helm\.json \(git failed or timed out\)/);
    expect(classify('npm test', ctx)).toEqual({ decision: 'allow' });
    // cat-file failing while rev-parse answers: unreadable too.
    const half = ctxWith(dir, (sub) => (sub === 'rev-parse' ? `true\n${dir}\n` : failure(1))).ctx;
    expect(half.declarations.gitError).toBe('git failed or timed out');
  });

  test('git answering "not a repository" (128) reads as no declaration: the 3.7.0 route and its fail-open #2', () => {
    const { ctx } = ctxWith(dir, () => failure(128));
    expect(ctx.declarations).toBeNull();
    // Reading the declarations records nothing: a block decided without git stays a block (3.7.0). The judgement's own
    // question records the answer, for fail-open #2.
    expect(ctx.state.failure).toBeNull();
    expect(classify('echo $(git push)', ctx).decision).toBe('block');
    expect(ctx.toplevel).toBeNull();
    expect(ctx.state.failure).toBe('not-a-repo');
  });

  test('C2-H4: where the .git walk is not made (a UNC path), git finds the work tree and the declarations are read', () => {
    const unc = String.raw`\\fileserver\share\repo`;
    const inputs = [];
    const { ctx, calls } = ctxWith(unc, (sub, opts) => {
      if (sub === 'rev-parse') return 'true\n//fileserver/share/repo\n';
      inputs.push(String(opts.input));
      return batch(String(opts.input), { HEAD: '{}', 'refs/remotes/origin/main': JSON.stringify({ workflow: { protectedBranches: ['release'] } }) });
    });
    expect(ctx.declarations).toMatchObject({ branches: ['release'], branchesError: null, gitError: null });
    expect(calls).toEqual(['rev-parse', 'cat-file']);
    expect(inputs[0].split('\n').slice(0, 3)).toEqual(['HEAD:.ai-dev-helm.json', 'HEAD', 'HEAD^{tree}']);
    // A failure there is unreadable as well; "not a repository" is none.
    expect(ctxWith(unc, () => failure(null)).ctx.declarations.gitError).toBe('git failed or timed out');
    expect(ctxWith(unc, () => failure(128)).ctx.declarations).toBeNull();
  });

  test('C2-H3: a manifest the tree lists but the clone lacks, or a tree the clone lacks, is unreadable', () => {
    const entry = Buffer.concat([Buffer.from('100644 .ai-dev-helm.json\0'), Buffer.alloc(20, 1)]);
    const answer = (tree) => (sub, opts) => {
      if (sub === 'rev-parse') return `true\n${dir}\n`;
      return Buffer.from(String(opts.input).split('\n').filter(Boolean).map((line) => {
        if (line === 'HEAD:.ai-dev-helm.json') return `${'b'.repeat(40)} blob 2\n{}\n`;
        if (line === 'refs/remotes/origin/main') return `${'d'.repeat(40)} commit 1\nx\n`;
        if (line === 'HEAD') return `${'e'.repeat(40)} commit 1\nx\n`;
        if (line === 'HEAD^{tree}') return treeAnswer().toString('latin1');
        if (line === 'refs/remotes/origin/main^{tree}' && tree) return Buffer.concat([Buffer.from(`${'c'.repeat(40)} tree ${tree.length}\n`), tree, Buffer.from('\n')]).toString('latin1');
        return `${line} missing\n`;
      }).join(''), 'latin1');
    };
    expect(ctxWith(dir, answer(entry)).ctx.declarations.gitError).toBe('refs/remotes/origin/main:.ai-dev-helm.json is not in this clone and could not be fetched - fetch it with git cat-file -p refs/remotes/origin/main:.ai-dev-helm.json');
    expect(ctxWith(dir, answer(null)).ctx.declarations.gitError).toMatch(/^the tree of refs\/remotes\/origin\/main is not in this clone/);
    // The tree has no such entry: the trunk has no manifest - none.
    const other = Buffer.concat([Buffer.from('100644 app.js\0'), Buffer.alloc(20, 1)]);
    expect(ctxWith(dir, answer(other)).ctx.declarations).toMatchObject({ branches: [], deny: [], branchesError: null, denyError: null, gitError: null });
  });

  test('C3-H3: the read may fetch, without a prompt and within its time; a failed fetch reads again without fetching', () => {
    const release = JSON.stringify({ workflow: { protectedBranches: ['release'] } });
    const seen = [];
    // The gate copies process.env when it loads: without these here (Claude Code's own shell sets some), the values
    // seen are the gate's.
    const quiet = ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GCM_INTERACTIVE', 'GIT_TERMINAL_PROMPT', 'GIT_NO_LAZY_FETCH'];
    const saved = quiet.map((k) => [k, process.env[k]]);
    let loaded;
    try {
      for (const k of quiet) delete process.env[k];
      loaded = ctxWith(dir, (sub, opts) => {
        if (sub === 'rev-parse') return `true\n${dir}\n`;
        seen.push(opts);
        // The fetch fails (offline): the whole call fails, as git's does when it cannot fetch a missing object.
        if (opts.env.GIT_NO_LAZY_FETCH !== '1') return failure(128);
        return batch(String(opts.input), { HEAD: '{}', 'refs/remotes/origin/main': release });
      });
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
    const { ctx, calls } = loaded;
    expect(ctx.declarations).toMatchObject({ branches: ['release'], gitError: null });
    expect(calls).toEqual(['cat-file', 'cat-file']);
    expect(seen[0].env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' });
    expect('GIT_NO_LAZY_FETCH' in seen[0].env).toBe(false);
    expect(seen[0].timeout).toBeLessThanOrEqual(10000);
    expect(seen[0].timeout).toBeGreaterThan(5000);
    expect(seen[1].timeout).toBeLessThanOrEqual(5000);
    // A fetch that works: one call.
    const once = ctxWith(dir, (sub, opts) => batch(String(opts.input), { HEAD: '{}', 'refs/remotes/origin/main': release }));
    expect(once.ctx.declarations.branches).toEqual(['release']);
    expect(once.calls).toEqual(['cat-file']);
  });

  test('C3-H1: a manifest committed as a symbolic link (or any entry that is not a regular file) is no file - unreadable', () => {
    const release = JSON.stringify({ workflow: { protectedBranches: ['release'] } });
    const at = (trunkMode, headMode = '100644', headText = '{}') => ctxWith(dir, (sub, opts) => {
      if (sub === 'rev-parse') return `true\n${dir}\n`;
      return Buffer.concat(String(opts.input).split('\n').filter(Boolean).map((line) => {
        const head = line.startsWith('HEAD');
        const mode = head ? headMode : trunkMode;
        if (!head && !line.startsWith('refs/remotes/origin/main')) return Buffer.from(`${line} missing\n`);
        if (line.endsWith('^{tree}')) return treeAnswer(mode);
        // A symbolic link's blob is the path it points to (here a file that declares release).
        if (line.endsWith(':.ai-dev-helm.json')) {
          const text = mode === '120000' ? 'config/manifest.json' : head ? headText : release;
          return Buffer.from(`${'b'.repeat(40)} blob ${Buffer.byteLength(text)}\n${text}\n`);
        }
        return Buffer.from(`${'d'.repeat(40)} commit 1\nx\n`);
      }));
    }).ctx;
    const link = at('120000');
    const why = '.ai-dev-helm.json is a symbolic link, not a file';
    expect(link.declarations).toMatchObject({ branchesError: why, denyError: why });
    const v = classify('git push origin HEAD:release', link);
    expect(v).toMatchObject({ decision: 'block', rule: '5' });
    expect(v.reason).toContain(`cannot be read (${why})`);
    expect(at('100644', '120000').declarations.branchesError).toBe(why); // at HEAD as well
    expect(at('160000').declarations.branchesError).toBe('.ai-dev-helm.json is not a file'); // a submodule
    expect(at('100755').declarations).toMatchObject({ branches: ['release'], branchesError: null });
    // A branch that replaces the trunk's link with a file that declares both kinds: HEAD's stands for the trunk's.
    const fixed = at('120000', '100644', JSON.stringify({ workflow: { protectedBranches: ['release'] }, gate: { denyCommands: [] } }));
    expect(fixed.declarations).toMatchObject({ branches: ['release'], branchesError: null, denyError: null, gitError: null });
  });});

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
  const hook = (cwd, payload, args = [], env = process.env) => spawnSync(process.execPath, [HOOK, ...args], { cwd, env, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 30000 });
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
    // A command next to a ws is judged; a ws that is not an object (no WebSocket source) does not skip the judgement.
    const both = hook(r.dir, { cwd: r.dir, tool_name: 'Monitor', tool_input: { command: 'git push origin main', ws: { url: 'wss://example.com/s' }, description: 'x', timeout_ms: 1000 } });
    expect(JSON.parse(both.stdout).decision).toBe('block');
    const wsText = hook(r.dir, { cwd: r.dir, tool_name: 'Monitor', tool_input: { ws: 'wss://example.com/s', description: 'x', timeout_ms: 1000 } });
    expect(JSON.parse(wsText.stdout).decision).toBe('block');
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

  test('D2 / D3: a declaration broken at the trunk does not lock out the branch that fixes it', () => {
    const r = repo('broken-trunk', '{ "version": "3.7.1", "workflow": { "protectedBranches": ["release"] }, ');
    // feat still holds the trunk's broken manifest: refused, as before.
    expect(run(r.dir, 'git push origin feat').reason).toMatch(/not valid JSON/);
    r.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.1', workflow: { protectedBranches: ['release'] } }));
    r.g('commit', '-q', '-m', 'fix the manifest');
    const push = hook(r.dir, { cwd: r.dir, tool_name: 'Bash', tool_input: { command: 'git push origin feat' } });
    expect(push.stdout.trim()).toBe('');
    expect(push.stderr).toMatch(/trunk's \.ai-dev-helm\.json cannot be read \(\.ai-dev-helm\.json is not valid JSON\); judging with the ones committed at HEAD/);
    // HEAD's declaration is in force: release stays protected.
    expect(run(r.dir, 'git push origin HEAD:release').decision).toBe('block');
    // A branch that does not declare protected branches (cut before the declaration): the trunk's error stands.
    r.g('checkout', '-q', '-b', 'old', 'feat~1');
    r.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.0' }));
    r.g('commit', '-q', '-m', 'as before the declaration');
    expect(run(r.dir, 'git push origin HEAD:release').reason).toMatch(/cannot be read \(\.ai-dev-helm\.json is not valid JSON\)/);
  });

  test('D2: a branch without the manifest still meets the trunk\'s declaration; outside a repository is fail-open #2', () => {
    const r = repo('no-manifest');
    r.g('rm', '-q', '.ai-dev-helm.json');
    r.g('commit', '-q', '-m', 'remove the manifest');
    expect(fs.existsSync(path.join(r.dir, '.ai-dev-helm.json'))).toBe(false);
    expect(run(r.dir, 'git push origin HEAD:release').decision).toBe('block');
    expect(run(r.dir, 'git push origin feat')).toEqual({ decision: 'allow' });
    // A `.git` file pointing nowhere (a removed worktree's leftover), with a manifest: as in 3.7.0, not a repository.
    const gone = path.join(root, 'gone-worktree');
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, '.git'), `gitdir: ${path.join(root, 'no-such-dir')}\n`);
    fs.writeFileSync(path.join(gone, '.ai-dev-helm.json'), JSON.stringify({ version: '3.7.1' }));
    const v = hook(gone, { cwd: gone, tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } });
    expect(v.stdout.trim()).toBe('');
    expect(v.stderr).toMatch(/not inside a git repository/);
    // A block decided without git (not a simple form, a checkout in the same call) stays a block there and outside any
    // repository, as in 3.7.0: reading the declarations does not turn it into fail-open #2.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-outside-'));
    try {
      for (const dir of [gone, outside]) {
        for (const command of ['echo $(git push)', 'git checkout main && git merge feat']) {
          expect(run(dir, command).decision, `${path.basename(dir)}: ${command}`).toBe('block');
        }
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('C2-H1: a trunk text broken around both kinds - a branch declaring one kind does not lose the other', () => {
    const r = repo('broken-both', '{ "version": "3.7.1", "workflow": { "protectedBranches": ["release"] }, "gate": { "denyCommands": [] }, ');
    r.g('checkout', '-q', '-b', 'deny-only', 'feat~1');
    r.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.1', gate: { denyCommands: [RENDER] } }));
    r.g('commit', '-q', '-m', 'denied commands only');
    expect(run(r.dir, 'git push origin HEAD:release').reason).toMatch(/cannot be read \(\.ai-dev-helm\.json is not valid JSON\)/);
    r.g('checkout', '-q', '-b', 'branches-only', 'feat~1');
    r.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.1', workflow: { protectedBranches: ['release'] } }));
    r.g('commit', '-q', '-m', 'protected branches only');
    expect(run(r.dir, 'git push origin HEAD:branches-only').reason).toMatch(/cannot be read \(\.ai-dev-helm\.json is not valid JSON\)/);
  });

  test('C2-H2: without a declaration, a broken trunk manifest does not lock out the branch that fixes it (as in 3.7.0)', () => {
    const r = repo('broken-plain', '{ "version": "3.7.1", ');
    r.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.1' }));
    r.g('commit', '-q', '-m', 'fix the manifest');
    const push = hook(r.dir, { cwd: r.dir, tool_name: 'Bash', tool_input: { command: 'git push origin feat' } });
    expect(push.stdout.trim()).toBe('');
    expect(push.stderr).not.toMatch(/cannot be read/);
    r.flag();
    expect(run(r.dir, 'gh pr merge --squash')).toEqual({ decision: 'allow' });
    expect(run(r.dir, 'git push origin HEAD:release')).toEqual({ decision: 'allow' }); // release is an ordinary branch
  });

  test('C2-H3 / C3-H3: a partial clone fetches the trunk\'s manifest it lacks; one it cannot fetch blocks', () => {
    const src = repo('partial-src', {});
    src.g('checkout', '-q', 'main');
    src.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.1', workflow: { protectedBranches: ['release'] } }));
    src.g('commit', '-q', '-m', 'declare release');
    src.g('config', 'uploadpack.allowFilter', 'true');
    const clone = (from, name, filter) => {
      const dir = path.join(root, name);
      gitIn(root)('clone', '-q', `--filter=${filter}`, '-b', 'feat', pathToFileURL(from.dir).href, dir);
      return dir;
    };
    const missing = (dir, object) => spawnSync('git', ['cat-file', '-e', object], { cwd: dir, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).status !== 0;
    const offline = (dir, on) => gitIn(dir)('remote', 'set-url', 'origin', on ? pathToFileURL(path.join(root, 'no-such-remote')).href : pathToFileURL(src.dir).href);
    const blobless = clone(src, 'partial-blob', 'blob:none');
    expect(missing(blobless, 'origin/main:.ai-dev-helm.json')).toBe(true);
    // The remote cannot be reached: that version is unreadable, and the reason says how to fetch it.
    offline(blobless, true);
    const v = run(blobless, 'git push origin HEAD:release');
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/^git could not read the committed \.ai-dev-helm\.json \(refs\/remotes\/origin\/main:\.ai-dev-helm\.json is not in this clone and could not be fetched - fetch it with git cat-file -p refs\/remotes\/origin\/main:\.ai-dev-helm\.json\)/);
    // Reached: the hook fetches the blob, reads the declaration, and release is protected by it.
    offline(blobless, false);
    expect(run(blobless, 'git push origin HEAD:release').reason).toMatch(/Quality check not passed/);
    expect(missing(blobless, 'origin/main:.ai-dev-helm.json')).toBe(false);
    const treeless = clone(src, 'partial-tree', 'tree:0');
    offline(treeless, true);
    expect(run(treeless, 'git push origin HEAD:release').reason).toMatch(/\(the tree of refs\/remotes\/origin\/main is not in this clone and could not be fetched/);
    // Reached: the declaration is read (release is a candidate); the diff after it does not fetch, and a treeless clone
    // lacks the trees it needs - the block of 3.7.0 for such a clone, not one of the declarations.
    offline(treeless, false);
    const t = run(treeless, 'git push origin HEAD:release');
    expect(t.decision).toBe('block');
    expect(t.reason).not.toMatch(/\.ai-dev-helm\.json/);
  });

  test('C3-H3: without a declaration, a partial clone decides as 3.7.0 did - after a fetch that moved the trunk\'s manifest too', () => {
    const plain = repo('partial-plain', {});
    plain.g('config', 'uploadpack.allowFilter', 'true');
    const dir = path.join(root, 'partial-none');
    gitIn(root)('clone', '-q', '--filter=blob:none', '-b', 'feat', pathToFileURL(plain.dir).href, dir);
    const decide = () => ['git push origin feat', 'git push origin HEAD:release', 'git push origin --delete release'].map((command) => [command, run(dir, command)]);
    const allowed = (pairs) => pairs.forEach(([command, v]) => expect(v, command).toEqual({ decision: 'allow' }));
    allowed(decide());
    expect(run(dir, 'git push origin HEAD:main').decision).toBe('block');
    // The trunk's manifest changes (an upgrade bumps its version) and is fetched: the new blob is not in the clone.
    plain.g('checkout', '-q', 'main');
    plain.put('.ai-dev-helm.json', JSON.stringify({ version: '3.7.2' }, null, 2));
    plain.g('commit', '-q', '-m', 'upgrade');
    gitIn(dir)('fetch', '-q', 'origin');
    expect(spawnSync('git', ['cat-file', '-e', 'origin/main:.ai-dev-helm.json'], { cwd: dir, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).status).not.toBe(0);
    const push = hook(dir, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push origin feat' } });
    expect(push.stdout.trim()).toBe('');
    expect(push.stderr).not.toMatch(/cannot be read|could not read/);
    allowed(decide());
  });

  test('C3-H1: a manifest committed as a symbolic link is no file - the commands with a gate word block', () => {
    const r = repo('symlink', null);
    const target = JSON.stringify({ version: '3.7.1', workflow: { protectedBranches: ['release'] }, gate: { denyCommands: [RENDER] } });
    r.put('config/manifest.json', target);
    const link = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.dir, input: 'config/manifest.json', encoding: 'utf8' }).trim();
    r.g('update-index', '--add', '--cacheinfo', `120000,${link},.ai-dev-helm.json`);
    r.g('commit', '-q', '-m', 'the manifest as a link');
    r.g('checkout', '--', '.ai-dev-helm.json'); // a link where symbolic links work, a text file of its path elsewhere
    r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    for (const command of ['git push origin HEAD:release', 'git push origin --delete release', 'git push origin feat']) {
      const v = run(r.dir, command);
      expect(v.decision, command).toBe('block');
      expect(v.reason, command).toContain('cannot be read (.ai-dev-helm.json is a symbolic link, not a file)');
    }
    expect(run(r.dir, 'git status')).toEqual({ decision: 'allow' });
  });

  test.runIf(process.platform === 'win32')('C2-H4: a work tree on a UNC path reads its declarations', ({ skip }) => {
    const r = repo('unc', { workflow: { protectedBranches: ['release'] }, gate: { denyCommands: [RENDER] } });
    const real = fs.realpathSync.native(r.dir);
    const bs = String.fromCharCode(92);
    const unc = `${bs}${bs}localhost${bs}${real[0]}$${real.slice(2)}`; // the drive's administrative share
    if (!fs.existsSync(unc)) skip(); // no administrative share here
    // safe.directory for the UNC path, as an adopter allows it (environment configuration: no global file is touched).
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
    const at = (command) => {
      const out = hook(r.dir, { cwd: unc, tool_name: 'Bash', tool_input: { command } }, [], env).stdout.trim();
      return out ? JSON.parse(out) : { decision: 'allow' };
    };
    expect(at('git push origin HEAD:main').decision).toBe('block');
    expect(at('git push origin HEAD:release').decision).toBe('block');
    expect(at('curl -X PUT https://api.render.com/v1/services/srv/env-vars')).toMatchObject({ decision: 'block', reason: RENDER.reason });
    expect(at('git push origin feat')).toEqual({ decision: 'allow' });
  });

  test('C2-M1: a submodule change counts in the main-passed route whatever diff.ignoreSubmodules says', () => {
    const lib = repo('submodule-lib', null);
    const r = repo('submodule', { workflow: { protectedBranches: ['release'] } });
    r.g('checkout', '-q', 'main');
    r.g('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.dir, 'lib');
    r.g('commit', '-q', '-m', 'add lib');
    r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.g('branch', '-f', 'release');
    r.g('update-ref', 'refs/remotes/origin/release', 'HEAD');
    r.g('checkout', '-q', '-b', 'bump');
    gitIn(path.join(r.dir, 'lib'))('commit', '-q', '--allow-empty', '-m', 'move lib');
    r.g('add', 'lib');
    r.g('commit', '-q', '-m', 'bump lib');
    r.g('config', 'diff.ignoreSubmodules', 'all');
    expect(r.g('diff', '--quiet', 'refs/remotes/origin/main...HEAD')).toBe(''); // the setting hides the change
    expect(run(r.dir, 'git push origin HEAD:release').decision).toBe('block');
    // The same push of what main already holds goes through.
    expect(run(r.dir, 'git push origin origin/main:release')).toEqual({ decision: 'allow' });
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
