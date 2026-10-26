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
    expect(read(dir, '.codex/hooks.json')).toBe(text);
    expect(exists(dir, '.codex/hooks/quality-gate.cjs')).toBe(false);
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
    expect(read(dir, '.codex/hooks.json')).toBe(codexText);
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
    // platform's layout: its gate and review-budget under scripts/, no distributed copies, its own Codex registrations.
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
    expect(read(dir, '.codex/hooks.json')).toBe(codex);
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
    expect(moved).toBe('| a | `.codex/skills/qc/SKILL.md` |\n| b | `.claude/skills/superpowers/tdd/SKILL.md` |\nLocated under `.codex/skills/`.\n');
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

  test('a pending block conflict recorded by 3.7.0 is carried and refuses --resolve and --verify after its file is written in another reading', () => {
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
    expect(read(dir, 'CLAUDE.md')).toContain('PRODUCT HARNESS LINE: node scripts/review-budget.cjs status'); // written in this reading
    const pend = manifestOf(dir).pending.find((p) => p.block === 'harness');
    expect(pend).toEqual({ path: 'CLAUDE.md', block: 'harness', baseVersion: OLD_VERSION, conflict: legacy, conflictRaw: [legacy, sha(body())] }); // as it was, and as this run wrote it
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
      // Declared after the conflict, then upgrade again: the file is written back in the new reading.
      write(dir, '.ai-dev-helm.json', JSON.stringify({ ...manifestOf(dir), ...declaration }, null, 2));
      expect(upgrade(dir).exitCode).toBe(1);
      expect(body()).not.toBe(firstBody);
      const pend = manifestOf(dir).pending.find((p) => p.block === 'harness');
      expect(pend.conflictRaw).toEqual([sha(firstBody), sha(body())]);
      fs.rmSync(path.join(dir, 'CLAUDE.md.ai-dev-helm-new'), { force: true }); // dropped without merging
      expect(() => runUpgrade({ dir, resolve: ['CLAUDE.md#harness'] })).toThrow(/unchanged since the conflict/);
      const m = manifestOf(dir);
      write(dir, '.ai-dev-helm.json', JSON.stringify({ ...m, pending: undefined, resolved: [{ path: 'CLAUDE.md', block: 'harness', version: m.version, conflict: pend.conflict, conflictRaw: pend.conflictRaw }] }, null, 2));
      expect(verifyMissing(dir)).toMatch(/CLAUDE\.md#harness resolved by hand, but the block is empty or the same as when it conflicted/);
      // Back to its first form (git checkout), which this reading no longer gives: still refused.
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

  // Cycle 5 (C4-H1): the run after the declaration changed stops between writing CLAUDE.md and recording the manifest
  // (a failed write, Ctrl+C). The form it writes was recorded before any file changed, so it is still refused.
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
    // Stopped: a manifest write after CLAUDE.md was written throws.
    const realWrite = fs.writeFileSync;
    let wroteRules = false;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      const name = path.basename(String(file));
      if (name === '.ai-dev-helm.json' && wroteRules) throw new Error('stopped before the manifest was recorded');
      if (name === 'CLAUDE.md') wroteRules = true;
      return realWrite.call(fs, file, ...rest);
    });
    try {
      expect(() => upgrade(dir)).toThrow(/stopped before the manifest was recorded/);
    } finally {
      spy.mockRestore();
    }
    expect(wroteRules).toBe(true);
    expect(body()).not.toBe(firstBody); // written in the new reading
    const after = manifestOf(dir);
    expect(after.pending.find((p) => p.block === 'harness').conflictRaw).toEqual([sha(firstBody), sha(body())]);
    expect({ ...after, pending: after.pending.map(({ conflictRaw, ...p }) => p) }).toEqual({ ...before, pending: before.pending.map(({ conflictRaw, ...p }) => p) }); // nothing else changed
    // The next run completes; the .new is then dropped without merging.
    expect(upgrade(dir).exitCode).toBe(1);
    const pend = manifestOf(dir).pending.find((p) => p.block === 'harness');
    expect(pend.conflictRaw).toEqual([sha(firstBody), sha(body())]);
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
    write(dir, 'AGENTS.md', `${read(dir, 'AGENTS.md').replace(/\r?\n/g, '\r\n')}\r\n${own.join('\r\n')}`);
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
    expect(tail).toBe(own.join('\r\n').replace('node .claude/hooks/review-budget.cjs status', 'node scripts/review-budget.cjs status'));
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
    // A real, tracked skills directory (platform's .codex/skills) whose ignore line was never added.
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
