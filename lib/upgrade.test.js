'use strict';

// 3.7.0 (C3, C3n): `upgrade` from an "old release" - a copy of this package at version 3.5.99 with a few files
// changed - to this package. No network: the old release comes through baseDir, renders go to a scratch cache.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OLD_VERSION = '3.5.99';
const RUNTIME = 'documents/development/harness-runtime.md';
const OLD_LINE = 'OLD RELEASE LINE (replaced in the new release)';
const OLD_HARNESS_LINE = 'OLD HARNESS LINE (gone in the new release)';
const GONE = 'skills/project/quality-check/removed-in-new.md';

let workspace;
let oldPackage;
let runUpgrade;
let calledHook;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A product installed by the old release and committed. */
function product(name, { tools = 'claude-code,codex', stacks = 'nextjs-react', skills = 'all', manifest = {} } = {}) {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const r = spawnSync(process.execPath, [path.join(oldPackage, 'bin', 'cli.js'), 'init', '--project-name', 'Demo', '--tools', tools, '--stacks', stacks, '--skills', skills], {
    cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
  });
  if (r.status !== 0) throw new Error(r.stderr + r.stdout);
  for (const f of fs.readdirSync(dir)) if (/\.backup\.\d+$/.test(f)) fs.rmSync(path.join(dir, f));
  const file = path.join(dir, '.ai-dev-helm.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...manifest }, null, 2) + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'install old release');
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const manifestOf = (dir) => JSON.parse(read(dir, '.ai-dev-helm.json'));
const upgrade = (dir, opts = {}) => runUpgrade({ dir, baseDir: oldPackage, ...opts });
const actionsOf = (result, rel) => result.record.actions.filter((a) => a.path === rel).map((a) => a.action);

// 3.7.1 (D5): all upgrade may do to a product's .codex/hooks.json is append context-handoff on PreCompact,
// SessionStart and Stop. Every trust key Codex recorded (<event>:<group>:<handler>) keeps its hash.
function expectCodexOnlyAppended(dir, beforeText) {
  const { codexHookHash } = require('./codex-trust');
  const LABELS = { PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use', PreCompact: 'pre_compact', SessionStart: 'session_start', Stop: 'stop' };
  const keys = (json) => Object.fromEntries(Object.entries(json.hooks).flatMap(([event, groups]) => groups.flatMap((group, g) => group.hooks.map((h, i) => [`${LABELS[event] || event}:${g}:${i}`, codexHookHash(event, group.matcher, h, { platform: 'linux' })]))));
  const before = JSON.parse(beforeText);
  const after = JSON.parse(read(dir, '.codex/hooks.json'));
  const [k0, k1] = [keys(before), keys(after)];
  for (const [key, hash] of Object.entries(k0)) expect(k1[key], key).toBe(hash);
  expect(Object.keys(k1).filter((key) => !(key in k0)).sort()).toEqual(['pre_compact:0:0', 'session_start:0:0', 'stop:0:0']);
  for (const event of Object.keys(before.hooks)) expect(JSON.stringify(after.hooks[event]), event).toBe(JSON.stringify(before.hooks[event]));
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-upgrade-'));
  process.env.AI_DEV_HELM_CACHE_DIR = path.join(workspace, 'cache');
  oldPackage = path.join(workspace, 'old', 'package');
  for (const entry of ['bin', 'lib', 'skills', 'stacks', 'shared', 'templates', 'configs', 'package.json']) {
    if (fs.existsSync(path.join(ROOT, entry))) fs.cpSync(path.join(ROOT, entry), path.join(oldPackage, entry), { recursive: true, filter: (src) => !/\.test\.js$/.test(src) });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(oldPackage, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(oldPackage, 'package.json'), JSON.stringify({ ...pkg, version: OLD_VERSION }, null, 2));
  // The old release differs from the new one: line 3 of harness-runtime.md, one file the new release dropped,
  // and runtime-upgrade.md which the new release added.
  const runtime = path.join(oldPackage, 'shared', 'documents', 'harness-runtime.md');
  const lines = fs.readFileSync(runtime, 'utf8').split('\n');
  lines[2] = OLD_LINE;
  fs.writeFileSync(runtime, lines.join('\n'));
  fs.writeFileSync(path.join(oldPackage, GONE), 'only in the old release\n');
  fs.rmSync(path.join(oldPackage, 'shared', 'documents', 'runtime-upgrade.md'), { force: true });
  // Root templates as 3.6.0 and earlier shipped them: no managed-block markers, and one harness line the new
  // release no longer has.
  for (const file of ['CLAUDE.md.template', 'AGENTS.md.template', 'cursorrules.template']) {
    const template = path.join(oldPackage, 'templates', file);
    let text = fs.readFileSync(template, 'utf8').replace(/\r\n/g, '\n').replace(/^<!-- ai-dev-helm:(?:harness|skills|refs):(?:start|end) -->\n/gm, '');
    if (file !== 'cursorrules.template') text = text.replace('## Language Setting\n', `## Language Setting\n\n${OLD_HARNESS_LINE}\n`);
    expect(text).not.toMatch(/ai-dev-helm:(harness|skills|refs)/);
    fs.writeFileSync(template, text);
  }
  ({ runUpgrade } = require('./upgrade'));
  ({ calledHook } = require('./runtime-hooks'));
}, 120000);

// Removing the scratch products takes over the 10 s hook default on Windows runners.
afterAll(() => {
  delete process.env.AI_DEV_HELM_CACHE_DIR;
  fs.rmSync(workspace, { recursive: true, force: true });
}, 120000);

describe('upgrade (C3b)', () => {
  test('replaces, adds and removes per the two renders, then verifies complete; a second run changes nothing', () => {
    const dir = product('plain');
    const plan = upgrade(dir, { mode: 'plan' });
    expect(git(dir, 'status', '--short')).toBe('');
    expect(actionsOf(plan, RUNTIME)).toEqual(['replaced']);
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    expect(read(dir, RUNTIME)).not.toContain(OLD_LINE);
    expect(exists(dir, GONE)).toBe(false);
    expect(exists(dir, 'documents/development/runtime-upgrade.md')).toBe(true);
    const manifest = manifestOf(dir);
    expect(manifest.version).toBe(require('../package.json').version);
    expect(manifest.upgradedFrom).toBe(OLD_VERSION);
    expect(manifest.complete).toBe(true);
    expect(manifest.projectName).toBe('Demo');
    expect(result.record.verdict.missing).toEqual([]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'upgrade');
    const again = runUpgrade({ dir, baseDir: oldPackage });
    expect(again.exitCode).toBe(0);
    expect(again.record.actions.filter((a) => a.action !== 'up to date' && !a.action.startsWith('declared-out'))).toEqual([]);
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);

  test('a file the product deleted is added back unless an exclude with a reason keeps it out (C3n)', () => {
    const dir = product('deleted');
    fs.rmSync(path.join(dir, 'documents/development/harness-upgrade.md'));
    fs.rmSync(path.join(dir, 'skills/project/test-recommendation'), { recursive: true });
    git(dir, 'commit', '-qam', 'delete');
    const result = upgrade(dir);
    expect(exists(dir, 'documents/development/harness-upgrade.md')).toBe(true);
    expect(exists(dir, 'skills/project/test-recommendation/SKILL.md')).toBe(true);
    expect(result.exitCode).toBe(0);

    const kept = product('deleted-excluded', { manifest: { exclude: [{ part: 'test-recommendation', reason: 'the product runs no mutation testing' }] } });
    fs.rmSync(path.join(kept, 'skills/project/test-recommendation'), { recursive: true });
    git(kept, 'commit', '-qam', 'delete');
    const excluded = upgrade(kept);
    expect(exists(kept, 'skills/project/test-recommendation/SKILL.md')).toBe(false);
    expect(excluded.exitCode).toBe(0);
    expect(excluded.record.verdict.declared).toContain('skills/project/test-recommendation/SKILL.md');
  }, 240000);

  test('a declaration without a reason, or owned/seed over a harness rule file, is refused before anything is written', () => {
    const dir = product('declarations');
    const set = (extra) => write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), ...extra }, null, 2));
    set({ exclude: [{ part: 'lint' }] });
    expect(() => upgrade(dir)).toThrow(/exclude\[0\] has no reason/);
    set({ exclude: undefined, owned: [{ path: 'skills/project/quality-check/**', reason: 'ours' }] });
    expect(() => upgrade(dir)).toThrow(/owned "skills\/project\/quality-check\/\*\*" covers harness rule files/);
    set({ owned: undefined, seed: [{ path: '.claude/hooks/*.cjs', reason: 'ours' }] });
    expect(() => upgrade(dir)).toThrow(/seed ".claude\/hooks\/\*.cjs" covers harness rule files/);
    set({ seed: [{ path: 'documents/development/error-codes.md', reason: 'the product table' }] });
    expect(() => upgrade(dir, { mode: 'plan' })).not.toThrow();
  }, 240000);

  test('merges product edits with the release, and a merge without the release change is "not installed" (C3n)', () => {
    const dir = product('merged');
    write(dir, RUNTIME, read(dir, RUNTIME).replace(/\n*$/, '\n\nPRODUCT NOTE at the end\n'));
    git(dir, 'commit', '-qam', 'edit');
    const result = upgrade(dir);
    expect(actionsOf(result, RUNTIME)).toEqual(['merged']);
    expect(read(dir, RUNTIME)).toContain('PRODUCT NOTE at the end');
    expect(read(dir, RUNTIME)).not.toContain(OLD_LINE);
    expect(result.record.verdict.merged).toContain(RUNTIME);
    expect(result.exitCode).toBe(0);
    // The release's change goes missing afterwards: --verify reports it and fails.
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = OLD_LINE;
    write(dir, RUNTIME, lines.join('\n'));
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => m.path)).toContain(RUNTIME);
  }, 240000);

  test('a conflict leaves the file, writes <file>.ai-dev-helm-new, records pending and fails; --resolve after the merge', () => {
    const dir = product('conflict');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'commit', '-qam', 'edit');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(1);
    expect(read(dir, RUNTIME)).toContain('PRODUCT REWRITE');
    expect(read(dir, RUNTIME)).not.toMatch(/^<<<<<<< /m);
    expect(exists(dir, `${RUNTIME}.ai-dev-helm-new`)).toBe(true);
    expect(manifestOf(dir).pending).toEqual([{ path: RUNTIME, baseVersion: OLD_VERSION, conflict: expect.stringMatching(/^[a-f0-9]{64}$/), conflictRaw: [expect.stringMatching(/^[a-f0-9]{64}$/)] }]);
    expect(manifestOf(dir).complete).toBe(false);
    expect(() => runUpgrade({ dir, resolve: RUNTIME })).toThrow(/still exists/);
    write(dir, RUNTIME, read(dir, `${RUNTIME}.ai-dev-helm-new`));
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    expect(runUpgrade({ dir, resolve: RUNTIME }).exitCode).toBe(0);
    expect(manifestOf(dir).pending).toBeUndefined();
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);

  test('CRLF copies of unchanged files are not "changed on both sides", and keep CRLF when replaced (H2)', () => {
    const dir = product('crlf');
    for (const rel of [RUNTIME, 'skills/project/quality-check/SKILL.md']) write(dir, rel, read(dir, rel).replace(/\r?\n/g, '\r\n'));
    git(dir, 'commit', '-qam', 'crlf');
    const result = upgrade(dir);
    expect(actionsOf(result, RUNTIME)).toEqual(['replaced']);
    expect(actionsOf(result, 'skills/project/quality-check/SKILL.md')).toEqual(['up to date']);
    expect(read(dir, RUNTIME)).toContain('\r\n');
    expect(read(dir, RUNTIME).replace(/\r\n/g, '')).not.toContain('\n');
    expect(result.exitCode).toBe(0);
  }, 240000);

  test('a changed file left out by a declaration is reported with its diff, and does not fail the run (C3n speed)', () => {
    const dir = product('declared-changed', { manifest: { exclude: [{ path: RUNTIME, reason: 'kept by the product on purpose' }] } });
    const record = path.join(workspace, 'declared-record.md');
    const result = upgrade(dir, { recordPath: record });
    expect(result.exitCode).toBe(0);
    expect(read(dir, RUNTIME)).toContain(OLD_LINE);
    expect(result.record.declaredChanges.map((d) => d.path)).toEqual([RUNTIME]);
    expect(fs.readFileSync(record, 'utf8')).toMatch(new RegExp(`-${OLD_LINE.replace(/[()]/g, '\\$&')}`));
  }, 240000);

  test('keeps the product\'s own manifest keys and ignores unknown stacks', () => {
    const dir = product('keys', { manifest: { reviewBudgetScript: 'scripts/review.mjs', source: 'x', stacks: ['nextjs-react', 'custom-hono-react'] } });
    // 3.7.0 (C3h): reviewBudgetScript declares the product's own review-budget, so its file must exist (a missing
    // declared file is "not installed").
    write(dir, 'scripts/review.mjs', '// the product\'s review-budget\n');
    expect(upgrade(dir).exitCode).toBe(0);
    const manifest = manifestOf(dir);
    expect(manifest.reviewBudgetScript).toBe('scripts/review.mjs');
    expect(manifest.source).toBe('x');
    expect(manifest.stacks).toEqual(['nextjs-react', 'custom-hono-react']);
  }, 240000);
});

