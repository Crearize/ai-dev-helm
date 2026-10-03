const fs = require('fs');
const os = require('os');
const path = require('path');
const { inventoryHarness } = require('./harness-diagnostics');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-diagnostics-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
function write(name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('same recorded version is not treated as proof of matching distribution', () => {
  write('project/.ai-dev-helm.json', JSON.stringify({ version: '3.0.1', secret: 'DO-NOT-OUTPUT' }));
  write('project/.claude/skills/quality-check/SKILL.md', 'local rule\n');
  write('baseline/package.json', JSON.stringify({ version: '3.0.1' }));
  write('baseline/skills/project/quality-check/SKILL.md', 'distributed rule\n');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project'), baselineDir: path.join(dir, 'baseline') });
  expect(result.baseline.relationship).toBe('recorded_version');
  expect(result.files.find(f => f.paths[0].endsWith('SKILL.md')).comparison.status).toBe('different');
  expect(JSON.stringify(result)).not.toContain('DO-NOT-OUTPUT');
  expect(result.observation).toBe('on_disk_inventory');
});

test('captures project-local instruction overrides without leaking their contents', () => {
  const names = ['AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/CLAUDE.local.md'];
  for (const name of names) write(`project/${name}`, 'PRIVATE-OVERRIDE: keep old delegation rule');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.files.flatMap(file => file.paths).sort()).toEqual([...names].sort());
  for (const file of result.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-OVERRIDE');
});

test('normalizes only UTF-8 BOM and line endings, distinguishes future baseline', () => {
  write('project/.ai-dev-helm.json', '{"version":"1.0.0"}');
  write('project/.codex/skills/project/quality-check/SKILL.md', '\uFEFFrule\r\n');
  write('baseline/package.json', '{"version":"2.0.0"}');
  write('baseline/skills/project/quality-check/SKILL.md', 'rule\n');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project'), baselineDir: path.join(dir, 'baseline') });
  expect(result.baseline.relationship).toBe('different_version');
  const file = result.files.find(f => f.paths[0].endsWith('SKILL.md'));
  expect(file.comparison.status).toBe('normalized_match');
  expect(file.sha256).not.toBe(file.comparison.sha256);
});

test('unavailable baseline and rendered templates are not classified as customizations', () => {
  write('project/CLAUDE.md', 'project instructions');
  write('baseline/package.json', '{"version":"3.0.1"}');
  write('baseline/templates/CLAUDE.md.template', '{{PROJECT_NAME}}');
  const without = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(without.files[0].comparison.status).toBe('baseline_unavailable');
  const withBaseline = inventoryHarness({ projectDir: path.join(dir, 'project'), baselineDir: path.join(dir, 'baseline') });
  expect(withBaseline.files[0].comparison.status).toBe('rendered_template');
});

test('follows installed directory links, deduplicates physical files, skips link cycles', () => {
  write('project/.claude/skills/project/quality-check/SKILL.md', 'rule');
  const target = path.join(dir, 'project/.claude/skills');
  fs.mkdirSync(path.join(dir, 'project/.cursor'), { recursive: true });
  fs.symlinkSync(target, path.join(dir, 'project/.cursor/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(target, path.join(target, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.files).toHaveLength(1);
  expect(result.files[0].paths).toHaveLength(2);
  expect(result.warnings.some(w => w.includes('cycle'))).toBe(true);
});

test('does not scan product source, credentials or session logs', () => {
  write('project/.env', 'SECRET');
  write('project/src/index.js', 'product');
  write('project/.claude/logs/session.json', 'private');
  write('project/.claude/settings.json', '{"secret":"DO-NOT-OUTPUT"}');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.files.map(f => f.paths[0])).toEqual(['.claude/settings.json']);
  expect(JSON.stringify(result)).not.toContain('DO-NOT-OUTPUT');
  expect(result.runtime_metrics).toBeNull();
});

test('invalid UTF-8 bytes never compare equal through replacement characters', () => {
  write('project/.claude/skills/project/quality-check/image.bin', Buffer.from([0xff]));
  write('baseline/skills/project/quality-check/image.bin', Buffer.from([0xfe]));
  const result = inventoryHarness({ projectDir: path.join(dir, 'project'), baselineDir: path.join(dir, 'baseline') });
  expect(result.files[0].normalized_sha256).toBeNull();
  expect(result.files[0].comparison.status).toBe('different');
  expect(fs.readFileSync(path.join(dir, 'project/.claude/skills/project/quality-check/image.bin'))).toEqual(Buffer.from([0xff]));
});

test('includes runtime registration and instruction directories without emitting content', () => {
  for (const file of ['.codex/hooks.json', '.claude/agents/reviewer.md', '.cursor/commands/check.md', '.codex/prompts/check.md', '.cursor/rules/project.mdc']) {
    write(`project/${file}`, 'PRIVATE-CONTROL-CONTENT');
  }
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.files).toHaveLength(5);
  expect(result.files.some(f => f.paths.includes('.codex/hooks.json'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-CONTROL-CONTENT');
});

test('inventories distributor source only when its package identity matches', () => {
  for (const project of ['distributor', 'product']) {
    write(`${project}/package.json`, JSON.stringify({ name: project === 'distributor' ? '@crearize/ai-dev-helm' : 'my-product', version: '3.0.1' }));
    write(`${project}/skills/project/quality-check/SKILL.md`, 'rule');
    write(`${project}/skills/superpowers/writing-plans/SKILL.md`, 'plan');
    write(`${project}/templates/hooks/quality-gate.cjs`, 'hook');
  }
  const baselineDir = path.join(dir, 'distributor');
  const source = inventoryHarness({ projectDir: baselineDir, baselineDir });
  expect(source.files).toHaveLength(3);
  expect(source.files.every(f => f.comparison.status === 'exact_match')).toBe(true);
  expect(inventoryHarness({ projectDir: path.join(dir, 'product') }).files).toEqual([]);
});

test('warns when a runtime has no skills link and still inventories skills/ (H-30)', () => {
  write('project/skills/project/quality-check/SKILL.md', 'rule');
  fs.mkdirSync(path.join(dir, 'project/.claude'), { recursive: true });
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.skill_links).toEqual([{ runtime: '.claude', status: 'missing' }]);
  expect(result.warnings.some(w => w.includes('.claude/skills is missing') && w.includes('link-skills'))).toBe(true);
  expect(result.files.map(f => f.paths[0])).toContain('skills/project/quality-check/SKILL.md');
});

test('no skills warning when the link exists', () => {
  write('project/skills/project/x/SKILL.md', 'rule');
  fs.mkdirSync(path.join(dir, 'project/.claude'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'project/skills'), path.join(dir, 'project/.claude/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.skill_links).toEqual([{ runtime: '.claude', status: 'link' }]);
  expect(result.warnings).toEqual([]);
});

test('reports the CLI version and compares codex agents, rules and every shared document (H-31, H-32)', () => {
  write('project/.codex/agents/helm-reviewer.toml', 'a');
  write('project/.codex/rules/ai-dev-helm-safety.rules', 'r');
  write('project/documents/development/extra-policy.md', 'doc');
  write('baseline/package.json', '{"version":"3.3.0"}');
  write('baseline/templates/codex-agents/helm-reviewer.toml', 'a');
  write('baseline/templates/codex-rules/ai-dev-helm-safety.rules.template', 'r');
  write('baseline/shared/documents/extra-policy.md', 'doc');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project'), baselineDir: path.join(dir, 'baseline') });
  expect(result.cli_version).toBe(require('../package.json').version);
  const byPath = Object.fromEntries(result.files.map(f => [f.paths[0], f.comparison.status]));
  expect(byPath['.codex/agents/helm-reviewer.toml']).toBe('exact_match');
  expect(byPath['.codex/rules/ai-dev-helm-safety.rules']).toBe('exact_match');
  expect(byPath['documents/development/extra-policy.md']).toBe('exact_match');
});

test('warns when a runtime skills location is a real directory (stale copy) and suggests link-skills', () => {
  write('project/skills/project/x/SKILL.md', 'rule');
  write('project/.claude/skills/project/x/SKILL.md', 'old');
  const result = inventoryHarness({ projectDir: path.join(dir, 'project') });
  expect(result.skill_links).toEqual([{ runtime: '.claude', status: 'directory' }]);
  expect(result.warnings.some(w => w.includes('.claude/skills is a real directory') && w.includes('link-skills'))).toBe(true);
});
