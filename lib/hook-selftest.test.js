const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHookSelftest } = require('./hook-selftest');

const HOOKS = path.join(__dirname, '..', 'templates', 'hooks');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-selftest-proj-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function install(runtime = '.claude') {
  const target = path.join(dir, runtime, 'hooks');
  fs.mkdirSync(target, { recursive: true });
  for (const f of ['quality-gate.cjs', 'review-budget.cjs']) fs.copyFileSync(path.join(HOOKS, f), path.join(target, f));
  return target;
}

test('the table stays in sync with the distributed hooks (drift detector)', () => {
  install();
  const result = runHookSelftest({ dir });
  expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  expect(result.exitCode).toBe(0);
  expect(result.ran).toBeGreaterThanOrEqual(20);
}, 60000);

test('a deliberately broken hook fails the self-test', () => {
  const hooks = install();
  fs.writeFileSync(path.join(hooks, 'quality-gate.cjs'), 'process.stdin.resume();process.stdin.on("end",()=>{});\n');
  const result = runHookSelftest({ dir });
  expect(result.exitCode).toBe(1);
  expect(result.lines.some((l) => l.startsWith('FAIL .claude/quality-gate'))).toBe(true);
}, 60000);

test('nothing installed is an action-required failure, not a silent pass', () => {
  const result = runHookSelftest({ dir });
  expect(result.exitCode).toBe(1);
  expect(result.lines.join('\n')).toContain('ACTION REQUIRED');
});

describe('the install checks (3.7.0 C3e)', () => {
  const { checkInstall } = require('./hook-selftest');
  const { spawnSync } = require('child_process');
  const initHere = () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), 'init', '--yes', '--project-name', 'p', '--tools', 'claude-code,codex', '--skills', 'project', '--stacks', ''], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  const settingsFile = () => path.join(dir, '.claude', 'settings.json');

  test('a fresh install passes; a duplicated or missing registration fails', () => {
    initHere();
    expect(checkInstall(dir)).toEqual([]);
    const settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings.hooks.PreToolUse.push(settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => /quality-gate/.test(h.command))));
    settings.hooks.PostToolUse = [];
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
    const failures = checkInstall(dir).join('\n');
    expect(failures).toMatch(/PreToolUse runs quality-gate\.cjs 2 time\(s\)/);
    expect(failures).toMatch(/PostToolUse runs review-budget\.cjs 0 time\(s\)/);
  });

  test('a Codex registration running a missing file, an edited hook copy and differing skill copies fail', () => {
    initHere();
    fs.rmSync(path.join(dir, '.codex', 'hooks', 'review-budget.cjs'));
    fs.appendFileSync(path.join(dir, '.claude', 'hooks', 'quality-gate.cjs'), '\n// local patch\n');
    const manifestFile = path.join(dir, '.ai-dev-helm.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, skillTargets: { project: ['a/skills', 'b/skills'] } }));
    fs.mkdirSync(path.join(dir, 'a', 'skills', 'x'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b', 'skills', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'skills', 'x', 'SKILL.md'), 'one\n');
    fs.writeFileSync(path.join(dir, 'b', 'skills', 'x', 'SKILL.md'), 'two\n');
    const failures = checkInstall(dir).join('\n');
    expect(failures).toMatch(/runs \.codex\/hooks\/review-budget\.cjs, which does not exist/);
    expect(failures).toMatch(/\.claude\/hooks\/quality-gate\.cjs differs/);
    expect(failures).toMatch(/skill copies of "project" differ between a\/skills and b\/skills \(x\/SKILL\.md\)/);
  });
});