describe('upgrade: hook bodies and registrations (C3e)', () => {
  const runs = (json, event, name) => (json.hooks[event] || []).flatMap((e) => e.hooks).filter((h) => (calledHook(h.command) || {}).file === name);

  test('a hand-edited Claude registration is replaced once, keeping added keys; a removed one fails --verify', () => {
    const dir = product('registrations');
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    const gate = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /quality-gate/.test(h.command))).hooks[0];
    const edited = gate.command.replace(/(?:Reinstall|Restore) it with [^.']*\./, 'Restore it from git.');
    expect(edited).not.toBe(gate.command);
    gate.command = edited;
    gate.statusMessage = 'Checking the gate...';
    write(dir, '.claude/settings.json', JSON.stringify(settings, null, 2));
    git(dir, 'commit', '-qam', 'hand edit');
    const backupsBefore = fs.readdirSync(path.join(dir, '.claude')).filter((f) => /\.backup\./.test(f));
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    const after = JSON.parse(read(dir, '.claude/settings.json'));
    expect(runs(after, 'PreToolUse', 'quality-gate.cjs')).toHaveLength(1);
    expect(runs(after, 'PreToolUse', 'quality-gate.cjs')[0].statusMessage).toBe('Checking the gate...');
    expect(result.record.actions.some((a) => a.action === 'hand-edited registration replaced')).toBe(true);
    // A git-tracked settings.json gets no backup (C3d): only the one the old init took is there.
    expect(fs.readdirSync(path.join(dir, '.claude')).filter((f) => /\.backup\./.test(f))).toEqual(backupsBefore);
    // A registration removed afterwards is "not installed".
    after.hooks.PostToolUse = [];
    write(dir, '.claude/settings.json', JSON.stringify(after, null, 2));
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => m.path).join('\n')).toMatch(/PostToolUse review-budget\.cjs/);
  }, 240000);

  test('Codex registrations that already run the hooks are left byte for byte; no .codex/hooks copy is added for them', () => {
    const dir = product('codex-own', { tools: 'claude-code,codex' });
    const own = { hooks: {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: 'node .claude/hooks/quality-gate.cjs', timeout: 30 }] },
        { matcher: '^(collaboration.*|Agent)$', hooks: [{ type: 'command', command: 'node .claude/hooks/review-budget.cjs', timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: '^(collaboration.*|Agent)$', hooks: [{ type: 'command', command: 'node .claude/hooks/review-budget.cjs', timeout: 30 }] }],
    } };
    const text = JSON.stringify(own, null, 2) + '\n';
    write(dir, '.codex/hooks.json', text);
    fs.rmSync(path.join(dir, '.codex/hooks'), { recursive: true, force: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'own codex hooks');
    const result = upgrade(dir);
    expectCodexOnlyAppended(dir, text);
    expect(exists(dir, '.codex/hooks/quality-gate.cjs')).toBe(false);
    // The added context-handoff registrations run the .codex copy, so its body is added.
    expect(read(dir, '.codex/hooks/context-handoff.cjs')).toBe(read(ROOT, 'templates/hooks/context-handoff.cjs'));
    expect(result.exitCode).toBe(0);
  }, 240000);

  test('an edited hook body is a conflict: the body and its registration stay as they are', () => {
    const dir = product('hook-edited');
    write(dir, '.claude/hooks/review-budget.cjs', `${read(dir, '.claude/hooks/review-budget.cjs')}\n// local patch\n`);
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    const review = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /review-budget/.test(h.command))).hooks[0];
    review.command = 'node .claude/hooks/review-budget.cjs';
    write(dir, '.claude/settings.json', JSON.stringify(settings, null, 2));
    git(dir, 'commit', '-qam', 'patch');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(1);
    expect(read(dir, '.claude/hooks/review-budget.cjs')).toContain('// local patch');
    expect(exists(dir, '.claude/hooks/review-budget.cjs.ai-dev-helm-new')).toBe(true);
    const after = JSON.parse(read(dir, '.claude/settings.json'));
    expect(runs(after, 'PreToolUse', 'review-budget.cjs').map((h) => h.command)).toEqual(['node .claude/hooks/review-budget.cjs']);
  }, 240000);
});

// 3.7.3 (#241, C1 / C2): the Codex registrations a product wrote stay; upgrade names what to do about them.
describe('upgrade: a product\'s own Codex gate registration and a new .codex gate copy (3.7.3 C1, C2)', () => {
  const { LEGACY_CLAUDE_COMMANDS, hookCommand, declaredCommand } = require('./runtime-hooks');
  const [ownGate] = LEGACY_CLAUDE_COMMANDS['quality-gate.cjs'];
  const [ownReview] = LEGACY_CLAUDE_COMMANDS['review-budget.cjs'];
  const ownWarning = /^\.codex\/hooks\.json PreToolUse\[0\]\.hooks\[0\] runs \.claude\/hooks\/quality-gate\.cjs through the 3\.3\.0 wrapper, which lets the command through when the gate cannot run/;
  const newCopyWarning = /^\.codex\/hooks\/quality-gate\.cjs is new here: Codex's gate registration stops every shell command where this file is missing/;

  test('a product\'s own 3.3.0-wrapper gate registration is warned of and left byte for byte; review-budget\'s is not warned of', () => {
    const dir = product('codex-own-wrapper', { tools: 'claude-code,codex' });
    const own = { hooks: {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: ownGate, timeout: 30 }] },
        { matcher: '^(collaboration.*|spawn_agent)$', hooks: [{ type: 'command', command: ownReview, timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: '^(collaboration.*|spawn_agent)$', hooks: [{ type: 'command', command: ownReview, timeout: 30 }] }],
    } };
    const text = JSON.stringify(own, null, 2) + '\n';
    write(dir, '.codex/hooks.json', text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'own codex hooks');
    const plan = upgrade(dir, { mode: 'plan' });
    const warned = plan.record.warnings.filter((w) => /\.codex\/hooks\.json PreToolUse\[/.test(w));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(ownWarning);
    expect(warned[0]).toMatch(/upgrade does not change a registration the product wrote/);
    expect(warned[0]).toMatch(/keep its position/);
    const record = path.join(workspace, 'codex-own-wrapper.record.md');
    const result = upgrade(dir, { recordPath: record });
    expect(result.exitCode).toBe(0);
    expect(result.record.warnings.some((w) => ownWarning.test(w))).toBe(true);
    // Left as it is: only context-handoff is appended (every trust key keeps its hash).
    expectCodexOnlyAppended(dir, text);
    // The record carries the whole replacement command, as it is written in hooks.json.
    const fix = declaredCommand('codex', 'quality-gate.cjs', '.claude/hooks/quality-gate.cjs');
    expect(fix).not.toBe(hookCommand('codex', 'quality-gate.cjs'));
    expect(fs.readFileSync(record, 'utf8')).toContain(JSON.stringify(fix));
    expect(result.lines.join('\n')).not.toContain(JSON.stringify(fix));
  }, 240000);

  test('adding .codex/hooks/quality-gate.cjs for the first time is warned of; the gate registration goes to the end of PreToolUse', () => {
    const dir = product('codex-new-gate-copy', { tools: 'claude-code,codex' });
    const before = { hooks: {
      PreToolUse: [{ matcher: '^(collaboration.*|spawn_agent)$', hooks: [{ type: 'command', command: ownReview, timeout: 30 }] }],
      PostToolUse: [{ matcher: '^(collaboration.*|spawn_agent)$', hooks: [{ type: 'command', command: ownReview, timeout: 30 }] }],
    } };
    write(dir, '.codex/hooks.json', JSON.stringify(before, null, 2) + '\n');
    fs.rmSync(path.join(dir, '.codex/hooks'), { recursive: true, force: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'codex gate removed');
    const plan = upgrade(dir, { mode: 'plan' });
    expect(plan.record.warnings.filter((w) => newCopyWarning.test(w))).toHaveLength(1);
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    expect(read(dir, '.codex/hooks/quality-gate.cjs')).toBe(read(ROOT, 'templates/hooks/quality-gate.cjs'));
    const pre = JSON.parse(read(dir, '.codex/hooks.json')).hooks.PreToolUse;
    expect(pre[0]).toEqual(before.hooks.PreToolUse[0]);
    expect(pre).toHaveLength(2);
    expect(pre[1].hooks[0].command).toBe(hookCommand('codex', 'quality-gate.cjs'));
    // The copy is there now: a re-run does not warn again, nor does a product that had it all along.
    expect(upgrade(dir, { mode: 'plan' }).record.warnings.some((w) => newCopyWarning.test(w))).toBe(false);
    const fresh = product('codex-gate-copy-kept', { tools: 'claude-code,codex' });
    const freshPlan = upgrade(fresh, { mode: 'plan' });
    expect(freshPlan.record.warnings.some((w) => newCopyWarning.test(w) || /PreToolUse\[\d+\]\.hooks/.test(w))).toBe(false);
  }, 240000);
});

