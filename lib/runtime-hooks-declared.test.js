'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { setupRuntimeHooks, calledHook, declaredHooks, declaredCommand, hookCommand } = require('./runtime-hooks');
const { runHookSelftest, checkInstall } = require('./hook-selftest');

// 3.7.0 (C3h): gate.script / reviewBudgetScript - a product's own gate and review-budget (platform) are registered
// in the distributed wrapper form with the declared path, the distributed bodies are not copied, registrations that
// run the declared files are the managed ones, and hook-selftest runs the decision table against them.

const HOOKS = path.join(__dirname, '..', 'templates', 'hooks');
let project;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-declared-hooks-'));
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: project, stdio: 'ignore' });
});
afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

const file = (rel) => path.join(project, ...rel.split('/'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), text); };
const readJson = (rel) => JSON.parse(fs.readFileSync(file(rel), 'utf8'));
const DECLARED = { gate: { script: 'scripts/gate.cjs' }, reviewBudgetScript: 'scripts/review-budget.cjs' };
const declared = declaredHooks(DECLARED).declared;
const runs = (json, event, name) => (json.hooks[event] || []).flatMap((e) => e.hooks).filter((h) => (calledHook(h.command, declared) || {}).file === name);

// platform's hand-written registrations (its .claude/settings.json before 3.7.0): the distributed wrapper's search
// with the product's path, a 'pretool' argument and its own notice.
const PLATFORM_GATE = "node -e \"const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');const find=(r)=>{const s=p.join(r,'scripts','gate.cjs');return fs.existsSync(s)?s:''};let s=process.env.CLAUDE_PROJECT_DIR?find(process.env.CLAUDE_PROJECT_DIR):'';if(s){const child=spawnSync(process.execPath,[s,'pretool'],{stdio:'inherit'});process.exit(child.status??2)}process.stdout.write('{}')\"";
const PLATFORM_CODEX_GATE = "node -e \"const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,'scripts','gate.cjs'),'pretool'],{stdio:'inherit'});process.exit(child.status??2)\"";

describe('declaredHooks and calledHook', () => {
  test('reads gate.script and reviewBudgetScript, and refuses unsafe values', () => {
    expect(declaredHooks({ gate: { script: './scripts/x.mjs' }, reviewBudgetScript: 'scripts/rb.cjs' })).toEqual({ declared: { 'quality-gate.cjs': 'scripts/x.mjs', 'review-budget.cjs': 'scripts/rb.cjs' }, errors: [] });
    expect(declaredHooks({ version: '3.7.0' })).toEqual({ declared: {}, errors: [] });
    for (const bad of [{ gate: 'x' }, { gate: { script: '../x.cjs' } }, { gate: { script: 'scripts/x.sh' } }, { reviewBudgetScript: "scripts/it's.cjs" }, { reviewBudgetScript: 'C:/x.cjs' }, { gate: { script: '' } }]) {
      expect(declaredHooks(bad).errors.length, JSON.stringify(bad)).toBe(1);
    }
  });

  test('a registration that runs a declared file is that hook\'s; others stay unmanaged', () => {
    for (const command of [PLATFORM_GATE, PLATFORM_CODEX_GATE, declaredCommand('claude', 'quality-gate.cjs', 'scripts/gate.cjs'), 'node scripts/gate.cjs', 'node "$CLAUDE_PROJECT_DIR/scripts/gate.cjs"']) {
      expect(calledHook(command, declared), command).toEqual({ dir: 'declared', file: 'quality-gate.cjs', path: 'scripts/gate.cjs' });
      expect(calledHook(command), command).toBeNull(); // without the declaration it is a product's own hook
    }
    expect(calledHook('node scripts/other.cjs', declared)).toBeNull();
    expect(calledHook('node scripts/gate.cjs && echo x', declared)).toBeNull();
    expect(calledHook(hookCommand('claude', 'quality-gate.cjs'), declared)).toEqual({ dir: 'claude', file: 'quality-gate.cjs' });
  });
});

