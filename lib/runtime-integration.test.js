const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const toml = require('@iarna/toml');
const cli = path.resolve(__dirname, '../bin/cli.js');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-runtime-integration-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function init() {
  const result = spawnSync(process.execPath, [cli, 'init'], { cwd: dir, input: 'Runtime test\n1 3\n1\n\n', encoding: 'utf8', timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
}

test('real init wires model roles, reviewer hooks and instructions while preserving custom text on re-init', () => {
  // Break: adding helpers without calling them from init leaves installs unprotected.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\nCustom instruction stays.\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# My Claude project\nCustom Claude instruction stays.\n');
  init();
  const config = toml.parse(fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8'));
  expect(config.agents.default_subagent_model).toBe('gpt-5.6-terra');
  expect(toml.parse(fs.readFileSync(path.join(dir, '.codex/agents/helm-explorer.toml'), 'utf8')).model).toBe('gpt-5.6-luna');
  for (const tool of ['codex', 'claude']) {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, `.${tool}/${tool === 'codex' ? 'hooks.json' : 'settings.json'}`), 'utf8'));
    expect(settings.hooks.PreToolUse.filter((entry) => new RegExp(entry.matcher).test('Agent'))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, `.${tool}/hooks/review-budget.cjs`))).toBe(true);
  }
  init();
  expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('Custom instruction stays.');
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain('Custom Claude instruction stays.');
  // Managed entrypoint must exist even when init was given a preexisting user file.
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    expect(content.match(/<!-- ai-dev-helm:runtime:start -->/g)).toHaveLength(1);
  }
});

test('installed review-budget CLI shares state with the package CLI', () => {
  init();
  execFileSync('git', ['init', '-b', 'feature'], { cwd: dir, stdio: 'ignore' });
  const reserve = spawnSync(process.execPath, [cli, 'review-budget', 'begin', '--phase', 'quality', '--roles', 'integrated-reviewer', '--limit', '1'], { cwd: dir, encoding: 'utf8' });
  expect(reserve.status, reserve.stderr).toBe(0);
  const denied = spawnSync(process.execPath, [path.join(dir, '.claude/hooks/review-budget.cjs'), 'begin', '--phase', 'quality', '--roles', 'verification-reviewer'], { cwd: dir, encoding: 'utf8' });
  expect(denied.status).toBe(1);
  expect(denied.stderr).toMatch(/limit/);
});