describe('upgrade: the managed blocks of the root rule files (C3d)', () => {
  const marker = (name, edge) => `<!-- ai-dev-helm:${name}:${edge} -->`;

  test('wraps an unmarked file once, updates the blocks and leaves the product sections', () => {
    const dir = product('blocks-wrap');
    expect(read(dir, 'CLAUDE.md')).toContain(OLD_HARNESS_LINE);
    write(dir, 'CLAUDE.md', read(dir, 'CLAUDE.md').replace('## Project Overview\n', '## Project Overview\n\nPRODUCT OVERVIEW TEXT\n'));
    git(dir, 'commit', '-qam', 'product text');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    const text = read(dir, 'CLAUDE.md');
    for (const name of ['harness', 'skills', 'refs']) {
      expect(text).toContain(marker(name, 'start'));
      expect(text).toContain(marker(name, 'end'));
    }
    expect(text).not.toContain(OLD_HARNESS_LINE);
    expect(text).toContain('PRODUCT OVERVIEW TEXT');
    expect(text.indexOf('PRODUCT OVERVIEW TEXT')).toBeGreaterThan(text.indexOf(marker('harness', 'end')));
    expect(text).toContain('<!-- ai-dev-helm:runtime:start -->');
    expect(result.record.actions.filter((a) => a.path === 'CLAUDE.md').map((a) => a.action)).toContain('block harness wrapped and updated');
    // Wrapped once: the next run finds the markers and changes nothing.
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    expect(runUpgrade({ dir, baseDir: oldPackage }).record.actions.filter((a) => a.path === 'CLAUDE.md' && a.action !== 'up to date')).toEqual([]);
  }, 240000);

  test('keeps a product edit inside a block and takes the release change around it', () => {
    const dir = product('blocks-merge');
    write(dir, 'AGENTS.md', read(dir, 'AGENTS.md').replace('## Autonomy Principles\n', '## Autonomy Principles\n\nPRODUCT RULE INSIDE THE HARNESS SECTION\n'));
    git(dir, 'commit', '-qam', 'edit');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    const text = read(dir, 'AGENTS.md');
    expect(text).toContain('PRODUCT RULE INSIDE THE HARNESS SECTION');
    expect(text).not.toContain(OLD_HARNESS_LINE);
    expect(result.record.verdict.missing).toEqual([]);
  }, 240000);

  test('a product section between the harness sections, or a translated heading, leaves the block pending (C3n)', () => {
    const dir = product('blocks-pending');
    write(dir, 'CLAUDE.md', read(dir, 'CLAUDE.md').replace('## Critical Rules\n', '## Our Product Rules\n\nx\n\n## Critical Rules\n'));
    write(dir, 'AGENTS.md', read(dir, 'AGENTS.md').replace('## Language Setting\n', '## 言語の設定\n'));
    git(dir, 'commit', '-qam', 'interleave');
    const harnessPart = (text) => text.slice(text.indexOf('## Language Setting'), text.indexOf('## Project Overview'));
    const before = harnessPart(read(dir, 'CLAUDE.md'));
    const result = upgrade(dir);
    expect(result.exitCode).toBe(1);
    // The harness part stays as it was (not wrapped, not updated); the skills / refs blocks are still taken care of.
    expect(harnessPart(read(dir, 'CLAUDE.md'))).toBe(before);
    expect(read(dir, 'CLAUDE.md')).not.toContain(marker('harness', 'start'));
    expect(read(dir, 'CLAUDE.md')).toContain(marker('refs', 'start'));
    const pending = manifestOf(dir).pending.map((p) => `${p.path}#${p.block}`);
    expect(pending).toEqual(expect.arrayContaining(['CLAUDE.md#harness', 'AGENTS.md#harness']));
    // Wrapped by hand once (the new block in place of the old sections), then resolved: complete.
    const fresh = require('./managed-blocks');
    const rendered = require('./render').renderPackage(path.resolve(__dirname, '..'), { projectName: 'Demo', tools: ['claude-code', 'codex'], stacks: ['nextjs-react'], skillScope: 'all' });
    for (const rel of ['CLAUDE.md', 'AGENTS.md']) {
      const newBlock = fresh.findBlocks(rendered.get(rel).toString('utf8').replace(/\r\n/g, '\n')).blocks.harness.body;
      const text = read(dir, rel);
      const s = text.indexOf(rel === 'CLAUDE.md' ? '## Language Setting' : '## 言語の設定');
      const e = text.indexOf('## Project Overview');
      write(dir, rel, `${text.slice(0, s)}${marker('harness', 'start')}\n${newBlock}${marker('harness', 'end')}\n\n${text.slice(e)}`);
      runUpgrade({ dir, resolve: `${rel}#harness` });
    }
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);
});

describe('upgrade: cycle 1 findings (C3n paths, safety)', () => {
  const stripNew = (dir, rel) => fs.rmSync(path.join(dir, `${rel}.ai-dev-helm-new`), { force: true });

  test('a pending conflict is not dropped by a re-run: compared with its base version until it merges', () => {
    const dir = product('rerun-file');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'commit', '-qam', 'edit');
    expect(upgrade(dir).exitCode).toBe(1);
    stripNew(dir, RUNTIME); // the .new deleted without merging it
    const again = upgrade(dir);
    expect(again.exitCode).toBe(1);
    expect(manifestOf(dir).pending).toEqual([{ path: RUNTIME, baseVersion: OLD_VERSION, conflict: expect.stringMatching(/^[a-f0-9]{64}$/), conflictRaw: [expect.stringMatching(/^[a-f0-9]{64}$/)] }]);
    expect(manifestOf(dir).complete).toBe(false);
    expect(exists(dir, `${RUNTIME}.ai-dev-helm-new`)).toBe(true);
  }, 240000);

  test('a pending block conflict stays pending on a re-run', () => {
    const dir = product('rerun-block');
    // A product whose harness section is already wrapped (the block itself conflicts, not its wrapping).
    let text = read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE');
    text = text.replace('## Language Setting', '<!-- ai-dev-helm:harness:start -->\n## Language Setting')
      .replace('\n## Project Overview', '<!-- ai-dev-helm:harness:end -->\n\n## Project Overview');
    write(dir, 'CLAUDE.md', text);
    git(dir, 'commit', '-qam', 'edit');
    expect(upgrade(dir).exitCode).toBe(1);
    expect(manifestOf(dir).pending).toEqual([{ path: 'CLAUDE.md', block: 'harness', baseVersion: OLD_VERSION, conflict: expect.stringMatching(/^[a-f0-9]{64}$/), conflictRaw: [expect.stringMatching(/^[a-f0-9]{64}$/)] }]);
    const again = upgrade(dir);
    expect(again.exitCode).toBe(1);
    expect(manifestOf(dir).pending).toEqual([{ path: 'CLAUDE.md', block: 'harness', baseVersion: OLD_VERSION, conflict: expect.stringMatching(/^[a-f0-9]{64}$/), conflictRaw: [expect.stringMatching(/^[a-f0-9]{64}$/)] }]);
  }, 240000);

  test('a pending hook body keeps its registration on a re-run', () => {
    const dir = product('rerun-hook');
    write(dir, '.claude/hooks/review-budget.cjs', `${read(dir, '.claude/hooks/review-budget.cjs')}\n// local patch\n`);
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /review-budget/.test(h.command))).hooks[0].command = 'node .claude/hooks/review-budget.cjs';
    write(dir, '.claude/settings.json', JSON.stringify(settings, null, 2));
    git(dir, 'commit', '-qam', 'patch');
    upgrade(dir);
    upgrade(dir);
    const after = JSON.parse(read(dir, '.claude/settings.json'));
    const commands = after.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command).filter((c) => /review-budget/.test(c));
    expect(commands).toEqual(['node .claude/hooks/review-budget.cjs']);
  }, 240000);

  test('--verify on a product still on the old release judges against that release, not the new one', () => {
    const dir = product('verify-old');
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => m.path)).toContain(RUNTIME);
    expect(verify.record.verdict.merged).not.toContain(RUNTIME);
  }, 240000);

  test('a file new in the release is "not installed" when its content is replaced afterwards', () => {
    const dir = product('verify-new-file');
    expect(upgrade(dir).exitCode).toBe(0);
    write(dir, 'documents/development/runtime-upgrade.md', 'GARBAGE\n');
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.record.verdict.missing.map((m) => m.path)).toContain('documents/development/runtime-upgrade.md');
  }, 240000);

  test('a fresh init of this release verifies complete (settings compared as structures)', () => {
    const dir = path.join(workspace, 'fresh-init');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cli.js'), 'init', '--project-name', 'Demo', '--tools', 'claude-code,codex', '--stacks', 'nextjs-react', '--skills', 'all'], { cwd: dir, encoding: 'utf8', input: '' });
    expect(r.status, r.stderr).toBe(0);
    const verify = runUpgrade({ dir, mode: 'verify' });
    expect(verify.record.verdict.missing).toEqual([]);
    expect(verify.exitCode).toBe(0);
    expect(manifestOf(dir).projectName).toBe('Demo');
  }, 240000);

  test('overrides of tools and stacks are recorded, so later runs keep rendering them', () => {
    const dir = product('override', { tools: 'claude-code' });
    expect(upgrade(dir, { overrides: { tools: ['claude-code', 'codex'] } }).exitCode).toBe(0);
    expect(manifestOf(dir).tools).toEqual(['claude-code', 'codex']);
    fs.rmSync(path.join(dir, '.codex', 'hooks', 'quality-gate.cjs'), { force: true });
    fs.rmSync(path.join(dir, '.codex', 'hooks.json'), { force: true });
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(1);
  }, 240000);

  test('refuses declarations over root rule files and special files, paths outside the product, a downgrade and --plan with --resolve', () => {
    const dir = product('refusals');
    const set = (extra) => write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), ...extra }, null, 2));
    const original = manifestOf(dir);
    set({ exclude: [{ path: 'CLAUDE.md', reason: 'ours' }] });
    expect(() => upgrade(dir, { mode: 'plan' })).toThrow(/covers CLAUDE\.md, which cannot be declared/);
    set({ exclude: [{ path: '.gitignore', reason: 'ours' }] });
    expect(() => upgrade(dir, { mode: 'plan' })).toThrow(/covers \.gitignore/);
    set({ exclude: undefined, skillTargets: { superpowers: ['../escaped'] } });
    expect(() => upgrade(dir, { mode: 'plan' })).toThrow(/skillTargets\.superpowers: "\.\.\/escaped" is not a relative path inside the product/);
    expect(fs.existsSync(path.join(workspace, 'escaped'))).toBe(false);
    set({ skillTargets: undefined, pending: [{ path: '../outside.md', baseVersion: OLD_VERSION }] });
    expect(() => upgrade(dir, { mode: 'plan' })).toThrow(/pending: "\.\.\/outside\.md"/);
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...original, version: '99.0.0' }, null, 2));
    expect(() => runUpgrade({ dir, mode: 'plan' })).toThrow(/older than the 99\.0\.0 recorded/);
    expect(() => runUpgrade({ dir, mode: 'plan', resolve: RUNTIME })).toThrow(/--resolve cannot be combined/);
  }, 240000);

  test('a product registration chained with its own command, a Codex direct registration and a matcher that reaches nothing', () => {
    const dir = product('registrations-2');
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    settings.hooks.PreToolUse.push({ matcher: '^Edit$', hooks: [{ type: 'command', command: 'node .claude/hooks/review-budget.cjs && node scripts/product-edit-check.cjs' }] });
    write(dir, '.claude/settings.json', JSON.stringify(settings, null, 2));
    const codex = { hooks: {
      PreToolUse: [
        { matcher: '^(Bash|shell)$', hooks: [{ type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 30 }] },
        { matcher: '^(spawn_agent)$', hooks: [{ type: 'command', command: 'node .codex/hooks/review-budget.cjs', timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: '^(spawn_agent)$', hooks: [{ type: 'command', command: 'node .codex/hooks/review-budget.cjs', timeout: 30 }] }],
    } };
    const codexText = JSON.stringify(codex, null, 2) + '\n';
    write(dir, '.codex/hooks.json', codexText);
    git(dir, 'commit', '-qam', 'own registrations');
    expect(upgrade(dir).exitCode).toBe(0);
    const after = JSON.parse(read(dir, '.claude/settings.json'));
    expect(after.hooks.PreToolUse.some((e) => e.matcher === '^Edit$' && e.hooks[0].command.includes('product-edit-check'))).toBe(true);
    expectCodexOnlyAppended(dir, codexText);
    // A gate registration that reaches no shell tool is "not installed" (Codex is reported, not rewritten).
    codex.hooks.PreToolUse[0].matcher = 'NoSuchTool';
    write(dir, '.codex/hooks.json', JSON.stringify(codex, null, 2) + '\n');
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => `${m.path} ${m.why}`).join('\n')).toMatch(/\.codex\/hooks\.json PreToolUse quality-gate\.cjs its matcher does not reach Bash/);
  }, 240000);

  test('a binary write keeps its bytes; a text write follows the product line endings', () => {
    const { applyWrite } = require('./upgrade');
    const dir = path.join(workspace, 'writes');
    fs.mkdirSync(dir, { recursive: true });
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    applyWrite({ file: path.join(dir, 'logo.png'), rel: 'logo.png', buf: bin, like: Buffer.from([0x00, 0x09]) });
    expect(fs.readFileSync(path.join(dir, 'logo.png')).equals(bin)).toBe(true);
    applyWrite({ file: path.join(dir, 'a.md'), rel: 'a.md', buf: Buffer.from('x\ny\n'), like: Buffer.from('old\r\n') });
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('x\r\ny\r\n');
  });
});