describe('setupRuntimeHooks with declared hooks', () => {
  const settings = () => ({ hooks: {
    PreToolUse: [
      { matcher: '^(Bash|PowerShell)$', hooks: [{ type: 'command', command: PLATFORM_GATE, timeout: 30, statusMessage: 'checking' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('claude', 'quality-gate.cjs'), timeout: 30 }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: 'node scripts/own.cjs', timeout: 5 }] },
    ],
  } });

  test('registers the declared files once (replacing hand-written and distributed ones) and copies no review-budget', () => {
    write('.ai-dev-helm.json', JSON.stringify(DECLARED));
    write('.claude/settings.json', JSON.stringify(settings()));
    const report = {};
    expect(setupRuntimeHooks(project, 'claude', { backup: false, report })).toEqual([]);
    const after = readJson('.claude/settings.json');
    const gate = runs(after, 'PreToolUse', 'quality-gate.cjs');
    expect(gate.map((h) => h.command)).toEqual([declaredCommand('claude', 'quality-gate.cjs', 'scripts/gate.cjs')]);
    expect(gate[0].statusMessage).toBe('checking');
    expect(runs(after, 'PreToolUse', 'review-budget.cjs').map((h) => h.command)).toEqual([declaredCommand('claude', 'review-budget.cjs', 'scripts/review-budget.cjs')]);
    expect(runs(after, 'PostToolUse', 'review-budget.cjs')).toHaveLength(1);
    expect(after.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === 'node scripts/own.cjs'))).toBe(true);
    expect(report.replaced).toEqual([PLATFORM_GATE]);
    expect(fs.existsSync(file('.claude/hooks/review-budget.cjs'))).toBe(false);
    expect(fs.existsSync(file('.claude/hooks/context-handoff.cjs'))).toBe(true);
    // A second run changes nothing.
    const text = fs.readFileSync(file('.claude/settings.json'), 'utf8');
    setupRuntimeHooks(project, 'claude', { backup: false });
    expect(fs.readFileSync(file('.claude/settings.json'), 'utf8')).toBe(text);
  });

  test('the declared wrapper runs the declared file, and says so when it is missing', () => {
    write('.ai-dev-helm.json', JSON.stringify(DECLARED));
    write('.claude/settings.json', JSON.stringify({ hooks: {} }));
    setupRuntimeHooks(project, 'claude', { backup: false });
    const command = runs(readJson('.claude/settings.json'), 'PreToolUse', 'quality-gate.cjs')[0].command;
    const source = /^node -e "([^"]*)"$/.exec(command)[1];
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: project, env: { ...process.env, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }) });
    const missing = run();
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout).systemMessage).toMatch(/scripts\/gate\.cjs \(gate\.script in \.ai-dev-helm\.json\) was not found/);
    write('scripts/gate.cjs', "process.stdout.write('ran-declared');process.exit(2)");
    const found = run();
    expect(found.stdout).toBe('ran-declared');
    expect(found.status).toBe(2);
  });

  test('Codex: a registration that runs the declared file is left as it is; none is added beside it', () => {
    write('.ai-dev-helm.json', JSON.stringify(DECLARED));
    const own = { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: PLATFORM_CODEX_GATE, timeout: 30 }] }] } };
    write('.codex/hooks.json', JSON.stringify(own));
    setupRuntimeHooks(project, 'codex', { backup: false, preserveCodex: true });
    const after = readJson('.codex/hooks.json');
    expect(after.hooks.PreToolUse[0]).toEqual(own.hooks.PreToolUse[0]);
    expect(runs(after, 'PreToolUse', 'quality-gate.cjs')).toHaveLength(1);
    // review-budget was not registered yet: added in the 3.3.0 form with the declared path.
    expect(runs(after, 'PreToolUse', 'review-budget.cjs').map((h) => h.command)).toEqual([declaredCommand('codex', 'review-budget.cjs', 'scripts/review-budget.cjs')]);
    expect(fs.existsSync(file('.codex/hooks/review-budget.cjs'))).toBe(false);
  });

  test('an unsafe declaration changes nothing and says ACTION REQUIRED', () => {
    write('.ai-dev-helm.json', JSON.stringify({ gate: { script: '../outside.cjs' } }));
    write('.claude/settings.json', JSON.stringify(settings()));
    const before = fs.readFileSync(file('.claude/settings.json'), 'utf8');
    expect(setupRuntimeHooks(project, 'claude', { backup: false }).join('\n')).toMatch(/ACTION REQUIRED: \.ai-dev-helm\.json: gate\.script "\.\.\/outside\.cjs"/);
    expect(fs.readFileSync(file('.claude/settings.json'), 'utf8')).toBe(before);
  });
});

