'use strict';

// 3.7.0 (C3f, C3g, C3j): skillTargets copies are real directories on purpose; workflow / apps / settings from the
// manifest (or init --config) become the protected-branch denials, the Codex safety rules, the Cursor globs and the
// plugin switches.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const workflow = require('./workflow');
const { skippedLinkIgnores, isDeclaredTarget, targetsOf } = require('./skill-targets');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
let workspace;

beforeAll(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-workflow-')); });
afterAll(() => { fs.rmSync(workspace, { recursive: true, force: true }); }, 120000);

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const json = (dir, rel) => JSON.parse(read(dir, rel));

function init(name, args = [], before) {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (before) before(dir);
  const r = spawnSync(process.execPath, [CLI, 'init', '--project-name', 'Demo', '--tools', 'claude-code,codex,cursor', '--stacks', 'nextjs-react,java-springboot', '--skills', 'all', ...args], { cwd: dir, encoding: 'utf8', input: '' });
  return { dir, r };
}

describe('workflow keys (C3j, C3g)', () => {
  test('extra protected branches leave out main / master, duplicates and names that are not branches', () => {
    expect(workflow.extraBranches({ protectedBranches: ['main', 'release', 'release', 'master', '-f', 'a b', 'hotfix/x'] })).toEqual(['release', 'hotfix/x']);
    expect(workflow.extraBranches(undefined)).toEqual([]);
    expect(workflow.codexProtectedRules({ protectedBranches: ['main'] })).toBeNull();
  });

  test('app directories stay inside the product; anything else falls back to the default name', () => {
    expect(workflow.appDir({ frontend: './apps/web/' }, 'frontend')).toBe('apps/web');
    expect(workflow.appDir({ frontend: 'apps\\web' }, 'frontend')).toBe('apps/web');
    for (const bad of ['../x', '/abs', 'a//b', 'a/./b', 'C:/x', '']) expect(workflow.appDir({ backend: bad }, 'backend')).toBe('backend');
  });

  test('shape errors name the key', () => {
    expect(workflow.extrasErrors({ workflow: { remote: 'none', issues: 'none', protectedBranches: ['main', 'release'] }, apps: { frontend: 'web' }, settings: { mergeDeny: false, enabledPlugins: { 'a@b': false } } })).toEqual([]);
    const errors = workflow.extrasErrors({ workflow: { remote: 'github', protectedBranches: 'release' }, apps: { mobile: 'm', backend: '../api' }, settings: { enabledPlugins: { 'a@b': 'off' } } });
    expect(errors.join('\n')).toMatch(/workflow\.remote/);
    expect(errors.join('\n')).toMatch(/protectedBranches must be an array/);
    expect(errors.join('\n')).toMatch(/apps\.mobile is unknown/);
    // 3.7.1 (D6): apps may carry the reason for the declaration.
    expect(workflow.extrasErrors({ apps: { frontend: 'web', reason: 'the app lives under web/' } })).toEqual([]);
    expect(workflow.extrasErrors({ apps: { reason: 1 } })).toEqual(['apps.reason must be a string']);
    expect(workflow.appDir({ frontend: 'web', reason: 'x' }, 'backend')).toBe('backend');
    expect(errors.join('\n')).toMatch(/apps\.backend must be a relative directory/);
    expect(errors.join('\n')).toMatch(/enabledPlugins/);
    expect(workflow.extrasErrors({ workflow: [] })).toEqual(['workflow must be an object']);
  });

  test('the denials and plugin switches are added once and keep the product\'s own entries', () => {
    const file = path.join(workspace, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] }, enabledPlugins: { 'x@y': true } }));
    expect(workflow.addProtectedDenies(file, { protectedBranches: ['release'] })).toBe(true);
    expect(workflow.addProtectedDenies(file, { protectedBranches: ['release'] })).toBe(false);
    expect(workflow.applyEnabledPlugins(file, { enabledPlugins: { 'superpowers@claude-plugins-official': false } })).toBe(true);
    expect(workflow.applyEnabledPlugins(file, { enabledPlugins: { 'superpowers@claude-plugins-official': false } })).toBe(false);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Bash(rm -rf /)', 'Bash(git push --force origin release)', 'Bash(git push -f origin release)', 'Bash(git push --force-with-lease origin release)']));
    expect(settings.enabledPlugins).toEqual({ 'x@y': true, 'superpowers@claude-plugins-official': false });
  });

  // 3.7.1 (D2): the delete forms of a protected branch are denied too, in settings and in the Codex rules.
  test('the delete forms are denied', () => {
    expect(workflow.denyEntries(['release'])).toEqual(expect.arrayContaining([
      'Bash(git push origin :release)', 'Bash(git push origin --delete release)', 'Bash(git push --delete origin release)',
    ]));
    const rules = workflow.codexProtectedRules({ protectedBranches: ['release', 'hotfix/x'] });
    expect(rules).toContain('prefix_rule(pattern = ["git", "push", "origin", [":release", ":hotfix/x"]], decision = "forbidden"');
    expect(rules).toContain('prefix_rule(pattern = ["git", "push", "origin", "--delete", ["release", "hotfix/x"]], decision = "forbidden"');
    expect(rules).toContain('prefix_rule(pattern = ["git", "push", "--delete", "origin", ["release", "hotfix/x"]], decision = "forbidden"');
  });
});