describe('upgrade: cycle 2 findings', () => {
  test('a conflict resolved by hand (keeping both changes) completes after --resolve and a re-run, and is listed for review', () => {
    const dir = product('resolved-by-hand');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'commit', '-qam', 'edit');
    expect(upgrade(dir).exitCode).toBe(1);
    // Resolved by hand: the release's line plus the product's addition.
    const merged = read(dir, `${RUNTIME}.ai-dev-helm-new`).replace(/\n*$/, '\n\nPRODUCT ADDITION after resolving\n');
    write(dir, RUNTIME, merged);
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    expect(runUpgrade({ dir, resolve: RUNTIME }).exitCode).toBe(0);
    const again = upgrade(dir);
    expect(again.exitCode).toBe(0);
    expect(manifestOf(dir).complete).toBe(true);
    expect(again.record.verdict.resolved).toContain(RUNTIME);
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);

  test('a product addition to a file new in the release stays merged; replaced content does not', () => {
    const dir = product('new-file-addition');
    expect(upgrade(dir).exitCode).toBe(0);
    const rel = 'documents/development/runtime-upgrade.md';
    const original = read(dir, rel);
    write(dir, rel, `${original}\nPRODUCT NOTE\n`);
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.record.verdict.merged).toContain(rel);
    expect(verify.exitCode).toBe(0);
    // One of the release's lines replaced: not installed (cycle 3 M: the test named this but did not check it).
    const lines = original.split('\n');
    const at = lines.findIndex((l) => l.trim().length > 10);
    lines[at] = 'REPLACED BY THE PRODUCT';
    write(dir, rel, lines.join('\n'));
    const replaced = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(replaced.exitCode).toBe(1);
    expect(replaced.record.verdict.missing.map((m) => m.path)).toContain(rel);
  }, 240000);

  test('--resolve refuses content unchanged since the conflict or emptied; going back afterwards is "not installed" (cycle 4)', () => {
    const dir = product('resolved-without-merging');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    const conflicting = lines.join('\n');
    write(dir, RUNTIME, conflicting);
    git(dir, 'commit', '-qam', 'edit');
    expect(upgrade(dir).exitCode).toBe(1);
    const release = read(dir, `${RUNTIME}.ai-dev-helm-new`);
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`)); // dropped, not merged
    expect(() => runUpgrade({ dir, resolve: RUNTIME })).toThrow(/unchanged since the conflict/);
    write(dir, RUNTIME, '\n');
    expect(() => runUpgrade({ dir, resolve: RUNTIME })).toThrow(/is empty/);
    // Merged by hand (the release's version plus the product line), resolved, re-run: complete.
    write(dir, RUNTIME, `${release.replace(/\n*$/, '\n')}\nPRODUCT REWRITE kept below\n`);
    expect(runUpgrade({ dir, resolve: RUNTIME }).exitCode).toBe(0);
    expect(upgrade(dir).exitCode).toBe(0);
    // Going back to the conflicting content afterwards is caught by --verify.
    write(dir, RUNTIME, conflicting);
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => `${m.path} ${m.why}`).join('\n')).toMatch(/harness-runtime\.md resolved by hand, but it is empty or the same as when it conflicted/);
  }, 240000);

  test('a Codex review-budget registration under a matcher that never reaches spawn_agent is not installed', () => {
    const dir = product('codex-review-matcher');
    expect(upgrade(dir).exitCode).toBe(0);
    const hooks = JSON.parse(read(dir, '.codex/hooks.json'));
    for (const event of ['PreToolUse']) {
      for (const entry of hooks.hooks[event]) if (entry.hooks.some((h) => /review-budget/.test(h.command))) entry.matcher = '^(Task)$';
    }
    write(dir, '.codex/hooks.json', JSON.stringify(hooks, null, 2));
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => `${m.path} ${m.why}`).join('\n')).toMatch(/\.codex\/hooks\.json PreToolUse review-budget\.cjs its matcher does not reach spawn_agent or collaboration/);
  }, 240000);

  test('an exclude over the Codex agents (own merge) is refused', () => {
    const dir = product('exclude-agents');
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), exclude: [{ path: '.codex/agents/**', reason: 'ours' }] }, null, 2));
    expect(() => upgrade(dir, { mode: 'plan' })).toThrow(/covers .*\.codex\/agents\/.*which cannot be declared/);
  }, 240000);
});

describe('upgrade: the product\'s own gate and review-budget (C3h gate.script / reviewBudgetScript)', () => {
  const DECLARED = { gate: { script: 'scripts/gate.cjs' }, reviewBudgetScript: 'scripts/review-budget.cjs' };

  test('registers the declared files, copies no distributed body, leaves Codex as it is, and verifies complete', () => {
    const { declaredCommand, declaredHooks } = require('./runtime-hooks');
    const declared = declaredHooks(DECLARED).declared;
    const runs = (json, event, name) => (json.hooks[event] || []).flatMap((e) => e.hooks).filter((h) => (calledHook(h.command, declared) || {}).file === name);
    const dir = product('declared-gate', { manifest: DECLARED });
    // An adopter's layout: its gate and review-budget under scripts/, no distributed copies, its own Codex registrations.
    for (const rel of ['.claude/hooks/quality-gate.cjs', '.claude/hooks/review-budget.cjs', '.codex/hooks']) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    write(dir, 'scripts/gate.cjs', read(ROOT, 'templates/hooks/quality-gate.cjs'));
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    const codex = JSON.stringify({ hooks: {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [{ type: 'command', command: 'node scripts/gate.cjs', timeout: 30 }] },
        { matcher: '^(spawn_agent|followup_task)$', hooks: [{ type: 'command', command: 'node scripts/review-budget.cjs', timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: '^(spawn_agent|followup_task)$', hooks: [{ type: 'command', command: 'node scripts/review-budget.cjs', timeout: 30 }] }],
    } }, null, 2) + '\n';
    write(dir, '.codex/hooks.json', codex);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'own gate');
    const plan = upgrade(dir, { mode: 'plan' });
    expect(plan.record.actions.filter((a) => /possible duplicate/.test(a.action))).toEqual([]);
    const result = upgrade(dir);
    expect(result.record.verdict.missing).toEqual([]);
    expect(result.exitCode).toBe(0);
    for (const rel of ['.claude/hooks/quality-gate.cjs', '.claude/hooks/review-budget.cjs', '.codex/hooks/quality-gate.cjs', '.codex/hooks/review-budget.cjs']) expect(exists(dir, rel), rel).toBe(false);
    expect(actionsOf(result, '.claude/hooks/quality-gate.cjs')).toEqual(['declared-out (gate.script: scripts/gate.cjs)']);
    expect(result.record.verdict.declared).toEqual(expect.arrayContaining(['.claude/hooks/quality-gate.cjs', '.claude/hooks/review-budget.cjs']));
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    expect(runs(settings, 'PreToolUse', 'quality-gate.cjs').map((h) => h.command)).toEqual([declaredCommand('claude', 'quality-gate.cjs', 'scripts/gate.cjs')]);
    expect(runs(settings, 'PostToolUse', 'review-budget.cjs').map((h) => h.command)).toEqual([declaredCommand('claude', 'review-budget.cjs', 'scripts/review-budget.cjs')]);
    expectCodexOnlyAppended(dir, codex);
    expect(manifestOf(dir).gate).toEqual(DECLARED.gate);
    // 3.7.1 (D6): the distributed documents and skills call the declared review-budget, not the copy it replaces.
    for (const rel of [RUNTIME, 'skills/project/quality-check/references/step4-review.md', 'skills/superpowers/brainstorming/SKILL.md']) {
      expect(read(dir, rel), rel).toContain('node scripts/review-budget.cjs');
      expect(read(dir, rel), rel).not.toMatch(/node \.(claude|codex)\/hooks\/review-budget\.cjs/);
    }
    // The declared file gone: --verify names it.
    fs.rmSync(path.join(dir, 'scripts/gate.cjs'));
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => `${m.path} ${m.why}`).join('\n')).toMatch(/scripts\/gate\.cjs declared \(gate\.script\) but missing/);
  }, 240000);

  test('an unsafe declaration is refused before anything is written', () => {
    const dir = product('declared-bad');
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), gate: { script: '../gate.cjs' } }, null, 2));
    expect(() => upgrade(dir, { mode: 'plan' })).toThrow(/gate\.script "\.\.\/gate\.cjs" is not a relative POSIX path/);
  }, 240000);
});

describe('upgrade: workflow / apps / settings (C3j, C3g)', () => {
  const declared = { workflow: { protectedBranches: ['main', 'release'] }, apps: { frontend: 'apps/web' }, settings: { enabledPlugins: { 'superpowers@claude-plugins-official': false } } };

  test('renders with the declared keys: denials, Codex rules, Cursor globs and plugins, then verifies complete', () => {
    const dir = product('workflow', { tools: 'claude-code,codex,cursor', manifest: declared });
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    expect(settings.permissions.deny).toContain('Bash(git push --force origin release)');
    expect(settings.enabledPlugins['superpowers@claude-plugins-official']).toBe(false);
    expect(read(dir, '.codex/rules/ai-dev-helm-protected.rules')).toMatch(/"release", "HEAD:release"/);
    const front = fs.readdirSync(path.join(dir, '.cursor', 'rules')).find((f) => f.startsWith('frontend-'));
    expect(read(dir, `.cursor/rules/${front}`)).toContain('"apps/web/**/*.tsx"');
    expect(read(dir, `.cursor/rules/${front}`)).not.toContain('"frontend/**');
    expect(manifestOf(dir).workflow).toEqual(declared.workflow);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'upgrade');
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);

  test('settings.mergeDeny: false keeps the product deny list; a malformed key is refused before writing', () => {
    const dir = product('workflow-own-deny', { manifest: { ...declared, settings: { mergeDeny: false } } });
    expect(upgrade(dir).exitCode).toBe(0);
    expect(JSON.parse(read(dir, '.claude/settings.json')).permissions.deny).not.toContain('Bash(git push --force origin release)');
    const bad = product('workflow-bad', { manifest: { workflow: { protectedBranches: 'release' } } });
    expect(() => upgrade(bad, { mode: 'plan' })).toThrow(/protectedBranches must be an array/);
    expect(git(bad, 'status', '--short')).toBe('');
  }, 240000);
});

describe('upgrade: the product\'s local blocks in distributed documents (C3k)', () => {
  const LOCAL = '<!-- ai-dev-helm:local:start -->\n## Product notes\n\nOur own rule.\n<!-- ai-dev-helm:local:end -->';

  test('a local block sits out of the merge: the release change is taken, the block stays where it was, verify passes', () => {
    const dir = product('local-block');
    const lines = read(dir, RUNTIME).replace(/\r\n/g, '\n').split('\n');
    const at = lines.findIndex((l) => l.startsWith('## ')) + 2;
    const anchor = lines[at];
    lines.splice(at + 1, 0, '', ...LOCAL.split('\n'));
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'local block');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    expect(actionsOf(result, RUNTIME)).toEqual(['replaced (local blocks kept)']);
    const after = read(dir, RUNTIME).replace(/\r\n/g, '\n');
    expect(after).not.toContain(OLD_LINE);
    expect(after).toContain(`${anchor}\n\n${LOCAL}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'upgrade');
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
    // A product edit outside the block is still a product change (not hidden by the block).
    write(dir, RUNTIME, after.replace(anchor, `${anchor} (edited)`));
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
    // Going back to the old release's line outside the block is caught.
    write(dir, RUNTIME, after.replace(after.split('\n')[2], OLD_LINE));
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(1);
  }, 240000);
});

describe('upgrade: references to the skills follow the layout (C3f, 4g)', () => {
  test('only a path that starts with skills/<tree>/ moves, in documents and root rule files, and moving twice changes nothing', () => {
    const { relayoutText } = require('./upgrade');
    const flat = { project: ['.claude/skills'], superpowers: ['.claude/skills/superpowers'] };
    expect(relayoutText('`skills/project/qc/SKILL.md`, (skills/superpowers/b), .codex/skills/project/x, a-skills/project/y, skills/projectx/', flat, 'documents/development/a.md'))
      .toBe('`.claude/skills/qc/SKILL.md`, (.claude/skills/superpowers/b), .codex/skills/project/x, a-skills/project/y, skills/projectx/');
    expect(relayoutText('skills/project/x', flat, '.claude/hooks/quality-gate.cjs')).toBe('skills/project/x');
    expect(relayoutText(' skills/project/x', flat, '.cursorrules')).toBe(' .claude/skills/x');
    const nested = { project: ['.claude/skills/project'] };
    const once = relayoutText('see skills/project/a', nested, 'CLAUDE.md');
    expect(once).toBe('see .claude/skills/project/a');
    expect(relayoutText(once, nested, 'CLAUDE.md')).toBe(once);
    expect(relayoutText('skills/project/a', undefined, 'a.md')).toBe('skills/project/a');
  });

  test('3.7.1 (D6): in root rule files the tools\' own skill paths move too, to the target under the same tool when there is one', () => {
    const { relayoutText, layout } = require('./upgrade');
    const targets = { project: ['.claude/skills', '.codex/skills'], superpowers: ['.claude/skills/superpowers'] };
    const agents = '| a | `.codex/skills/project/qc/SKILL.md` |\n| b | `.codex/skills/superpowers/tdd/SKILL.md` |\nLocated under `.codex/skills/`.\n';
    const moved = relayoutText(agents, targets, 'AGENTS.md');
    // 3.7.2 (U1): the sentence naming the place reads as the targets too.
    expect(moved).toBe('| a | `.codex/skills/qc/SKILL.md` |\n| b | `.claude/skills/superpowers/tdd/SKILL.md` |\nLocated under `.codex/skills/` and `.claude/skills/superpowers/`.\n');
    expect(relayoutText(moved, targets, 'AGENTS.md')).toBe(moved);
    expect(relayoutText('`.cursor/skills/project/qc/SKILL.md`', targets, '.cursorrules')).toBe('`.claude/skills/qc/SKILL.md`');
    // Only the root rule files: a document keeps them (its tool paths are not the harness layout's).
    expect(relayoutText('.codex/skills/project/qc/', targets, 'documents/development/a.md')).toBe('.codex/skills/project/qc/');
    // A declared review-budget: the distributed calls read as the declared file, in documents and root rule files.
    const call = 'Run `node .claude/hooks/review-budget.cjs begin` (`node .codex/hooks/review-budget.cjs` for Codex).';
    expect(relayoutText(call, {}, 'skills/project/qc/SKILL.md', { reviewBudgetScript: 'scripts/rb.cjs' })).toBe('Run `node scripts/rb.cjs begin` (`node scripts/rb.cjs` for Codex).');
    expect(relayoutText(call, {}, '.claude/hooks/x.cjs', { reviewBudgetScript: 'scripts/rb.cjs' })).toBe(call);
    const files = new Map([['documents/development/harness-runtime.md', Buffer.from(call)]]);
    expect(layout(files, undefined, { reviewBudgetScript: 'scripts/rb.cjs' }).get('documents/development/harness-runtime.md').buf.toString()).toContain('node scripts/rb.cjs begin');
  });

  // 3.7.2 (U1): the sentences saying where the skills are and that they are links (repaired by link-skills) read as
  // the layout too - in the templates as shipped, so a template that rewords them fails here instead of going unread.
  test('3.7.2 (U1): the root rule files\' sentences on where the skills are follow skillTargets; a declared tree is a copy, not a link', () => {
    const { relayoutText } = require('./upgrade');
    const { findBlocks } = require('./managed-blocks');
    const template = (name) => read(ROOT, `templates/${name}`).replace(/\r\n/g, '\n');
    const files = { 'AGENTS.md': template('AGENTS.md.template'), '.cursorrules': template('cursorrules.template'), 'CLAUDE.md': template('CLAUDE.md.template') };
    const link = 'If the link is missing (a new worktree, for example), run `link-skills` (the `using-git-worktrees` skill) or read `skills/<same relative path>/SKILL.md` directly.';
    expect(files['AGENTS.md']).toContain('Located under `.codex/skills/`.');
    expect(files['.cursorrules']).toContain(`Skills are installed under \`.cursor/skills/\` (symlink to \`skills/\`). ${link}`);
    for (const rel of ['AGENTS.md', 'CLAUDE.md']) expect(files[rel]).toContain(`read the local SKILL.md directly. ${link}`);
    const skillsBlock = (text) => findBlocks(text).blocks.skills.body;

    // Every tree declared under .claude/skills (an adopter with no Codex / Cursor copies).
    const flat = { project: ['.claude/skills'], superpowers: ['.claude/skills/superpowers'] };
    const read1 = Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, relayoutText(text, flat, rel)]));
    expect(skillsBlock(read1['AGENTS.md'])).toContain('Located under `.claude/skills/`. Confirm discovery');
    expect(skillsBlock(read1['.cursorrules'])).toContain('Skills are installed under `.claude/skills/`. They are copies declared in `skillTargets`');
    for (const rel of Object.keys(files)) {
      expect(read1[rel], rel).not.toContain(link);
      expect(read1[rel], rel).not.toMatch(/\.(codex|cursor)\/skills\//);
      expect(relayoutText(read1[rel], flat, rel), `${rel} twice`).toBe(read1[rel]);
    }
    expect(read1['CLAUDE.md']).toContain('read the local SKILL.md directly. They are copies declared in `skillTargets`');
    // Only the sentences change: line for line the same file otherwise.
    expect(read1['AGENTS.md'].split('\n').length).toBe(files['AGENTS.md'].split('\n').length);

    // One tree declared: the other stays a link at the tool's place, and its link sentence stays.
    const one = { project: ['.claude/skills/project'] };
    expect(relayoutText(files['AGENTS.md'], one, 'AGENTS.md')).toContain('Located under `.claude/skills/project/` and `.codex/skills/superpowers/`.');
    const cursor = relayoutText(files['.cursorrules'], one, '.cursorrules');
    expect(cursor).toContain(`Skills are installed under \`.claude/skills/project/\` and \`.cursor/skills/superpowers/\` (a tree not declared in \`skillTargets\` is a symlink to its tree under \`skills/\`). ${link}`);
    expect(relayoutText(cursor, one, '.cursorrules')).toBe(cursor);
    expect(relayoutText(files['CLAUDE.md'], one, 'CLAUDE.md')).toContain(`read the local SKILL.md directly. ${link}`);
    // A target under the tool's own directory is the one named for that tool.
    expect(relayoutText(files['AGENTS.md'], { project: ['.claude/skills', '.codex/skills'], superpowers: ['.codex/skills/superpowers'] }, 'AGENTS.md')).toContain('Located under `.codex/skills/`.');

    // Nothing declared, a document, or the 3.7.0 reading: the sentences stay.
    for (const rel of Object.keys(files)) expect(relayoutText(files[rel], {}, rel)).toBe(files[rel]);
    expect(relayoutText('Located under `.codex/skills/`.', flat, 'documents/development/a.md')).toBe('Located under `.codex/skills/`.');
    expect(relayoutText(files['AGENTS.md'], flat, 'AGENTS.md', { legacy: true })).toContain('Located under `.codex/skills/`.');
  });
});