describe('hook-selftest with declared hooks', () => {
  const installDeclared = () => {
    write('.ai-dev-helm.json', JSON.stringify(DECLARED));
    write('.claude/settings.json', JSON.stringify({ hooks: {} }));
    setupRuntimeHooks(project, 'claude', { backup: false });
    fs.mkdirSync(file('scripts'), { recursive: true });
    fs.copyFileSync(path.join(HOOKS, 'quality-gate.cjs'), file('scripts/gate.cjs'));
    fs.copyFileSync(path.join(HOOKS, 'review-budget.cjs'), file('scripts/review-budget.cjs'));
  };

  test('runs the decision table against the declared files and counts their registrations', () => {
    installDeclared();
    const result = runHookSelftest({ dir: project });
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result.lines.join('\n')).toMatch(/^scripts\/gate\.cjs: \d+\/\d+ cases passed$/m);
    expect(result.lines.join('\n')).toMatch(/^scripts\/review-budget\.cjs: \d+\/\d+ cases passed$/m);
    expect(result.exitCode).toBe(0);
    expect(checkInstall(project)).toEqual([]);
  }, 60000);

  // platform's gate: it judges what a push sends (main equal to origin/main sends nothing, so it allowed "push to
  // main"), and an unreadable payload is denied (fail-closed). Here: the distributed gate behind both of those.
  const contentGate = (gatePath) => `const { spawnSync, execFileSync } = require('child_process');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const deny = (why) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
  let payload;
  try { payload = JSON.parse(input); } catch { deny('unreadable payload'); return; }
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (command === 'git push origin main') {
    const ahead = execFileSync('git', ['rev-list', '--count', 'origin/main..main'], { cwd: payload.cwd, encoding: 'utf8' }).trim();
    if (ahead === '0') return;
  }
  const run = spawnSync(process.execPath, [${JSON.stringify(gatePath)}], { input, encoding: 'utf8' });
  process.stdout.write(run.stdout || '');
});
`;

  test('3.7.1 (D6): a declared gate that judges what is pushed and fails closed passes; fail-closed is not accepted from a distributed copy', () => {
    installDeclared();
    write('scripts/gate.cjs', contentGate(path.join(HOOKS, 'quality-gate.cjs')));
    const result = runHookSelftest({ dir: project });
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result.exitCode).toBe(0);
    // The same file as the distributed copy (not declared): the table asks for fail-open there.
    write('.ai-dev-helm.json', JSON.stringify({ reviewBudgetScript: DECLARED.reviewBudgetScript }));
    write('.claude/hooks/quality-gate.cjs', contentGate(path.join(HOOKS, 'quality-gate.cjs')));
    const copy = runHookSelftest({ dir: project });
    expect(copy.lines).toContain('FAIL .claude/quality-gate: unreadable payload fails open (expected allow, got deny)');
  }, 60000);

  test('a declared gate that passes everything, or one that is missing, fails', () => {
    installDeclared();
    write('scripts/gate.cjs', 'process.stdin.resume();process.stdin.on("end",()=>{});\n');
    const broken = runHookSelftest({ dir: project });
    expect(broken.exitCode).toBe(1);
    expect(broken.lines.some((l) => l.startsWith('FAIL scripts/gate.cjs'))).toBe(true);
    fs.rmSync(file('scripts/gate.cjs'));
    const missing = runHookSelftest({ dir: project });
    expect(missing.exitCode).toBe(1);
    expect(missing.lines).toContain('FAIL scripts/gate.cjs: declared in .ai-dev-helm.json (gate.script) but not found');
  }, 60000);
});
