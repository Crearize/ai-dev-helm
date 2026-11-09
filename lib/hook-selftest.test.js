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

// 3.7.2 (rule 1 of the design "git location"; C8-P1 of the quality-check): hook-selftest runs from a product that may
// get a GIT_DIR (a git hook does). Its scratch repository and the hooks it runs there get no git location variables:
// the product's repository was re-initialised as bare before.
test('a GIT_DIR in the environment does not reach the scratch repository or the hooks', () => {
  install();
  const { spawnSync } = require('child_process');
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(dir, '.git');
  let result;
  try { result = runHookSelftest({ dir }); } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
  expect(spawnSync('git', ['config', 'core.bare'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe('false');
  expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  // Rule 3: hook-selftest writes nothing in the product, so a GIT_DIR alone is told, not refused.
  expect(result.lines[0]).toMatch(/^WARNING: GIT_DIR \/ GIT_WORK_TREE: only one of them is set/);
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

  test('a fresh install passes, and the output names each install check that passed (3.7.1 D6)', () => {
    initHere();
    const passed = [];
    expect(checkInstall(dir, passed)).toEqual([]);
    const result = runHookSelftest({ dir });
    expect(result.exitCode).toBe(0);
    const out = result.lines.join('\n');
    expect(out).toMatch(/^ok install: \.claude\/settings\.json PreToolUse runs quality-gate\.cjs once \(its matcher reaches Bash and PowerShell/m);
    expect(out).toMatch(/^ok install: \.codex\/hooks\.json PreToolUse runs \.codex\/hooks\/quality-gate\.cjs, which exists$/m);
    expect(out).toMatch(/^ok install: \.claude\/hooks\/review-budget\.cjs equals .+'s copy$/m);
    expect(passed.every((l) => out.includes(l))).toBe(true);
    expect(result.lines[result.lines.length - 1]).toBe('hook-selftest: all cases passed');
  }, 60000);

  test('a duplicated or missing registration fails', () => {
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
    fs.writeFileSync(path.join(dir, 'b', 'skills', 'x', 'SKILL.md'), 'one\n');
    const passed = [];
    checkInstall(dir, passed);
    expect(passed).toContain('ok install: skill copies of "project" are the same in a/skills and b/skills');
  });

  test('Codex context-handoff (3.7.1): registered once on each of its three events, running a file that exists', () => {
    initHere();
    const codexFile = path.join(dir, '.codex', 'hooks.json');
    const codex = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
    expect(fs.existsSync(path.join(dir, '.codex', 'hooks', 'context-handoff.cjs'))).toBe(true);
    delete codex.hooks.PreCompact;
    codex.hooks.Stop.push(codex.hooks.Stop[0]);
    fs.writeFileSync(codexFile, JSON.stringify(codex));
    fs.rmSync(path.join(dir, '.codex', 'hooks', 'context-handoff.cjs'));
    const failures = checkInstall(dir).join('\n');
    expect(failures).toMatch(/\.codex\/hooks\.json PreCompact runs context-handoff\.cjs 0 time\(s\), expected 1/);
    expect(failures).toMatch(/\.codex\/hooks\.json Stop runs context-handoff\.cjs 2 time\(s\), expected 1/);
    expect(failures).toMatch(/runs \.codex\/hooks\/context-handoff\.cjs, which does not exist/);
    expect(failures).not.toMatch(/SessionStart runs context-handoff/);
  });

  test('3.7.2 (G2): the Codex gate registration of 3.3.0-3.7.1 (fail-open) fails; the 3.7.2 one passes and says so', () => {
    initHere();
    const { hookCommand, failOpenCodexGates } = require('./runtime-hooks');
    const passed = [];
    expect(checkInstall(dir, passed)).toEqual([]);
    expect(passed).toContain('ok install: .codex/hooks.json PreToolUse quality-gate.cjs registration stops the command when the gate cannot run');
    const codexFile = path.join(dir, '.codex', 'hooks.json');
    const codex = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
    const [old] = [...failOpenCodexGates({}).keys()];
    const entry = codex.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command === hookCommand('codex', 'quality-gate.cjs')));
    entry.hooks[0].command = old;
    fs.writeFileSync(codexFile, JSON.stringify(codex));
    expect(checkInstall(dir).join('\n')).toMatch(/\.codex\/hooks\.json PreToolUse runs quality-gate\.cjs through the 3\.3\.0-3\.7\.1 wrapper, which lets the command through when the gate cannot run; run npx @crearize\/ai-dev-helm upgrade, then trust the hook again in Codex/);
    // A product's own command is not judged.
    entry.hooks[0].command = 'node .codex/hooks/quality-gate.cjs';
    fs.writeFileSync(codexFile, JSON.stringify(codex));
    expect(checkInstall(dir)).toEqual([]);
  });
});