describe('upgrade: declaration globs (cycle 1)', () => {
  test('`**/` is zero or more whole directories; a trailing `**` and a trailing `/` take everything under', () => {
    const { globRe } = require('./upgrade');
    expect(globRe('documents/**/x.md').test('documents/x.md')).toBe(true);
    expect(globRe('documents/**/x.md').test('documents/a/b/x.md')).toBe(true);
    expect(globRe('documents/**/x.md').test('documents/development/max.md')).toBe(false);
    expect(globRe('**/README.md').test('srcREADME.md')).toBe(false);
    expect(globRe('skills/project/qc/**').test('skills/project/qc/references/a.md')).toBe(true);
    expect(globRe('lint/').test('lint/eslint/x.json')).toBe(true);
  });
});

describe('upgrade: a declared gate next to a Codex registration that still runs the distributed copy (cycle 1)', () => {
  test('the copy stays a hook body: kept up to date, and --verify / hook-selftest fail when it differs', () => {
    // Break: until cycle 1 the copy was declared-out, so an old copy the Codex registration runs passed all three.
    const dir = product('declared-codex-copy', { manifest: { gate: { script: 'scripts/gate.cjs' } } });
    write(dir, 'scripts/gate.cjs', read(ROOT, 'templates/hooks/quality-gate.cjs'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'own gate');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    expect(actionsOf(result, '.codex/hooks/quality-gate.cjs')).toEqual(['up to date']);
    expect(read(dir, '.codex/hooks.json')).toMatch(/\.codex.*hooks.*quality-gate\.cjs/);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
    write(dir, '.codex/hooks/quality-gate.cjs', `${read(dir, '.codex/hooks/quality-gate.cjs')}// stale\n`);
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.exitCode).toBe(1);
    expect(verify.record.verdict.missing.map((m) => m.path)).toContain('.codex/hooks/quality-gate.cjs');
    const { runHookSelftest } = require('./hook-selftest');
    const selftest = runHookSelftest({ dir });
    expect(selftest.exitCode).toBe(1);
    expect(selftest.lines.join('\n')).toMatch(/\.codex\/hooks\/quality-gate\.cjs differs/);
  }, 240000);
});