describe('init --config (C3j, C3g)', () => {
  const config = { workflow: { protectedBranches: ['main', 'release'] }, apps: { frontend: 'apps/web', backend: 'api' }, settings: { enabledPlugins: { 'superpowers@claude-plugins-official': false } } };

  test('writes the denials, the Codex rules, the app globs and the plugins, and records the keys', () => {
    const file = path.join(workspace, 'init-config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    const { dir, r } = init('with-config', ['--config', file]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const settings = json(dir, '.claude/settings.json');
    expect(settings.permissions.deny).toContain('Bash(git push --force origin release)');
    expect(settings.permissions.deny).toContain('Bash(git push --force origin main)');
    expect(settings.enabledPlugins['superpowers@claude-plugins-official']).toBe(false);
    expect(read(dir, `.codex/rules/${workflow.CODEX_RULES_FILE}`)).toMatch(/"release", "HEAD:release"/);
    const mdc = fs.readdirSync(path.join(dir, '.cursor', 'rules')).filter((f) => f.endsWith('.mdc'));
    const front = mdc.find((f) => f.startsWith('frontend-'));
    const back = mdc.find((f) => f.startsWith('backend-'));
    expect(read(dir, `.cursor/rules/${front}`)).toContain('"apps/web/**/*.tsx"');
    expect(read(dir, `.cursor/rules/${back}`)).toContain('"api/**/*.java"');
    const manifest = json(dir, '.ai-dev-helm.json');
    expect(manifest.workflow).toEqual(config.workflow);
    expect(manifest.apps).toEqual(config.apps);
    expect(manifest.settings.enabledPlugins).toEqual(config.settings.enabledPlugins);

    // A re-run with --force (no --config) keeps rendering with the recorded keys.
    fs.rmSync(path.join(dir, '.codex', 'rules', workflow.CODEX_RULES_FILE));
    const again = spawnSync(process.execPath, [CLI, 'init', '--force', '--project-name', 'Demo', '--tools', 'claude-code,codex,cursor', '--stacks', 'nextjs-react,java-springboot', '--skills', 'all'], { cwd: dir, encoding: 'utf8', input: '' });
    expect(again.status, again.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, '.codex', 'rules', workflow.CODEX_RULES_FILE))).toBe(true);
    expect(read(dir, `.cursor/rules/${front}`)).toContain('"apps/web/**/*.tsx"');
  }, 240000);

  test('without the keys the defaults stay (frontend/, backend/, no extra rules file)', () => {
    const { dir, r } = init('no-config');
    expect(r.status, r.stderr).toBe(0);
    const front = fs.readdirSync(path.join(dir, '.cursor', 'rules')).find((f) => f.startsWith('frontend-'));
    expect(read(dir, `.cursor/rules/${front}`)).toContain('"frontend/**/*.tsx"');
    expect(fs.existsSync(path.join(dir, '.codex', 'rules', workflow.CODEX_RULES_FILE))).toBe(false);
    expect(json(dir, '.ai-dev-helm.json').workflow).toBeUndefined();
  }, 240000);

  test('a broken --config stops init before anything is written', () => {
    const file = path.join(workspace, 'bad-config.json');
    fs.writeFileSync(file, JSON.stringify({ workflow: { protectedBranches: ['--force'] } }));
    const { dir, r } = init('bad-config', ['--config', file]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/protectedBranches\[0\]/);
    expect(fs.existsSync(path.join(dir, '.ai-dev-helm.json'))).toBe(false);
  }, 240000);
});

describe('skillTargets copies (C3f)', () => {
  test('targets come from the manifest; only link entries whose directory holds a target are skipped', () => {
    const manifest = { skillTargets: { project: ['.claude/skills/'], superpowers: ['.claude/skills/superpowers', '../out'] } };
    expect(targetsOf(manifest)).toEqual(['.claude/skills', '.claude/skills/superpowers']);
    expect(skippedLinkIgnores(manifest)).toEqual(['/.claude/skills']);
    expect(skippedLinkIgnores({})).toEqual([]);
  });

  test('init leaves a declared copy out of .gitignore and does not call it stale', () => {
    const { dir, r } = init('targets', [], (d) => {
      fs.writeFileSync(path.join(d, '.ai-dev-helm.json'), JSON.stringify({ skillTargets: { project: ['.claude/skills'] } }));
      fs.mkdirSync(path.join(d, '.claude', 'skills', 'quality-check'), { recursive: true });
      fs.writeFileSync(path.join(d, '.claude', 'skills', 'quality-check', 'SKILL.md'), '# copy\n');
    });
    // The manifest has no version, so init runs without --force.
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(isDeclaredTarget(dir, '.claude\\skills')).toBe(true);
    const ignore = read(dir, '.gitignore').split(/\r?\n/);
    expect(ignore).not.toContain('/.claude/skills');
    expect(ignore).toContain('/.codex/skills');
    expect(r.stdout).toMatch(/declared skillTargets copy/);
    expect(r.stdout).not.toMatch(/\.claude[\\/]skills is a real directory \(copied install\)/);
    const { inventoryHarness } = require('./harness-diagnostics');
    const report = inventoryHarness({ projectDir: dir });
    expect(report.warnings.join('\n')).not.toMatch(/\.claude\/skills is a real directory/);
  }, 240000);
});