describe('upgrade: 3.7.1 registrations - the Monitor matcher (D1) and Cursor\'s gate (D4)', () => {
  test('a 3.7.0 install is brought up: the gate reaches Monitor, Cursor gets its gate, the product\'s Cursor hook stays', () => {
    const { isCursorGate } = require('./runtime-hooks');
    const dir = product('cursor-monitor', { tools: 'claude-code,codex,cursor' });
    // As 3.7.0 left it: the Claude gate under ^(Bash|PowerShell)$, and Cursor with the product's own adapter only.
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /quality-gate/.test(h.command)));
    entry.matcher = '^(Bash|PowerShell)$';
    write(dir, '.claude/settings.json', JSON.stringify(settings, null, 2));
    const own = { command: 'node .cursor/hooks/quality-gate.mjs', matcher: '(push|merge)', timeout: 30, failClosed: true };
    write(dir, '.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { beforeShellExecution: [own] } }, null, 2));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'as 3.7.0');
    const before = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    const missing = before.record.verdict.missing.map((m) => `${m.path}: ${m.why}`).join('\n');
    expect(missing).toMatch(/\.claude\/settings\.json PreToolUse quality-gate\.cjs: its matcher does not reach Bash and PowerShell and Monitor/);
    expect(missing).toMatch(/\.cursor\/hooks\.json beforeShellExecution quality-gate\.cjs: registered 0 time\(s\)/);
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    const after = JSON.parse(read(dir, '.claude/settings.json'));
    expect(after.hooks.PreToolUse.filter((e) => e.hooks.some((h) => /quality-gate/.test(h.command))).map((e) => e.matcher)).toEqual(['^(Bash|PowerShell|Monitor)$']);
    const cursor = JSON.parse(read(dir, '.cursor/hooks.json')).hooks.beforeShellExecution;
    expect(cursor[0]).toEqual(own);
    expect(cursor.filter((e) => isCursorGate(e.command))).toHaveLength(1);
    expect(result.record.actions.some((a) => a.path === '.cursor/hooks.json' && /possible duplicate/.test(a.action))).toBe(true);
    // The Codex registration is not touched (its trust stays).
    expect(read(dir, '.codex/hooks.json')).toBe(git(dir, 'show', 'HEAD:.codex/hooks.json'));
    expect(exists(dir, '.cursor/hooks/quality-gate.cjs')).toBe(false);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);

  test('a Cursor-only product gets the gate body under .cursor/hooks', () => {
    const dir = product('cursor-only', { tools: 'cursor' });
    fs.rmSync(path.join(dir, '.cursor', 'hooks'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, '.cursor', 'hooks.json'), { force: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'as 3.7.0');
    const result = upgrade(dir);
    expect(result.exitCode).toBe(0);
    expect(read(dir, '.cursor/hooks/quality-gate.cjs')).toBe(read(ROOT, 'templates/hooks/quality-gate.cjs'));
    expect(JSON.parse(read(dir, '.cursor/hooks.json')).hooks.beforeShellExecution).toHaveLength(1);
  }, 240000);
});

describe('upgrade: 3.7.0 rollout findings (3.7.1 D6)', () => {
  const marker = (name, edge) => `<!-- ai-dev-helm:${name}:${edge} -->`;

  test('several --resolve paths are checked first (one failing resolves none); a resolved file or block equal to the release is still listed', () => {
    const dir = product('d6-resolve');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    write(dir, 'AGENTS.md', read(dir, 'AGENTS.md').replace('## Language Setting\n', '## 言語の設定\n'));
    git(dir, 'commit', '-qam', 'conflicts');
    expect(upgrade(dir).exitCode).toBe(1);
    expect(manifestOf(dir).pending.map((p) => (p.block ? `${p.path}#${p.block}` : p.path))).toEqual(expect.arrayContaining([RUNTIME, 'AGENTS.md#harness']));
    // The file taken as the release has it (equal to the release after resolving).
    write(dir, RUNTIME, read(dir, `${RUNTIME}.ai-dev-helm-new`));
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    // AGENTS.md is not wrapped yet: neither path is resolved, the manifest is not written.
    const before = read(dir, '.ai-dev-helm.json');
    expect(() => runUpgrade({ dir, resolve: [RUNTIME, 'AGENTS.md#harness'] })).toThrow(/AGENTS\.md has no .* block yet.*nothing was resolved; 1 of 2 passed/);
    expect(read(dir, '.ai-dev-helm.json')).toBe(before);
    const rendered = require('./render').renderPackage(path.resolve(__dirname, '..'), { projectName: 'Demo', tools: ['claude-code', 'codex'], stacks: ['nextjs-react'], skillScope: 'all' });
    const newBlock = require('./managed-blocks').findBlocks(rendered.get('AGENTS.md').toString('utf8').replace(/\r\n/g, '\n')).blocks.harness.body;
    const text = read(dir, 'AGENTS.md');
    const s = text.indexOf('## 言語の設定');
    const e = text.indexOf('## Project Overview');
    write(dir, 'AGENTS.md', `${text.slice(0, s)}${marker('harness', 'start')}\n${newBlock}${marker('harness', 'end')}\n\n${text.slice(e)}`);
    // The same path twice, written two ways: one target.
    const resolved = runUpgrade({ dir, resolve: [RUNTIME, 'AGENTS.md#harness', RUNTIME.replace(/\//g, '\\')] });
    expect(resolved.lines).toEqual([`resolved: ${RUNTIME}`, 'resolved: AGENTS.md#harness', '0 pending left. Run upgrade --verify to confirm the install.']);
    expect(manifestOf(dir).pending).toBeUndefined();
    const again = upgrade(dir);
    expect(again.exitCode).toBe(0);
    expect(again.record.verdict.resolved).toEqual(expect.arrayContaining([RUNTIME, 'AGENTS.md#harness']));
    expect(again.lines.join('\n')).toMatch(/resolved by hand \(upgrade --resolve; review these in the update PR\): .*harness-runtime\.md/);
  }, 240000);

  test('apps.reason stays in the manifest and out of the render configuration (a release before 3.7.1 refuses it)', () => {
    const { resolveConfig } = require('./upgrade');
    const dir = fs.mkdtempSync(path.join(workspace, 'apps-reason-'));
    const manifest = { projectName: 'Demo', tools: ['claude-code'], stacks: [], apps: { frontend: 'web', reason: 'the app lives in web/' } };
    const { config } = resolveConfig(dir, manifest);
    expect(config.apps).toEqual({ frontend: 'web' });
    expect(manifest.apps.reason).toBe('the app lives in web/');
  });

  test('a conflict hashed before the layout read reviewBudgetScript still refuses --resolve and --verify when unchanged', () => {
    const dir = product('d6-legacy-hash');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'commit', '-qam', 'conflict');
    expect(upgrade(dir).exitCode).toBe(1);
    const conflict = manifestOf(dir).pending.find((p) => p.path === RUNTIME).conflict;
    expect(read(dir, RUNTIME)).toContain('node .claude/hooks/review-budget.cjs'); // so the declaration changes its reading
    // Declared afterwards (the conflict was hashed as 3.7.0 read the file): the .new dropped without merging.
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: 'scripts/review-budget.cjs' }, null, 2));
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    expect(() => runUpgrade({ dir, resolve: [RUNTIME] })).toThrow(/unchanged since the conflict/);
    // A resolved record with that hash: --verify still names the file.
    const m = manifestOf(dir);
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: undefined, resolved: [{ path: RUNTIME, version: m.version, conflict }] }, null, 2));
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.record.verdict.missing.map((x) => `${x.path} ${x.why}`).join('\n')).toMatch(/harness-runtime\.md resolved by hand, but it is empty or the same as when it conflicted/);
  }, 240000);

  // Cycle 3 (C2-H1): a reading follows the declarations, which may change between the conflict and its resolution;
  // conflictRaw (the file as it is) does not.
  const sha = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');
  const asLf = (text) => text.replace(/\r\n/g, '\n');
  const sameAsWhenItConflicted = /resolved by hand, but (it|the block) is empty or the same as when it conflicted/;
  const verifyMissing = (dir) => runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).record.verdict.missing.map((x) => `${x.path} ${x.why}`).join('\n');

  test('a conflict recorded under one review-budget declaration still refuses --resolve and --verify once the declaration changes or goes', () => {
    const dir = product('d6-raw-hash', { manifest: { reviewBudgetScript: 'scripts/review-budget-a.cjs' } });
    write(dir, 'scripts/review-budget-a.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'conflict');
    expect(upgrade(dir).exitCode).toBe(1);
    const pend = manifestOf(dir).pending.find((p) => p.path === RUNTIME);
    expect(read(dir, RUNTIME)).toContain('node .claude/hooks/review-budget.cjs'); // a conflicting file is not written
    expect(pend.conflictRaw).toEqual([sha(asLf(read(dir, RUNTIME)))]);
    expect(pend.conflict).not.toBe(pend.conflictRaw); // hashed in the declaration's reading
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`)); // dropped without merging
    for (const script of ['scripts/review-budget-b.cjs', undefined]) {
      write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: script }, null, 2));
      expect(() => runUpgrade({ dir, resolve: [RUNTIME] }), String(script)).toThrow(/unchanged since the conflict/);
    }
    const m = manifestOf(dir);
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: undefined, resolved: [{ path: RUNTIME, version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }] }, null, 2));
    expect(verifyMissing(dir)).toMatch(sameAsWhenItConflicted);
    // --resolve records conflictRaw with the resolved entry.
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: [pend], resolved: undefined }, null, 2));
    write(dir, RUNTIME, `${read(dir, RUNTIME)}\nmerged by hand\n`);
    runUpgrade({ dir, resolve: [RUNTIME] });
    expect(manifestOf(dir).resolved).toEqual([{ path: RUNTIME, version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }]);
  }, 240000);

  test('a pending conflict recorded by 3.7.0 is carried with its hash (never re-hashed), gains conflictRaw, and still refuses after the declaration goes', () => {
    const dir = product('d6-legacy-carried', { manifest: { reviewBudgetScript: 'scripts/review-budget.cjs' } });
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    // As 3.7.0 recorded it: hashed in its reading (no reviewBudgetScript), without conflictRaw.
    const legacy = sha(asLf(read(dir, RUNTIME)));
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), pending: [{ path: RUNTIME, baseVersion: OLD_VERSION, conflict: legacy }] }, null, 2));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pending from 3.7.0');
    expect(upgrade(dir).exitCode).toBe(1);
    expect(manifestOf(dir).pending).toEqual([{ path: RUNTIME, baseVersion: OLD_VERSION, conflict: legacy, conflictRaw: [legacy] }]);
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: undefined }, null, 2));
    expect(() => runUpgrade({ dir, resolve: [RUNTIME] })).toThrow(/unchanged since the conflict/);
    // Edited before the run: an earlier conflict gains no conflictRaw from content that is no longer the conflicting one.
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: 'scripts/review-budget.cjs', pending: [{ path: RUNTIME, baseVersion: OLD_VERSION, conflict: legacy }] }, null, 2));
    write(dir, RUNTIME, `${read(dir, RUNTIME)}\npartly merged\n`);
    upgrade(dir);
    expect(manifestOf(dir).pending).toEqual([{ path: RUNTIME, baseVersion: OLD_VERSION, conflict: legacy }]);
  }, 240000);

  test('a pending block conflict recorded by 3.7.0 is carried, left as it is, and refuses --resolve and --verify after the declaration goes', () => {
    const { findBlocks } = require('./managed-blocks');
    const dir = product('d6-block-carried', { manifest: { reviewBudgetScript: 'scripts/review-budget.cjs' } });
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    let text = read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE: node .claude/hooks/review-budget.cjs status');
    text = text.replace('## Language Setting', '<!-- ai-dev-helm:harness:start -->\n## Language Setting')
      .replace('\n## Project Overview', '<!-- ai-dev-helm:harness:end -->\n\n## Project Overview');
    write(dir, 'CLAUDE.md', text);
    const body = () => findBlocks(asLf(read(dir, 'CLAUDE.md'))).blocks.harness.body;
    const legacy = sha(body());
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), pending: [{ path: 'CLAUDE.md', block: 'harness', baseVersion: OLD_VERSION, conflict: legacy }] }, null, 2));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pending block from 3.7.0');
    expect(upgrade(dir).exitCode).toBe(1);
    // Plan C (3.7.2): the pending block is not written in this reading; it keeps the form 3.7.0 recorded.
    expect(read(dir, 'CLAUDE.md')).toContain('PRODUCT HARNESS LINE: node .claude/hooks/review-budget.cjs status');
    expect(sha(body())).toBe(legacy);
    const pend = manifestOf(dir).pending.find((p) => p.block === 'harness');
    expect(pend).toEqual({ path: 'CLAUDE.md', block: 'harness', baseVersion: OLD_VERSION, conflict: legacy, conflictRaw: [legacy] });
    fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'), { force: true });
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: undefined }, null, 2));
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
    const m = manifestOf(dir);
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: undefined, resolved: [{ path: 'CLAUDE.md', block: 'harness', version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }] }, null, 2));
    expect(verifyMissing(dir)).toMatch(/CLAUDE\.md#harness resolved by hand, but the block is empty or the same as when it conflicted/);
  }, 240000);

  // Cycle 4 (C3-H1): a root rule file is written back in each run's reading, so a run after a declaration changed
  // leaves the conflicting block in a form the first record did not know; conflictRaw keeps every form it was seen in.
  for (const [kind, declaration] of [
    ['reviewBudgetScript', { reviewBudgetScript: 'scripts/review-budget.cjs' }],
    ['skillTargets', { skillTargets: { project: ['.claude/skills/project'] } }],
  ]) {
    test(`a block conflict still refuses --resolve and --verify after ${kind} is declared and upgrade runs again, and after the file goes back to its first form`, () => {
      const { findBlocks } = require('./managed-blocks');
      const dir = product(`d6-block-redeclared-${kind}`);
      write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
      let text = read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE: node .claude/hooks/review-budget.cjs status; skills/project/quality-check/SKILL.md');
      text = text.replace('## Language Setting', '<!-- ai-dev-helm:harness:start -->\n## Language Setting')
        .replace('\n## Project Overview', '<!-- ai-dev-helm:harness:end -->\n\n## Project Overview');
      write(dir, 'CLAUDE.md', text);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'block conflict');
      expect(upgrade(dir).exitCode).toBe(1);
      const first = read(dir, 'CLAUDE.md');
      const body = () => findBlocks(asLf(read(dir, 'CLAUDE.md'))).blocks.harness.body;
      const firstBody = body();
      expect(manifestOf(dir).pending.find((p) => p.block === 'harness').conflictRaw).toEqual([sha(firstBody)]);
      // Declared after the conflict, then upgrade again: the pending block is left as it is (plan C, 3.7.2) - 3.7.1 wrote
      // it back in the new reading, a form only that run's manifest knew. Nothing else of the file changes: not written.
      write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), ...declaration }, null, 2));
      const rerun = upgrade(dir);
      expect(rerun.exitCode).toBe(1);
      expect(read(dir, 'CLAUDE.md')).toBe(first);
      expect(actionsOf(rerun, 'CLAUDE.md').filter((a) => /references read as the layout|not written/.test(a))).toEqual([]);
      const pend = manifestOf(dir).pending.find((p) => p.block === 'harness');
      expect(pend.conflictRaw).toEqual([sha(firstBody)]);
      fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'), { force: true }); // dropped without merging
      expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
      const m = manifestOf(dir);
      write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: undefined, resolved: [{ path: 'CLAUDE.md', block: 'harness', version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }] }, null, 2));
      expect(verifyMissing(dir)).toMatch(/CLAUDE\.md#harness resolved by hand, but the block is empty or the same as when it conflicted/);
      // Written back as it was (git checkout): still refused.
      write(dir, '.ai-dev-helm.json', JSON.stringify(m, null, 2));
      write(dir, 'CLAUDE.md', first);
      expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
      // conflictRaw as cycle 3 recorded it (one string) is read as a list of one.
      write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: [{ ...pend, conflict: sha('another reading'), conflictRaw: sha(firstBody) }] }, null, 2));
      expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
      // Merged by hand: resolved, with every form it was seen in.
      write(dir, '.ai-dev-helm.json', JSON.stringify(m, null, 2));
      write(dir, 'CLAUDE.md', first.replace('PRODUCT HARNESS LINE', 'PRODUCT HARNESS LINE merged by hand'));
      runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] });
      expect(manifestOf(dir).resolved).toEqual([{ path: 'CLAUDE.md', block: 'harness', version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }]);
    }, 240000);
  }

  // Cycle 5 (C4-H1): the run after the declaration changed stops between writing the files and recording the manifest
  // (a failed write, Ctrl+C). Plan C (3.7.2): that run leaves the pending block as it is, so it is still refused.
  test('a block conflict still refuses --resolve and --verify when the run after a declaration change stops before recording the manifest', () => {
    const { findBlocks } = require('./managed-blocks');
    const dir = product('d6-block-redeclared-stopped');
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    let text = read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE: node .claude/hooks/review-budget.cjs status');
    text = text.replace('## Language Setting', '<!-- ai-dev-helm:harness:start -->\n## Language Setting')
      .replace('\n## Project Overview', '<!-- ai-dev-helm:harness:end -->\n\n## Project Overview');
    write(dir, 'CLAUDE.md', text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'block conflict');
    expect(upgrade(dir).exitCode).toBe(1);
    const body = () => findBlocks(asLf(read(dir, 'CLAUDE.md'))).blocks.harness.body;
    const firstBody = body();
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: 'scripts/review-budget.cjs' }, null, 2));
    const before = manifestOf(dir);
    // Stopped: a manifest write after another file was written throws.
    const realWrite = fs.writeFileSync;
    const wrote = [];
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      const name = path.basename(String(file));
      if (name === '.ai-dev-helm.json' && wrote.length) throw new Error('stopped before the manifest was recorded');
      if (name !== '.ai-dev-helm.json') wrote.push(name);
      return realWrite.call(fs, file, ...rest);
    });
    try {
      expect(() => upgrade(dir)).toThrow(/stopped before the manifest was recorded/);
    } finally {
      spy.mockRestore();
    }
    expect(wrote.length).toBeGreaterThan(0); // the documents read as the layout were written
    expect(body()).toBe(firstBody); // the pending block was not
    expect(manifestOf(dir)).toEqual(before);
    // The next run completes; the .new is then dropped without merging.
    expect(upgrade(dir).exitCode).toBe(1);
    const pend = manifestOf(dir).pending.find((p) => p.block === 'harness');
    expect(pend.conflictRaw).toEqual([sha(firstBody)]);
    fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'), { force: true });
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
    const m = manifestOf(dir);
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: undefined, resolved: [{ path: 'CLAUDE.md', block: 'harness', version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }] }, null, 2));
    expect(verifyMissing(dir)).toMatch(/CLAUDE\.md#harness resolved by hand, but the block is empty or the same as when it conflicted/);
  }, 240000);

  test('a declared review-budget is read into the product\'s files once: only the call changes, a second run changes nothing; an ignore line already there stays', () => {
    const dir = product('d6-relay', { manifest: { reviewBudgetScript: 'scripts/review-budget.cjs' } });
    for (const rel of ['.claude/hooks/review-budget.cjs', '.codex/hooks/review-budget.cjs']) fs.rmSync(path.join(dir, rel), { force: true });
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    // The product's own section of AGENTS.md (outside the managed blocks), CRLF, with trailing spaces and paths
    // that look like the layout's but are not (a tree without skillTargets, another hook, a longer name).
    const own = [
      '## Product notes',
      '',
      'Before a review: node .claude/hooks/review-budget.cjs status  ',
      'Legacy skills stay under .codex/skills/legacy/ and skills/legacy/.',
      'Our hook: node .claude/hooks/other.cjs; not node .claude/hooks/review-budget.cjs.bak',
      '',
    ];
    const before = `${read(dir, 'AGENTS.md').replace(/\r?\n/g, '\r\n')}\r\n${own.join('\r\n')}`;
    write(dir, 'AGENTS.md', before);
    // A tracked skills directory whose ignore line init already wrote: the line is not removed (the rollout does).
    if (!read(dir, '.gitignore').split(/\r?\n/).includes('/.cursor/skills')) write(dir, '.gitignore', `${read(dir, '.gitignore')}\n/.cursor/skills\n`);
    write(dir, '.cursor/skills/own/SKILL.md', '# own skill\n');
    git(dir, 'add', '-A');
    git(dir, 'add', '-f', '.cursor/skills/own/SKILL.md');
    git(dir, 'commit', '-qm', 'product files');
    const result = upgrade(dir);
    expect(result.record.verdict.missing).toEqual([]);
    expect(result.exitCode).toBe(0);
    const agents = read(dir, 'AGENTS.md');
    const tail = agents.slice(agents.indexOf('## Product notes'));
    // 3.7.2 (U4): the product's section outside the managed blocks is not read (3.7.1 rewrote the call); the record
    // names its line in the file as written.
    expect(tail).toBe(own.join('\r\n'));
    const line = asLf(agents).split('\n').indexOf(own[2]) + 1;
    expect(result.record.warnings.filter((w) => w.startsWith('AGENTS.md line'))).toEqual([expect.stringMatching(new RegExp(`^AGENTS\\.md line ${line} \\(as written\\): the product's text outside the managed blocks`))]);
    expect(agents.split('\r\n').length).toBe(agents.split('\n').length); // still CRLF throughout
    expect(read(dir, RUNTIME)).toContain('node scripts/review-budget.cjs');
    expect(read(dir, '.gitignore').split(/\r?\n/)).toContain('/.cursor/skills');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    const again = upgrade(dir);
    expect(again.exitCode).toBe(0);
    expect(again.record.actions.filter((a) => /references read as the layout/.test(a.action))).toEqual([]);
    expect(git(dir, 'status', '--short', '--', '.', ':!.ai-dev-helm.json')).toBe(''); // the manifest: appliedAt only
  }, 240000);

  test('tool files outside tools are warned of; a tracked skills directory gets no .gitignore line; mergeDeny: false adds no permissions', () => {
    const dir = product('d6-tools', { tools: 'claude-code', manifest: { settings: { mergeDeny: false } } });
    write(dir, '.cursorrules', 'own cursor rules\n');
    write(dir, '.codex/config.toml', '# own\n');
    // A real, tracked skills directory (an adopter's .codex/skills) whose ignore line was never added.
    write(dir, '.cursor/skills/own/SKILL.md', '# own skill\n');
    write(dir, '.gitignore', read(dir, '.gitignore').split('\n').filter((l) => l.trim() !== '/.cursor/skills').join('\n'));
    const settings = JSON.parse(read(dir, '.claude/settings.json'));
    delete settings.permissions;
    write(dir, '.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'product layout');
    const plan = upgrade(dir, { mode: 'plan' });
    expect(plan.record.warnings).toHaveLength(2);
    expect(plan.lines.join('\n')).toMatch(/Warnings \(2\)[\s\S]*\.cursorrules exist, but tools has no cursor[\s\S]*\.codex\/ exists, but tools has no codex/);
    const result = upgrade(dir);
    expect(result.record.verdict.missing).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(read(dir, '.gitignore').split(/\r?\n/)).not.toContain('/.cursor/skills');
    expect(JSON.parse(read(dir, '.claude/settings.json')).permissions).toBeUndefined();
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    expect(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }).exitCode).toBe(0);
  }, 240000);
});

// 3.7.2 (U2-U5): findings of the 3.7.1 rollout and the medium findings 3.7.1's upgrade PR recorded.
describe('upgrade: 3.7.1 rollout and recorded findings (3.7.2 U2-U5)', () => {
  const sha = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');
  const asLf = (text) => text.replace(/\r\n/g, '\n');
  const ignoredWarning = (result) => result.record.warnings.find((w) => /where git ignores them/.test(w)) || '';
  const wrapHarness = (text) => text.replace('## Language Setting', '<!-- ai-dev-helm:harness:start -->\n## Language Setting')
    .replace('\n## Project Overview', '<!-- ai-dev-helm:harness:end -->\n\n## Project Overview');

  test('3.7.2 (U2, U3): a tool added to tools gets its files as new for that tool; files written where git ignores them are warned of', () => {
    const dir = product('u2-u3-added-tool', { tools: 'claude-code,codex' });
    write(dir, '.gitignore', `${read(dir, '.gitignore')}\n.cursor/\n`);
    fs.rmSync(path.join(dir, 'documents/development/harness-upgrade.md'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'ignore .cursor/; delete a document');
    const tools = ['claude-code', 'codex', 'cursor'];
    const plan = upgrade(dir, { mode: 'plan', overrides: { tools } });
    const rules = plan.record.actions.filter((a) => a.path.startsWith('.cursor/rules/'));
    expect(rules.length).toBeGreaterThan(0);
    for (const a of rules) expect(a.action, a.path).toBe('added (new for the tool added to tools)');
    // A file of a tool already recorded that the product deleted is still told apart.
    expect(actionsOf(plan, 'documents/development/harness-upgrade.md')).toEqual(['added (the product had deleted it; exclude it with a reason to keep it out)']);
    expect(ignoredWarning(plan)).toMatch(/^\d+ file\(s\) to be written where git ignores them/);
    expect(ignoredWarning(plan)).toContain('.cursor/hooks.json');
    expect(ignoredWarning(plan)).toContain(rules[0].path);
    expect(ignoredWarning(plan)).not.toMatch(/AGENTS\.md|\.codex\/|harness-upgrade\.md/);
    const result = upgrade(dir, { overrides: { tools } });
    expect(result.record.verdict.missing).toEqual([]);
    expect(result.exitCode).toBe(0); // a warning, not a failure
    expect(ignoredWarning(result)).toMatch(/^\d+ file\(s\) written where git ignores them/);
    expect(result.lines.join('\n')).toMatch(/Warnings \(\d+\)[\s\S]*written where git ignores them.*\.cursor\/hooks\.json/); // printed too
    // Tracked (git add -f, as the rollout did): no warning afterwards.
    git(dir, 'add', '-A');
    git(dir, 'add', '-f', '.cursor');
    git(dir, 'commit', '-qm', 'upgrade');
    write(dir, '.cursor/hooks.json', '{}\n'); // rewritten by the next run, still tracked
    const again = upgrade(dir);
    expect(actionsOf(again, '.cursor/hooks.json')).toEqual(['merged (own merge)']);
    expect(ignoredWarning(again)).toBe('');
    // The tools recorded now: a deleted Cursor file is the product's deletion again.
    fs.rmSync(path.join(dir, rules[0].path));
    expect(actionsOf(upgrade(dir, { mode: 'plan' }), rules[0].path)).toEqual(['added (the product had deleted it; exclude it with a reason to keep it out)']);
  }, 240000);

  // The tool's files were there while tools left it out (toolFileWarnings): one missing may have been deleted on purpose,
  // so it is not told as new for the added tool (that would say no declaration is needed).
  test('3.7.2 (U3): a tool added to tools whose files the product already has gets the files it lacks told as deleted', () => {
    const dir = product('u3-tool-there', { tools: 'claude-code' });
    // One Codex rule the release renders, kept while tools left Codex out (the other deleted).
    write(dir, '.codex/rules/ai-dev-helm-safety.rules', '# kept from an earlier install\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'a Codex rule kept');
    expect(upgrade(dir, { mode: 'plan' }).record.warnings.some((w) => /tools has no codex/.test(w))).toBe(true);
    const plan = upgrade(dir, { mode: 'plan', overrides: { tools: ['claude-code', 'codex'] } });
    expect(actionsOf(plan, '.codex/rules/frontend/coding.md')).toEqual(['added (the product had deleted it; exclude it with a reason to keep it out)']);
  }, 240000);

  // C2-M2 (3.7.2 quality-check): files of the tool's place the release never renders, or its root rule file, are not the
  // tool's install: a first install is told as new for the tool, so no exclude is asked for.
  test('3.7.2 (U3): a tool added to tools is new for the tool while the product has only files the release does not render there', () => {
    const dir = product('u3-tool-not-there', { tools: 'claude-code' });
    write(dir, 'AGENTS.md', '# Notes for other agents\n\nThe product\'s own AGENTS.md.\n');
    write(dir, '.claude/settings.local.json', '{}\n');
    write(dir, '.cursor/mcp.json', '{}\n');
    write(dir, '.cursor/rules/own.mdc', '# the product\'s own Cursor rule\n');
    write(dir, '.codex/config.toml', '# the product\'s own Codex settings\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'files of other tools');
    const plan = upgrade(dir, { mode: 'plan', overrides: { tools: ['claude-code', 'codex', 'cursor'] } });
    for (const rel of ['.codex/rules/frontend/coding.md', '.cursor/rules/frontend-coding.mdc']) expect(actionsOf(plan, rel), rel).toEqual(['added (new for the tool added to tools)']);
    expect(plan.record.actions.filter((a) => /^\.(codex|cursor)\//.test(a.path) && /had deleted/.test(a.action))).toEqual([]);
  }, 240000);

  // The 3.7.1 rollout (C3-M1): a sentence an adopter wrote about its own layout outside the managed blocks was read
  // as the distributed paths and lost its meaning; corrected by hand, the next run rewrote it again.
  test('3.7.2 (U4): the layout reading reaches the managed blocks only - a product section corrected by hand stays as written, run after run', () => {
    const { findBlocks } = require('./managed-blocks');
    const targets = { project: ['.agents/skills/project'], superpowers: ['.agents/skills/superpowers'] };
    const dir = product('u4-outside', { manifest: { skillTargets: targets } });
    const own = [
      '## Product layout notes',
      '',
      'Codex starts from its own skill map `.codex/skills/project/SKILLS.md` (corrected by hand).',
      'Cursor reads `.cursor/skills/project/` here; skills/project/ is not used.',
      '',
    ];
    const before = `${asLf(read(dir, 'AGENTS.md'))}\n${own.join('\n')}`;
    write(dir, 'AGENTS.md', before);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'product section');
    // --plan names the lines of the file as it is (nothing is written).
    const lineBefore = before.split('\n').indexOf(own[2]) + 1;
    const plan = upgrade(dir, { mode: 'plan' });
    expect(plan.record.warnings.filter((w) => w.startsWith('AGENTS.md line'))).toEqual([expect.stringMatching(new RegExp(`^AGENTS\\.md line ${lineBefore}, ${lineBefore + 1}: `))]);
    // --verify writes nothing and names nothing (the run that writes the file does - 3.7.2 quality-check).
    const verify = runUpgrade({ dir, mode: 'verify', baseDir: oldPackage });
    expect(verify.record.warnings.filter((w) => w.startsWith('AGENTS.md line'))).toEqual([]);
    expect(read(dir, 'AGENTS.md')).toBe(before);
    const result = upgrade(dir);
    expect(result.record.verdict.missing).toEqual([]);
    expect(result.exitCode).toBe(0);
    const agents = asLf(read(dir, 'AGENTS.md'));
    expect(agents.slice(agents.indexOf('## Product layout notes'))).toBe(own.join('\n'));
    // Inside the blocks the reading applies: the table and the sentence naming the place.
    const skills = findBlocks(agents).blocks.skills.body;
    expect(skills).toContain('Located under `.agents/skills/project/` and `.agents/skills/superpowers/`.');
    expect(skills).toContain('`.agents/skills/project/quality-check/SKILL.md`');
    expect(skills).not.toContain('.codex/skills/');
    // The run wrapped and updated the blocks above the section (their length changed): the record names the lines of
    // the file as written, where the reader finds them.
    const line = agents.split('\n').indexOf(own[2]) + 1;
    expect(line).not.toBe(lineBefore);
    expect(result.record.warnings.filter((w) => w.startsWith('AGENTS.md line'))).toEqual([expect.stringMatching(new RegExp(`^AGENTS\\.md line ${line}, ${line + 1} \\(as written\\): `))]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    const committed = read(dir, 'AGENTS.md');
    const again = upgrade(dir);
    expect(again.exitCode).toBe(0);
    expect(read(dir, 'AGENTS.md')).toBe(committed);
    expect(again.record.actions.filter((a) => /references read as the layout/.test(a.action))).toEqual([]);
    // A run that leaves the file as it is names nothing (3.7.2 quality-check: not the same warning on every run); the
    // section is never rewritten.
    expect(again.record.warnings.some((w) => w.startsWith('AGENTS.md line'))).toBe(false);
    expect(upgrade(dir, { mode: 'plan' }).record.warnings.some((w) => w.startsWith('AGENTS.md line'))).toBe(false);
    expect(git(dir, 'status', '--short', '--', '.', ':!.ai-dev-helm.json')).toBe('');
  }, 240000);

  // 3.7.1 C4-M1 (a pending entry with conflictRaw is re-run after a hand edit) and Q5-M1 (--resolve with the markers
  // of an unfinished merge still in the file or block).
  test('3.7.2 (U5): a pending conflict with conflictRaw gains nothing from a run after a hand edit; --resolve refuses conflict markers', () => {
    const { findBlocks } = require('./managed-blocks');
    const dir = product('u5-hand-edit');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    write(dir, 'CLAUDE.md', wrapHarness(read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE')));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'conflicts');
    expect(upgrade(dir).exitCode).toBe(1);
    const pending = manifestOf(dir).pending;
    const file = pending.find((p) => p.path === RUNTIME);
    const block = pending.find((p) => p.path === 'CLAUDE.md' && p.block === 'harness');
    expect(file.conflictRaw).toEqual([sha(asLf(read(dir, RUNTIME)))]);
    expect(block.conflictRaw).toEqual([sha(findBlocks(asLf(read(dir, 'CLAUDE.md'))).blocks.harness.body)]);
    // Partly merged by hand, still conflicting: the forms of the edited content are not the conflicting one.
    write(dir, RUNTIME, `${read(dir, RUNTIME)}\npartly merged\n`);
    write(dir, 'CLAUDE.md', read(dir, 'CLAUDE.md').replace('PRODUCT HARNESS LINE', 'PRODUCT HARNESS LINE (partly merged)'));
    expect(upgrade(dir).exitCode).toBe(1);
    expect(manifestOf(dir).pending.find((p) => p.path === RUNTIME)).toEqual(file);
    expect(manifestOf(dir).pending.find((p) => p.block === 'harness')).toEqual(block);

    // Q5-M1: the markers of a merge tool left in. Seven `=` alone (a Markdown heading underline) is not one.
    const merged = `${read(dir, RUNTIME)}\nmerged by hand\n`;
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'));
    const halfDone = merged.replace('PRODUCT REWRITE of the same line', '<<<<<<< product\nPRODUCT REWRITE of the same line\n=======\nTHE RELEASE LINE\n>>>>>>> new release');
    write(dir, RUNTIME, halfDone);
    const manifestBefore = read(dir, '.ai-dev-helm.json');
    expect(() => runUpgrade({ dir, resolve: [RUNTIME] })).toThrow(/harness-runtime\.md still has conflict markers .*line 3\): finish the merge/);
    const rules = read(dir, 'CLAUDE.md');
    write(dir, 'CLAUDE.md', rules.replace('PRODUCT HARNESS LINE (partly merged)', '<<<<<<< ours\nPRODUCT HARNESS LINE\n||||||| base\n=======\nRELEASE LINE\n>>>>>>> theirs'));
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/CLAUDE\.md#harness still has conflict markers .* of the block\)/);
    expect(read(dir, '.ai-dev-helm.json')).toBe(manifestBefore);
    write(dir, RUNTIME, `${merged}\nA heading\n=======\n`);
    write(dir, 'CLAUDE.md', rules.replace('PRODUCT HARNESS LINE (partly merged)', 'PRODUCT HARNESS LINE merged by hand'));
    const resolved = runUpgrade({ dir, resolve: [RUNTIME, 'CLAUDE.md#harness'] });
    expect(resolved.lines).toEqual([`resolved: ${RUNTIME}`, 'resolved: CLAUDE.md#harness', '0 pending left. Run upgrade --verify to confirm the install.']);
  }, 240000);

  // 3.7.1 C4-M2: the declaration was there at the conflict. 3.7.1 wrote the block in its reading in the first run (the
  // next run saw only that form); plan C (3.7.2) leaves it as it is, so its one form is the first.
  test('3.7.2 (U5): a block conflict under a declaration keeps its first form across runs; still refused after the declaration goes', () => {
    const { findBlocks } = require('./managed-blocks');
    const dir = product('u5-declared-at-conflict', { manifest: { reviewBudgetScript: 'scripts/review-budget.cjs' } });
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    write(dir, 'CLAUDE.md', wrapHarness(read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE: node .claude/hooks/review-budget.cjs status')));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'block conflict under a declaration');
    const body = () => findBlocks(asLf(read(dir, 'CLAUDE.md'))).blocks.harness.body;
    const firstBody = body();
    expect(upgrade(dir).exitCode).toBe(1);
    expect(body()).toBe(firstBody); // not written in the reading
    expect(manifestOf(dir).pending.find((p) => p.block === 'harness').conflictRaw).toEqual([sha(firstBody)]);
    expect(upgrade(dir).exitCode).toBe(1);
    expect(body()).toBe(firstBody);
    expect(manifestOf(dir).pending.find((p) => p.block === 'harness').conflictRaw).toEqual([sha(firstBody)]);
    // The declaration goes; the .new dropped without merging.
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: undefined }, null, 2));
    fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'), { force: true });
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
  }, 240000);

  // 3.7.1 Q5-M1, the path itself (C1-M3 of the 3.7.2 quality-check), closed by plan C: a block conflict is committed,
  // a declaration changes, upgrade runs again, the manifest alone is restored with git and the .ai-dev-helm-new is
  // deleted unmerged (or left unmerged). The run left the pending block as it was, so the restored manifest's record
  // still knows its form and --resolve refuses - no record outside the product's files is needed. The other blocks of
  // the file are still read as the layout.
  test('3.7.2 (plan C): a block conflict left as it is refuses --resolve after a declaration change, the manifest alone restored', () => {
    const { findBlocks } = require('./managed-blocks');
    const dir = product('planc-manifest-restored');
    write(dir, 'CLAUDE.md', wrapHarness(read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE: see skills/project/quality-check/SKILL.md')));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'block conflict');
    const blockOf = (name) => findBlocks(asLf(read(dir, 'CLAUDE.md'))).blocks[name].body;
    expect(upgrade(dir).exitCode).toBe(1);
    const firstBody = blockOf('harness');
    // The refs block (wrapped by that run) gets a note of the product's that the layout reads.
    write(dir, 'CLAUDE.md', read(dir, 'CLAUDE.md').replace('<!-- ai-dev-helm:refs:end -->', 'Product note in the refs block: skills/project/quality-check/SKILL.md\n<!-- ai-dev-helm:refs:end -->'));
    expect(blockOf('refs')).toContain('Product note in the refs block: skills/project/quality-check/SKILL.md');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'conflict pending, a refs note');
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), skillTargets: { project: ['proj-skills'] } }, null, 2));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'skillTargets declared');
    const rerun = upgrade(dir);
    expect(rerun.exitCode).toBe(1);
    expect(blockOf('harness')).toBe(firstBody); // still skills/project/: left as it is
    expect(blockOf('refs')).toContain('Product note in the refs block: proj-skills/quality-check/SKILL.md'); // read as the layout
    expect(actionsOf(rerun, 'CLAUDE.md')).toContain('references read as the layout');
    // The product's own line inside a block, read as the layout: named for the update PR (cycle 9 of the quality-check).
    const noteLine = asLf(read(dir, 'CLAUDE.md')).split('\n').indexOf('Product note in the refs block: proj-skills/quality-check/SKILL.md') + 1;
    expect(rerun.record.warnings).toContainEqual(expect.stringMatching(new RegExp(`^CLAUDE\\.md line ${noteLine} \\(as written\\): lines of the product's own inside the managed blocks`)));
    expect(exists(dir, 'CLAUDE.md.ai-dev-helm-new')).toBe(true); // the release's side, for the hand merge
    expect(manifestOf(dir).pending.find((p) => p.block === 'harness').conflictRaw).toEqual([sha(firstBody)]);
    // The manifest alone restored; the .new deleted unmerged: refused, and told how to get the .new back.
    git(dir, 'checkout', '--', '.ai-dev-helm.json');
    fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'));
    const manifestBefore = read(dir, '.ai-dev-helm.json');
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/CLAUDE\.md#harness is unchanged since the conflict: .*run upgrade again to put it back/);
    expect(read(dir, '.ai-dev-helm.json')).toBe(manifestBefore);
    // Restored to the manifest from before the declaration too.
    git(dir, 'checkout', 'HEAD~1', '--', '.ai-dev-helm.json');
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/CLAUDE\.md#harness is unchanged since the conflict/);
    git(dir, 'checkout', 'HEAD', '--', '.ai-dev-helm.json');
    // upgrade puts the .new back; left unmerged beside the block, still refused.
    expect(upgrade(dir).exitCode).toBe(1);
    expect(exists(dir, 'CLAUDE.md.ai-dev-helm-new')).toBe(true);
    expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/CLAUDE\.md#harness is unchanged since the conflict/);
    // Merged by hand (the release's block taken in): resolved.
    const release = findBlocks(asLf(read(dir, 'CLAUDE.md.ai-dev-helm-new'))).blocks.harness.body;
    const now = asLf(read(dir, 'CLAUDE.md'));
    write(dir, 'CLAUDE.md', now.replace(firstBody, release));
    fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'));
    expect(runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] }).exitCode).toBe(0);
    expect(upgrade(dir).exitCode).toBe(0);
  }, 240000);

  // Cycle 6: a run that leaves a root rule file as it is but a block conflict of it pending (merged by hand in that
  // update PR) names the product's text outside the blocks; --verify does not.
  test('3.7.2 (U4): a run that leaves only a block conflict of a root rule file names the text outside the blocks', () => {
    const dir = product('u4-block-conflict', { manifest: { reviewBudgetScript: 'scripts/review-budget.cjs' } });
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    const sentence = 'Run node .claude/hooks/review-budget.cjs status before a review.';
    write(dir, 'CLAUDE.md', `${wrapHarness(read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE'))}\n## Product notes\n\n${sentence}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'block conflict, a product section');
    expect(upgrade(dir).exitCode).toBe(1);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'conflict pending');
    const text = read(dir, 'CLAUDE.md');
    const line = asLf(text).split('\n').indexOf(sentence) + 1;
    expect(line).toBeGreaterThan(0);
    const named = (r) => r.record.warnings.filter((w) => w.startsWith('CLAUDE.md line'));
    expect(named(upgrade(dir, { mode: 'plan' }))).toEqual([expect.stringMatching(new RegExp(`^CLAUDE\\.md line ${line}: `))]);
    const again = upgrade(dir);
    expect(again.exitCode).toBe(1);
    expect(manifestOf(dir).pending.map((p) => `${p.path}#${p.block}`)).toEqual(['CLAUDE.md#harness']);
    expect(read(dir, 'CLAUDE.md')).toBe(text); // the file itself is left as it is
    expect(named(again)).toEqual([expect.stringMatching(new RegExp(`^CLAUDE\\.md line ${line}: `))]);
    expect(named(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }))).toEqual([]);
  }, 240000);

  // Cycle 6: a declaration may change no block (no template calls review-budget): the first run after it names the
  // product's text outside the blocks once (layoutRead), the runs after it do not.
  test('3.7.2 (U4): the first run after a declaration names the text outside the blocks once, though no block changes', () => {
    const dir = product('u4-declared-later');
    const sentence = 'Run node .claude/hooks/review-budget.cjs status before a review.';
    write(dir, 'CLAUDE.md', `${read(dir, 'CLAUDE.md')}\n## Product notes\n\n${sentence}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'a product section');
    const named = (r) => r.record.warnings.filter((w) => w.startsWith('CLAUDE.md line'));
    const first = upgrade(dir);
    expect(first.exitCode).toBe(0);
    expect(named(first)).toEqual([]); // nothing declared: the reading changes nothing
    expect(manifestOf(dir).layoutRead).toMatch(/^[0-9a-f]{64}$/);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'upgrade');
    write(dir, 'scripts/review-budget.cjs', read(ROOT, 'templates/hooks/review-budget.cjs'));
    write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), reviewBudgetScript: 'scripts/review-budget.cjs' }, null, 2));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'reviewBudgetScript declared');
    const text = read(dir, 'CLAUDE.md');
    const line = asLf(text).split('\n').indexOf(sentence) + 1;
    expect(named(runUpgrade({ dir, mode: 'verify', baseDir: oldPackage }))).toEqual([]);
    expect(named(upgrade(dir, { mode: 'plan' }))).toEqual([expect.stringMatching(new RegExp(`^CLAUDE\\.md line ${line}: `))]);
    const declared = upgrade(dir);
    expect(declared.exitCode).toBe(0);
    expect(read(dir, 'CLAUDE.md')).toBe(text); // no block changed
    expect(named(declared)).toEqual([expect.stringMatching(new RegExp(`^CLAUDE\\.md line ${line}: `))]);
    expect(named(upgrade(dir))).toEqual([]);
    expect(named(upgrade(dir, { mode: 'plan' }))).toEqual([]);
  }, 240000);

  // 3.7.2 (rule 3 of the design "git location"): with only one of GIT_DIR / GIT_WORK_TREE (a git hook gets GIT_DIR
  // alone) git takes the current directory for the top of the work tree; upgrade and --resolve write nothing, --plan
  // and --verify warn. With both set, as without them.
  const withEnv = (env, fn) => {
    const saved = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE'].map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try { return fn(); } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  test('3.7.2 (rule 3): with only one of GIT_DIR / GIT_WORK_TREE, upgrade and --resolve write nothing; --plan and --verify warn', () => {
    const dir = product('rule3-one-variable');
    const lines = read(dir, RUNTIME).split('\n');
    lines[2] = 'PRODUCT REWRITE of the same line';
    write(dir, RUNTIME, lines.join('\n'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'conflict');
    expect(upgrade(dir).exitCode).toBe(1);
    write(dir, RUNTIME, `${read(dir, RUNTIME)}\nmerged by hand\n`);
    fs.rmSync(path.join(dir, `${RUNTIME}.ai-dev-helm-new`));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'merged by hand, not resolved yet');
    const manifestBefore = read(dir, '.ai-dev-helm.json');
    for (const env of [{ GIT_DIR: path.join(dir, '.git') }, { GIT_WORK_TREE: dir }, { GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: '' }]) {
      withEnv(env, () => {
        expect(() => upgrade(dir), JSON.stringify(env)).toThrow(/only one of them is set, or one is empty .*so upgrade cannot tell which repository it writes for\..*Nothing was written\./);
        expect(() => runUpgrade({ dir, resolve: [RUNTIME] })).toThrow(/so upgrade --resolve cannot tell/);
        for (const mode of ['plan', 'verify']) {
          expect(upgrade(dir, { mode }).record.warnings, mode).toContainEqual(expect.stringMatching(/^GIT_DIR \/ GIT_WORK_TREE: only one of them is set.*write nothing in this environment/));
        }
      });
      expect(read(dir, '.ai-dev-helm.json')).toBe(manifestBefore);
      expect(git(dir, 'status', '--porcelain')).toBe('');
    }
    withEnv({ GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: dir }, () => {
      expect(upgrade(dir, { mode: 'plan' }).record.warnings.filter((w) => w.startsWith('GIT_DIR'))).toEqual([]);
      expect(runUpgrade({ dir, resolve: [RUNTIME] }).exitCode).toBe(0);
    });
  }, 240000);

  // 3.7.2 (rule 2 of the design "git location"; C8-H1 of the quality-check): git in the product's directory inherits the
  // environment, so a product that keeps its repository outside the work tree (GIT_DIR and GIT_WORK_TREE set, no .git)
  // is upgraded as with a .git: tracked files get no backups, the U2 warning reads its .gitignore. Rule 1: the scratch
  // render's git init never reaches that repository.
  test('3.7.2 (rule 2): a product with its repository outside the work tree is upgraded as with a .git', () => {
    const dir = product('rule2-outside');
    write(dir, '.gitignore', `${read(dir, '.gitignore')}\n/documents/development/runtime-upgrade.md\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'the new release file ignored');
    const store = path.join(workspace, 'rule2-outside.git');
    fs.renameSync(path.join(dir, '.git'), store);
    let result;
    try {
      result = withEnv({ GIT_DIR: store, GIT_WORK_TREE: dir }, () => upgrade(dir));
    } finally {
      fs.renameSync(store, path.join(dir, '.git'));
    }
    expect(result.exitCode).toBe(0);
    expect(result.record.warnings).toContainEqual(expect.stringMatching(/written where git ignores them and does not track them.*documents\/development\/runtime-upgrade\.md/));
    expect(fs.readdirSync(dir).filter((f) => /\.backup\.\d+$/.test(f))).toEqual([]);
    expect(git(dir, 'config', 'core.bare').trim()).toBe('false');
  }, 240000);

  // Plan C's guard (cycle 9 of the quality-check): if a pending block could not be kept as it is - not seen with any real
  // input; here blockOf is made to find it differently in the text to be written - the run writes nothing at all (not
  // the other blocks while the manifest moves on), apply and --plan alike; --verify only reads.
  test('3.7.2 (plan C): a pending block that cannot be kept as it is stops the whole run before anything is written', () => {
    const blocks = require('./managed-blocks');
    const dir = product('planc-guard');
    write(dir, 'CLAUDE.md', wrapHarness(read(dir, 'CLAUDE.md').replace(OLD_HARNESS_LINE, 'PRODUCT HARNESS LINE')));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'block conflict; skills and refs not wrapped yet');
    const before = asLf(read(dir, 'CLAUDE.md'));
    const real = blocks.blockOf;
    const spy = vi.spyOn(blocks, 'blockOf').mockImplementation((file, name, text, newBody) => {
      const found = real(file, name, text, newBody);
      // Found differently once the other blocks are wrapped (the text to be written), never in the file as it is.
      return found && file === 'CLAUDE.md' && name === 'harness' && text !== before && text.includes('PRODUCT HARNESS LINE') ? { ...found, body: `${found.body}changed\n` } : found;
    });
    try {
      for (const mode of ['apply', 'plan']) expect(() => upgrade(dir, { mode }), mode).toThrow(/CLAUDE\.md: the pending block harness could not be kept as it is, so nothing was written/);
      expect(upgrade(dir, { mode: 'verify' }).exitCode).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(upgrade(dir).exitCode).toBe(1); // without the stand-in: the block conflict pending, the file written
    expect(asLf(read(dir, 'CLAUDE.md'))).not.toBe(before);
  }, 240000);
});
