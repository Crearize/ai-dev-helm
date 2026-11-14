'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { setupRuntimeHooks } = require('./runtime-hooks');

let project;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-runtime-hooks-'));
  execFileSync('git', ['init', '-b', 'feature'], { cwd: project, stdio: 'ignore' });
  // These hook contracts need a branch and root, not a commit or user config.
  fs.mkdirSync(path.join(project, 'nested', 'deeper'), { recursive: true });
});
afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

function configPath(tool) {
  return path.join(project, `.${tool}`, tool === 'codex' ? 'hooks.json' : 'settings.json');
}

function oldGate(tool) {
  return `node .${tool}/hooks/quality-gate.cjs`;
}

function writeConfig(tool, config) {
  const file = configPath(tool);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function readConfig(tool) {
  return JSON.parse(fs.readFileSync(configPath(tool), 'utf8'));
}

function commandFor(config, event, script) {
  return config.hooks[event]
    .flatMap((entry) => entry.hooks)
    .find((hook) => hook.command.includes(script)).command;
}

describe('setupRuntimeHooks', () => {
  test.each(['codex', 'claude'])('installs root-resolving quality and review hooks without changing custom hooks (%s)', (tool) => {
    // Break: retaining relative shipped commands lets nested sessions skip the installed hooks.
    writeConfig(tool, {
      sentinel: { keep: true },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [
          { type: 'command', command: oldGate(tool), timeout: 30 },
          { type: 'command', command: 'node /custom/keep-me.cjs' },
        ] }],
      },
    });

    expect(setupRuntimeHooks(project, tool)).toEqual([]);
    const config = readConfig(tool);
    expect(config.sentinel).toEqual({ keep: true });
    expect(config.hooks.PreToolUse.flatMap((entry) => entry.hooks).some((hook) => hook.command === 'node /custom/keep-me.cjs')).toBe(true);
    expect(fs.existsSync(path.join(project, `.${tool}`, 'hooks', 'review-budget.cjs'))).toBe(true);
    expect(commandFor(config, 'PreToolUse', 'quality-gate.cjs')).toContain('git');
    expect(commandFor(config, 'PreToolUse', 'review-budget.cjs')).toContain('review-budget.cjs');
    expect(commandFor(config, 'PostToolUse', 'review-budget.cjs')).toContain('review-budget.cjs');
    expect(config.hooks.PreToolUse.some((entry) => entry.matcher === (tool === 'claude' ? '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent|SendMessage)$' : '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent)$'))).toBe(true);
  });

  // 3.7.2 (U2): init's ignore warning reads `setUp`. The registration file counts whether this run rewrote it or it
  // already held the registrations (a re-run), and so do the hook bodies copied; nothing is recorded on a dry run.
  test.each(['codex', 'claude'])('records the registration file and the hook bodies in setUp, on a re-run too (%s)', (tool) => {
    writeConfig(tool, { hooks: {} });
    const hooks = path.join(project, `.${tool}`, 'hooks');
    const expected = [configPath(tool), path.join(hooks, 'review-budget.cjs'), path.join(hooks, 'context-handoff.cjs')].sort();
    const first = [];
    expect(setupRuntimeHooks(project, tool, { setUp: first })).toEqual([]);
    expect([...first].sort()).toEqual(expected);
    const before = fs.readFileSync(configPath(tool), 'utf8');
    const second = [];
    expect(setupRuntimeHooks(project, tool, { setUp: second })).toEqual([]);
    expect(fs.readFileSync(configPath(tool), 'utf8')).toBe(before); // nothing to change
    expect([...second].sort()).toEqual(expected);
    const dry = [];
    setupRuntimeHooks(project, tool, { setUp: dry, dryRun: true });
    expect(dry).toEqual([]);
  });

  test('runs installed quality gate and review admission from a nested cwd without executing a proposed push', () => {
    // Break: a wrapper that resolves from cwd fails open below the repository root.
    writeConfig('codex', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: oldGate('codex') }] }] } });
    fs.mkdirSync(path.join(project, '.codex', 'hooks'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../templates/hooks/quality-gate.cjs'), path.join(project, '.codex', 'hooks', 'quality-gate.cjs'));
    setupRuntimeHooks(project, 'codex');
    const config = readConfig('codex');
    const quality = commandFor(config, 'PreToolUse', 'quality-gate.cjs');
    const blockedPush = spawnSync(quality, {
      cwd: path.join(project, 'nested', 'deeper'), shell: true, encoding: 'utf8',
      input: JSON.stringify({ cwd: path.join(project, 'nested', 'deeper'), tool_input: { command: 'git push origin main' } }),
    });
    expect(JSON.parse(blockedPush.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: project }).status).toBe(1);

    const review = commandFor(config, 'PreToolUse', 'review-budget.cjs');
    const deniedReviewer = spawnSync(review, {
      cwd: path.join(project, 'nested', 'deeper'), shell: true, encoding: 'utf8',
      input: JSON.stringify({ cwd: project, tool_name: 'spawn_agent', tool_input: { task_name: 'reviewer', message: 'Review this change' } }),
    });
    expect(JSON.parse(deniedReviewer.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const worker = spawnSync(review, {
      cwd: path.join(project, 'nested', 'deeper'), shell: true, encoding: 'utf8',
      input: JSON.stringify({ cwd: project, tool_name: 'spawn_agent', tool_input: { task_name: 'implementer', message: 'Implement this change' } }),
    });
    expect(worker.stdout).toBe('');
  });

  test('is idempotent when the old initializer re-adds a quoted shipped gate', () => {
    // Break: duplicate wrappers run the same gate twice after a second init.
    writeConfig('claude', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: oldGate('claude') }, { type: 'command', command: 'node ".claude/hooks/quality-gate.cjs"' }] }] } });
    setupRuntimeHooks(project, 'claude');
    const first = readConfig('claude');
    first.hooks.PreToolUse[0].hooks.push({ type: 'command', command: oldGate('claude') });
    fs.writeFileSync(configPath('claude'), JSON.stringify(first, null, 2));
    setupRuntimeHooks(project, 'claude');
    const second = readConfig('claude');
    const all = second.hooks.PreToolUse.flatMap((entry) => entry.hooks);
    expect(all.filter((hook) => hook.command.includes('quality-gate.cjs'))).toHaveLength(1);
    expect(all.filter((hook) => hook.command.includes('review-budget.cjs'))).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(configPath('claude'))).filter((name) => name.startsWith('settings.json.backup.')).length).toBeGreaterThan(0);
  });

  test('leaves malformed JSON and dry runs untouched with an ACTION REQUIRED warning', () => {
    // Break: mutating an unreadable or dry-run configuration destroys user-owned settings.
    fs.mkdirSync(path.dirname(configPath('codex')), { recursive: true });
    fs.writeFileSync(configPath('codex'), '{ broken');
    const original = fs.readFileSync(configPath('codex'), 'utf8');
    expect(setupRuntimeHooks(project, 'codex')).toEqual([expect.stringContaining('ACTION REQUIRED')]);
    expect(fs.readFileSync(configPath('codex'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(project, '.codex', 'hooks', 'review-budget.cjs'))).toBe(false);

    writeConfig('claude', { sentinel: 'dry', hooks: { PreToolUse: [] } });
    const dryOriginal = fs.readFileSync(configPath('claude'), 'utf8');
    expect(setupRuntimeHooks(project, 'claude', { dryRun: true })).toEqual([]);
    expect(fs.readFileSync(configPath('claude'), 'utf8')).toBe(dryOriginal);
    expect(fs.existsSync(path.join(project, '.claude', 'hooks', 'review-budget.cjs'))).toBe(false);
  });

  test('leaves a malformed hook event configuration untouched', () => {
    // Break: treating an object as a hook-event array can discard user registrations.
    writeConfig('codex', { sentinel: 'invalid-event', hooks: { PreToolUse: { matcher: 'Bash' } } });
    const original = fs.readFileSync(configPath('codex'), 'utf8');
    expect(setupRuntimeHooks(project, 'codex')).toEqual([expect.stringContaining('ACTION REQUIRED')]);
    expect(fs.readFileSync(configPath('codex'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(project, '.codex', 'hooks', 'review-budget.cjs'))).toBe(false);
  });
});

// #139: the Claude Code wrapper reaches the hook body without depending on git, and
// lets a call through with a notice only when no hook file exists anywhere.
describe('Claude Code hook wrapper (#139)', () => {
  const { hookCommand } = require('./runtime-hooks');
  // What hookCommand returned in 3.3.0 (and still returns for Codex). Pinned as text: Codex trust hashes it.
  const legacy = (tool, file) => `node -e "const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,'.${tool}','hooks','${file}')],{stdio:'inherit'});process.exit(child.status??1)"`;
  const scratch = [];
  const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-wrapper-')); scratch.push(d); return d; };
  afterEach(() => { while (scratch.length) fs.rmSync(scratch.pop(), { recursive: true, force: true }); });

  function hook(root, body, file = 'probe.cjs') {
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', file), body);
  }
  // The test runner may itself run inside Claude Code, so CLAUDE_PROJECT_DIR is cleared unless given.
  function env(extra = {}, { path: searchPath } = {}) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDE_PROJECT_DIR' && (searchPath === undefined || key.toUpperCase() !== 'PATH')));
    return { ...base, ...(searchPath === undefined ? {} : { PATH: searchPath }), ...extra };
  }
  function run(command, { cwd, extraEnv, searchPath, input = '{}' }) {
    expect(command.startsWith('node -e "') && command.endsWith('"')).toBe(true);
    return spawnSync(process.execPath, ['-e', command.slice('node -e "'.length, -1)], { cwd, env: env(extraEnv, { path: searchPath }), input, encoding: 'utf8' });
  }

  test('runs the hook under CLAUDE_PROJECT_DIR before the git root', () => {
    // Break: resolving through git first runs another checkout's hook copy.
    const other = tempDir();
    hook(project, "process.stdout.write('git-root')");
    hook(other, "process.stdout.write('project-dir')");
    const command = hookCommand('claude', 'probe.cjs');
    expect(run(command, { cwd: path.join(project, 'nested'), extraEnv: { CLAUDE_PROJECT_DIR: other } }).stdout).toBe('project-dir');
    expect(run(command, { cwd: path.join(project, 'nested') }).stdout).toBe('git-root');
  });

  test('reaches the quality gate body when git is not on PATH, so its own fail-closed check answers', () => {
    // Break: the 3.3.0 wrapper exited 1 with no output (a silent allow) before reaching the hook.
    hook(project, fs.readFileSync(path.resolve(__dirname, '../templates/hooks/quality-gate.cjs')), 'quality-gate.cjs');
    const noGit = tempDir();
    const result = run(hookCommand('claude', 'quality-gate.cjs'), {
      cwd: project, searchPath: noGit, extraEnv: { CLAUDE_PROJECT_DIR: project },
      input: JSON.stringify({ cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
    });
    const out = JSON.parse(result.stdout);
    expect(out.decision === 'block' || out.hookSpecificOutput?.permissionDecision === 'deny').toBe(true);
  });

  test.each(['PreToolUse', 'PostToolUse'])('with no hook file anywhere, lets the %s call through with a notice', (event) => {
    // Break: exit 2 here would block every shell and Agent call with no way back; a silent exit hides the gap.
    for (const cwd of [tempDir(), project]) { // outside any repository, and a repository without .claude/hooks
      const result = run(hookCommand('claude', 'quality-gate.cjs'), { cwd, extraEnv: { CLAUDE_PROJECT_DIR: tempDir() }, input: JSON.stringify({ hook_event_name: event }) });
      expect(result.status).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.systemMessage).toMatch(/quality-gate\.cjs was not found.*not running/);
      expect(out.hookSpecificOutput).toEqual({ hookEventName: event, additionalContext: out.systemMessage });
    }
    const unreadable = run(hookCommand('claude', 'quality-gate.cjs'), { cwd: tempDir(), input: 'not json' });
    expect(unreadable.status).toBe(0);
    expect(JSON.parse(unreadable.stdout)).toEqual({ systemMessage: expect.stringContaining('not running') });
  });

  test('the notice gives a runnable reinstall command and says when git could not look, without git noise on stderr', () => {
    // Break: "ai-dev-helm init" is usually not on PATH; a git failure must not read as "the hook is missing".
    const inRepo = run(hookCommand('claude', 'quality-gate.cjs'), { cwd: project, extraEnv: { CLAUDE_PROJECT_DIR: tempDir() }, input: '{}' });
    expect(JSON.parse(inRepo.stdout).systemMessage).toMatch(/npx @crearize\/ai-dev-helm upgrade/);
    expect(JSON.parse(inRepo.stdout).systemMessage).not.toMatch(/git could not find/);
    const outside = run(hookCommand('claude', 'quality-gate.cjs'), { cwd: tempDir(), extraEnv: { CLAUDE_PROJECT_DIR: tempDir() }, input: '{}' });
    expect(outside.stderr).not.toMatch(/fatal/);
    const noGit = run(hookCommand('claude', 'quality-gate.cjs'), { cwd: project, searchPath: tempDir(), input: '{}' });
    expect(JSON.parse(noGit.stdout).systemMessage).toMatch(/git could not find the repository root/);
  });

  test('does not fall back to another repository\'s hook when CLAUDE_PROJECT_DIR has none (3.7.0)', () => {
    // Break: with the hook missing under CLAUDE_PROJECT_DIR, the git root of a sibling repository ran its copy.
    const other = tempDir();
    hook(project, "process.stdout.write('sibling-hook')");
    const command = hookCommand('claude', 'probe.cjs');
    const result = run(command, { cwd: path.join(project, 'nested'), extraEnv: { CLAUDE_PROJECT_DIR: other }, input: '{}' });
    expect(result.stdout).not.toContain('sibling-hook');
    expect(JSON.parse(result.stdout).systemMessage).toMatch(/is another repository than CLAUDE_PROJECT_DIR, so its hook is not run/);
    // The same repository as CLAUDE_PROJECT_DIR still reaches its hook through git: CLAUDE_PROJECT_DIR a
    // subdirectory without the hook (cycle 1 M: the string comparison called it "another repository").
    fs.mkdirSync(path.join(project, 'nested'), { recursive: true });
    const inside = run(command, { cwd: path.join(project, 'nested'), extraEnv: { CLAUDE_PROJECT_DIR: path.join(project, 'nested') }, input: '{}' });
    expect(inside.stdout).toBe('sibling-hook');
    expect(run(command, { cwd: project, extraEnv: { CLAUDE_PROJECT_DIR: path.join(project, 'nested') }, input: '{}' }).stdout).toBe('sibling-hook');
  });

  test('re-running init over the 3.5.0-3.6.0 context-handoff command leaves one per event (3.7.0 cycle 1)', () => {
    // Break: an edit of handoffCommand350 would stop removing the real registration, and every adopter would keep
    // the record twice (both registrations run).
    const { LEGACY_CLAUDE_COMMANDS, HANDOFF_EVENTS, handoffCommand } = require('./runtime-hooks');
    const sha = (x) => require('node:crypto').createHash('sha256').update(x).digest('hex');
    const legacy = LEGACY_CLAUDE_COMMANDS['context-handoff.cjs'][0];
    expect(sha(legacy)).toBe('b7a073b6e73b2d1ca50b3306eb6a3d91066521593389f0fe700135849b09af85');
    const hooks = {};
    for (const { event, matcher, timeout } of HANDOFF_EVENTS) hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: legacy, timeout }] }];
    writeConfig('claude', { hooks });
    setupRuntimeHooks(project, 'claude');
    const config = readConfig('claude');
    for (const { event } of HANDOFF_EVENTS) {
      expect(config.hooks[event].flatMap((entry) => entry.hooks).map((h) => h.command)).toEqual([handoffCommand()]);
    }
  });

  test('re-running init over the 3.4.1-3.6.0 Claude commands leaves one managed entry per event (3.7.0)', () => {
    // Break: changing the wrapper text without removing the old text runs the gate and review-budget twice.
    const { LEGACY_CLAUDE_COMMANDS } = require('./runtime-hooks');
    const sha = (x) => require('node:crypto').createHash('sha256').update(x).digest('hex');
    // Pinned: the strings 3.4.1-3.6.0 registered (a later edit of the legacy builders would miss real registrations).
    expect(sha(LEGACY_CLAUDE_COMMANDS['quality-gate.cjs'][1])).toBe('f18edbc8ea3095c2bb8c06b1bb33fb42b610829072931b9fe487d4f6bd09dc88');
    expect(sha(LEGACY_CLAUDE_COMMANDS['review-budget.cjs'][1])).toBe('f3524647989d01156cb4cac3679781908ad8b38b048b9eb98acf7fa2de804d7d');
    const reviewMatcher = '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent|SendMessage)$';
    writeConfig('claude', { hooks: {
      PreToolUse: [
        { matcher: '^(Bash|PowerShell)$', hooks: [{ type: 'command', command: LEGACY_CLAUDE_COMMANDS['quality-gate.cjs'][1], timeout: 30 }] },
        { matcher: reviewMatcher, hooks: [{ type: 'command', command: LEGACY_CLAUDE_COMMANDS['review-budget.cjs'][1], timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: reviewMatcher, hooks: [{ type: 'command', command: LEGACY_CLAUDE_COMMANDS['review-budget.cjs'][1], timeout: 30 }] }],
    } });
    setupRuntimeHooks(project, 'claude');
    const config = readConfig('claude');
    const commands = (event) => config.hooks[event].flatMap((entry) => entry.hooks).map((h) => h.command);
    expect(commands('PreToolUse')).toEqual([hookCommand('claude', 'quality-gate.cjs'), hookCommand('claude', 'review-budget.cjs')]);
    expect(commands('PostToolUse')).toEqual([hookCommand('claude', 'review-budget.cjs')]);
  });

  test('passes the hook stdin, stdout and exit code through, also when run by a shell', () => {
    // Break: a wrapper that swallows output or the exit code turns a block into an allow.
    hook(project, "let s='';process.stdin.on('data',(c)=>{s+=c}).on('end',()=>{process.stdout.write('got:'+s);process.stderr.write('why');process.exitCode=s.includes('block')?2:0})");
    const command = hookCommand('claude', 'probe.cjs');
    const shell = spawnSync(command, { cwd: path.join(project, 'nested', 'deeper'), shell: true, env: env(), input: '{"a":1}', encoding: 'utf8' });
    expect(shell.stdout).toBe('got:{"a":1}');
    expect(shell.status).toBe(0);
    const blocked = run(command, { cwd: project, input: 'block' });
    expect(blocked.stdout).toBe('got:block');
    expect(blocked.stderr).toBe('why');
    expect(blocked.status).toBe(2);
  });

  test.skipIf(process.platform === 'win32')('blocks (exit 2) when the hook is killed by a signal', () => {
    // Break: `status ?? 1` made a killed hook a non-blocking error.
    hook(project, "process.kill(process.pid,'SIGKILL')");
    expect(run(hookCommand('claude', 'probe.cjs'), { cwd: project }).status).toBe(2);
  });

  test('maps a missing exit status (signal) to 2 in the wrapper source', () => {
    // Windows reports a killed child with an exit code, so the signal path is pinned in the source too.
    const command = hookCommand('claude', 'probe.cjs');
    expect(command).toContain('process.exit(child.status??2)');
    // The source sits inside one pair of double quotes in a JSON setting run by a shell.
    expect(command.slice('node -e "'.length, -1)).not.toMatch(/["`$\\]/);
  });

  test('re-running init over the 3.3.0 Claude commands leaves one managed entry per event', () => {
    // Break: exact-match removal misses the old wrapper, so both the old and new hooks run.
    const reviewMatcher = '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent|SendMessage)$';
    writeConfig('claude', { hooks: {
      PreToolUse: [
        { matcher: '^(Bash|PowerShell)$', hooks: [{ type: 'command', command: legacy('claude', 'quality-gate.cjs'), timeout: 30 }] },
        { matcher: reviewMatcher, hooks: [{ type: 'command', command: legacy('claude', 'review-budget.cjs'), timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: reviewMatcher, hooks: [{ type: 'command', command: legacy('claude', 'review-budget.cjs'), timeout: 30 }] }],
    } });
    for (let n = 0; n < 2; n++) {
      setupRuntimeHooks(project, 'claude');
      const config = readConfig('claude');
      const commands = (event) => config.hooks[event].flatMap((entry) => entry.hooks).map((h) => h.command);
      expect(commands('PreToolUse')).toEqual([hookCommand('claude', 'quality-gate.cjs'), hookCommand('claude', 'review-budget.cjs')]);
      expect(commands('PostToolUse')).toEqual([hookCommand('claude', 'review-budget.cjs')]);
    }
  });

  test('keeps the Codex review-budget wrapper byte-identical to 3.3.0; the gate\'s is the 3.7.2 fail-closed one', () => {
    // Break: any change to the Codex command voids its /hooks trust in every installed project (3.7.2 changes the
    // gate's once, G2 - pinned by its hash in the matcher tests below).
    expect(hookCommand('codex', 'review-budget.cjs')).toBe(legacy('codex', 'review-budget.cjs'));
    expect(hookCommand('codex', 'quality-gate.cjs')).not.toBe(legacy('codex', 'quality-gate.cjs'));
    expect(hookCommand('claude', 'quality-gate.cjs')).not.toBe(legacy('claude', 'quality-gate.cjs'));
  });

  test('3.7.2 (G4): the hook gets 25 s from the wrapper\'s start, and one past it is stopped (exit 2)', () => {
    const command = hookCommand('claude', 'probe.cjs');
    expect(command).toContain('const t0=Date.now();');
    expect(command).toContain("{stdio:'inherit',env:{...process.env,AI_DEV_HELM_HOOK_DEADLINE:String(t0+23500)},timeout:Math.max(1000,25000-(Date.now()-t0))}");
    expect(command).toContain('if(child.error||child.signal){');
    // A released 3.7.0-3.7.1 text is still known (a re-run replaces it, without reporting a hand-edited one).
    const { LEGACY_CLAUDE_COMMANDS } = require('./runtime-hooks');
    expect(LEGACY_CLAUDE_COMMANDS['quality-gate.cjs'][2]).not.toContain('timeout:Math.max');
    expect(require('node:crypto').createHash('sha256').update(LEGACY_CLAUDE_COMMANDS['quality-gate.cjs'][2]).digest('hex'))
      .toBe('12f8b2b0dd4c9fdbd236992eaa119686385f5241b8f7793f4106f7e07b56d02c');
  });

  test('3.7.2 (G4): a hook that does not answer is ended by the wrapper, which exits 2 with a reason', () => {
    hook(project, 'setInterval(()=>{},1000)');
    const start = Date.now();
    // The deadline shortened to 1.5 s for the test (the text is the same but for that number).
    const result = run(hookCommand('claude', 'probe.cjs').replace('25000-(Date.now()-t0)', '1500-(Date.now()-t0)'), { cwd: project });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/probe\.cjs could not start, was killed or ran past 25 s, so this call is stopped/);
    expect(Date.now() - start).toBeLessThan(20000);
  });

  // C1-M7 of the quality check: one clock. The hook gets the wrapper's deadline less 1.5 s to answer, so the gate's
  // own verdict comes before the wrapper ends it (the gate keeps to the earlier of that and its own 20 s).
  test('3.7.2 (C1-M7): the hook gets the wrapper\'s deadline less 1.5 s as AI_DEV_HELM_HOOK_DEADLINE', () => {
    hook(project, 'process.stdout.write(String(process.env.AI_DEV_HELM_HOOK_DEADLINE))');
    const before = Date.now();
    const result = run(hookCommand('claude', 'probe.cjs'), { cwd: project, extraEnv: { AI_DEV_HELM_HOOK_DEADLINE: '99999999999999' } });
    const after = Date.now();
    expect(result.status).toBe(0);
    const deadline = Number(result.stdout);
    expect(deadline).toBeGreaterThanOrEqual(before + 23500);
    expect(deadline).toBeLessThanOrEqual(after + 23500);
  });
});

// P10': Claude Code's PowerShell tool runs shell commands too, so the gate is
// registered for both shell tools there. Codex trusts a hook by a hash of its
// registration, so the Codex registration must not change by a byte.
describe('quality-gate matcher (P10)', () => {
  const { hookCommand } = require('./runtime-hooks');
  const { codexHookHash } = require('./codex-trust');
  const gateEntry = (config) => config.hooks.PreToolUse.find((entry) => entry.hooks.some((hook) => hook.command.includes('quality-gate.cjs')));

  // 3.7.1 (D1): Monitor runs a shell command too.
  test('registers the Claude Code gate for Bash, PowerShell and Monitor only', () => {
    writeConfig('claude', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: oldGate('claude') }] }] } });
    setupRuntimeHooks(project, 'claude');
    const { matcher } = gateEntry(readConfig('claude'));
    expect(matcher).toBe('^(Bash|PowerShell|Monitor)$');
    expect(['Bash', 'PowerShell', 'Monitor'].every((tool) => new RegExp(matcher).test(tool))).toBe(true);
    expect(['Read', 'PowerShellX', 'Agent', 'MonitorX'].some((tool) => new RegExp(matcher).test(tool))).toBe(false);
    const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../templates/settings.json.template'), 'utf8'));
    expect(template.hooks.PreToolUse[0].matcher).toBe('^(Bash|PowerShell|Monitor)$');
  });

  test('a registration under the 3.7.0 matcher is the managed one: replaced once by the Monitor matcher', () => {
    writeConfig('claude', { hooks: { PreToolUse: [{ matcher: '^(Bash|PowerShell)$', hooks: [{ type: 'command', command: hookCommand('claude', 'quality-gate.cjs'), timeout: 30, statusMessage: 'checking' }] }] } });
    setupRuntimeHooks(project, 'claude');
    const entries = readConfig('claude').hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes('quality-gate.cjs')));
    expect(entries).toEqual([{ matcher: '^(Bash|PowerShell|Monitor)$', hooks: [{ type: 'command', command: hookCommand('claude', 'quality-gate.cjs'), timeout: 30, statusMessage: 'checking' }] }]);
  });

  test('keeps the Codex registration\'s matcher and timeout; its command is the 3.7.2 fail-closed wrapper, pinned by its hash', () => {
    writeConfig('codex', { hooks: { PreToolUse: [] } });
    setupRuntimeHooks(project, 'codex');
    const entry = gateEntry(readConfig('codex'));
    expect(entry).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('codex', 'quality-gate.cjs'), timeout: 30 }] });
    // The trusted_hash of 3.7.2's registration (3.2.1-3.7.1's was sha256:8d79fff5...; G2 changes it once).
    expect(codexHookHash('PreToolUse', entry.matcher, entry.hooks[0], { platform: 'linux' }))
      .toBe('sha256:41593bf78d21db8aae21e13f29bd33a7a4c0aec6c4b902b7426137a00a84be9a');
    const template = fs.readFileSync(path.resolve(__dirname, '../templates/codex-hooks.json.template'), 'utf8').replace(/\r\n/g, '\n');
    expect(template).toBe('{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "^Bash$",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "node .codex/hooks/quality-gate.cjs",\n            "timeout": 30\n          }\n        ]\n      }\n    ]\n  }\n}\n');
  });
});

// #207: context-handoff keeps a record across /compact and /clear. It is Claude Code only and never blocks.
describe('context-handoff registration (#207)', () => {
  const { handoffCommand, hookCommand, HANDOFF_EVENTS, CODEX_HANDOFF_EVENTS } = require('./runtime-hooks');
  // The trusted_hash Codex records for the 3.7.1 Codex registrations (computed the way codex-trust does).
  const CODEX_HANDOFF_HASHES = {
    PreCompact: 'sha256:55790911a753bbdb22ca2c81d62781595e5644e372182e109c67779d4ad5512d',
    SessionStart: 'sha256:1857ba94ddc2e118c988d4f8c8c411ca9e21a03267a80bcdba28e1cd52e86969',
    Stop: 'sha256:02d93b4d02f034e6d7ceec33965fe154984e9270754e2448302ffadd8ab8e558',
  };
  const entriesWith = (config, event) => (config.hooks[event] || []).filter((entry) => entry.hooks.some((hook) => hook.command === handoffCommand()));
  const scratch = [];
  afterEach(() => { while (scratch.length) fs.rmSync(scratch.pop(), { recursive: true, force: true }); });
  function runWrapper({ cwd, projectDir, input }) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDE_PROJECT_DIR'));
    return spawnSync(process.execPath, ['-e', handoffCommand().slice('node -e "'.length, -1)], {
      cwd, env: { ...env, ...(projectDir ? { CLAUDE_PROJECT_DIR: projectDir } : {}) }, input, encoding: 'utf8',
    });
  }

  test('registers PreCompact, SessionStart (compact|clear), SessionEnd (clear) and Stop once, keeping user hooks', () => {
    // Break: a second init would run the hook twice; dropping user hooks on these events loses their setup.
    writeConfig('claude', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /custom/stop.cjs' }] }] } });
    for (let n = 0; n < 2; n++) setupRuntimeHooks(project, 'claude');
    const config = readConfig('claude');
    expect(HANDOFF_EVENTS.map((item) => item.event)).toEqual(['PreCompact', 'SessionStart', 'SessionEnd', 'Stop']);
    expect(entriesWith(config, 'PreCompact')).toEqual([{ hooks: [{ type: 'command', command: handoffCommand(), timeout: 60 }] }]);
    expect(entriesWith(config, 'SessionStart')).toEqual([{ matcher: 'compact|clear', hooks: [{ type: 'command', command: handoffCommand(), timeout: 60 }] }]);
    expect(entriesWith(config, 'SessionEnd')).toEqual([{ matcher: 'clear', hooks: [{ type: 'command', command: handoffCommand(), timeout: 30 }] }]);
    expect(entriesWith(config, 'Stop')).toHaveLength(1);
    expect(config.hooks.Stop.flatMap((entry) => entry.hooks).some((hook) => hook.command === 'node /custom/stop.cjs')).toBe(true);
    expect(fs.readFileSync(path.join(project, '.claude', 'hooks', 'context-handoff.cjs'), 'utf8'))
      .toBe(fs.readFileSync(path.resolve(__dirname, '../templates/hooks/context-handoff.cjs'), 'utf8'));
  });

  test('Codex (3.7.1): PreCompact, SessionStart (compact|clear) and Stop at the end of each array, once, with the body copied', () => {
    // Break: a registration inserted before a product's own hook moves its trust key; a second run would add twice.
    const own = { hooks: [{ type: 'command', command: 'node /custom/stop.cjs' }] };
    writeConfig('codex', { hooks: { PreToolUse: [], Stop: [own] } });
    for (let n = 0; n < 2; n++) setupRuntimeHooks(project, 'codex');
    const config = readConfig('codex');
    const command = hookCommand('codex', 'context-handoff.cjs');
    expect(CODEX_HANDOFF_EVENTS.map((item) => item.event)).toEqual(['PreCompact', 'SessionStart', 'Stop']);
    expect(config.hooks.PreCompact).toEqual([{ hooks: [{ type: 'command', command, timeout: 60 }] }]);
    expect(config.hooks.SessionStart).toEqual([{ matcher: 'compact|clear', hooks: [{ type: 'command', command, timeout: 60 }] }]);
    expect(config.hooks.Stop).toEqual([own, { hooks: [{ type: 'command', command, timeout: 10 }] }]);
    expect(config.hooks.SessionEnd).toBeUndefined();
    expect(fs.readFileSync(path.join(project, '.codex', 'hooks', 'context-handoff.cjs'), 'utf8'))
      .toBe(fs.readFileSync(path.resolve(__dirname, '../templates/hooks/context-handoff.cjs'), 'utf8'));
  });

  test('Codex (3.7.1): the registration is the 3.3.0 git wrapper, pinned by the hashes Codex trusts', () => {
    // Break: any change to these registrations voids their /hooks trust in every installed project.
    const { codexHookHash } = require('./codex-trust');
    expect(hookCommand('codex', 'context-handoff.cjs')).toBe(`node -e "const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,'.codex','hooks','context-handoff.cjs')],{stdio:'inherit'});process.exit(child.status??1)"`);
    writeConfig('codex', { hooks: {} });
    setupRuntimeHooks(project, 'codex');
    const config = readConfig('codex');
    const hash = (event) => codexHookHash(event, config.hooks[event][0].matcher, config.hooks[event][0].hooks[0], { platform: 'linux' });
    expect({ PreCompact: hash('PreCompact'), SessionStart: hash('SessionStart'), Stop: hash('Stop') }).toEqual(CODEX_HANDOFF_HASHES);
  });

  test('Codex (3.7.1): an existing context-handoff registration is left as it is, and a malformed Stop stops the update', () => {
    const own = { matcher: 'compact', hooks: [{ type: 'command', command: 'node .codex/hooks/context-handoff.cjs', timeout: 5 }] };
    writeConfig('codex', { hooks: { SessionStart: [own] } });
    setupRuntimeHooks(project, 'codex', { preserveCodex: true });
    expect(readConfig('codex').hooks.SessionStart).toEqual([own]);
    expect(readConfig('codex').hooks.Stop).toHaveLength(1);
    // A conflicted body (upgrade's keep) keeps its registrations away.
    writeConfig('codex', { hooks: {} });
    setupRuntimeHooks(project, 'codex', { keep: new Set(['context-handoff.cjs']), copyScripts: false });
    expect(readConfig('codex').hooks.Stop).toBeUndefined();
    // Stop is now an event the harness registers on, so a malformed one leaves the file alone (as in Claude Code).
    writeConfig('codex', { hooks: { PreToolUse: [], Stop: { odd: true } } });
    const original = fs.readFileSync(configPath('codex'), 'utf8');
    expect(setupRuntimeHooks(project, 'codex')).toEqual([expect.stringContaining('ACTION REQUIRED')]);
    expect(fs.readFileSync(configPath('codex'), 'utf8')).toBe(original);
    // An event the harness does not use is not checked.
    writeConfig('codex', { hooks: { PreToolUse: [], SessionEnd: { odd: true } } });
    expect(setupRuntimeHooks(project, 'codex')).toEqual([]);
    expect(readConfig('codex').hooks.SessionEnd).toEqual({ odd: true });
  });

  test('Codex (3.7.1): the wrapper exits 1 without the body (Codex does not act on it) and passes the body through', () => {
    const command = hookCommand('codex', 'context-handoff.cjs');
    const runCodexWrapper = (input) => spawnSync(process.execPath, ['-e', command.slice('node -e "'.length, -1)], { cwd: path.join(project, 'nested'), input, encoding: 'utf8' });
    const missing = runCodexWrapper('{"hook_event_name":"Stop"}');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    fs.mkdirSync(path.join(project, '.codex', 'hooks'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../templates/hooks/context-handoff.cjs'), path.join(project, '.codex', 'hooks', 'context-handoff.cjs'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-handoff-codex-store-'));
    scratch.push(store);
    const ran = spawnSync(process.execPath, ['-e', command.slice('node -e "'.length, -1)], {
      cwd: path.join(project, 'nested'), encoding: 'utf8', env: { ...process.env, AI_DEV_HELM_HANDOFF_DIR: store },
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: null, cwd: path.join(project, 'nested') }),
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('');
  });

  test('leaves a malformed handoff event untouched', () => {
    writeConfig('claude', { hooks: { Stop: { hooks: [] } } });
    const original = fs.readFileSync(configPath('claude'), 'utf8');
    expect(setupRuntimeHooks(project, 'claude')).toEqual([expect.stringContaining('ACTION REQUIRED')]);
    expect(fs.readFileSync(configPath('claude'), 'utf8')).toBe(original);
  });

  test('the wrapper runs the installed hook and always exits 0, also when the hook fails or is missing', () => {
    // Break: exit 2 from PreCompact stops compaction, and from Stop keeps the turn going.
    const hooks = path.join(project, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'context-handoff.cjs'), "let s='';process.stdin.on('data',(c)=>{s+=c}).on('end',()=>{process.stdout.write('got:'+s);process.exitCode=2})");
    const ran = runWrapper({ cwd: path.join(project, 'nested'), input: '{"hook_event_name":"Stop"}' });
    expect(ran.stdout).toBe('got:{"hook_event_name":"Stop"}');
    expect(ran.status).toBe(0);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-handoff-missing-'));
    scratch.push(empty);
    const start = runWrapper({ cwd: empty, projectDir: empty, input: '{"hook_event_name":"SessionStart","source":"compact"}' });
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout).systemMessage).toMatch(/context-handoff\.cjs was not found.*npx @crearize\/ai-dev-helm upgrade/);
    for (const event of ['Stop', 'PreCompact', 'SessionEnd']) {
      const quiet = runWrapper({ cwd: empty, projectDir: empty, input: JSON.stringify({ hook_event_name: event }) });
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toBe('');
    }
    // The source sits inside one pair of double quotes in a JSON setting run by a shell.
    expect(handoffCommand().slice('node -e "'.length, -1)).not.toMatch(/["`$\\]/);
  });
});

describe('calledHook: the hook a registration runs (3.7.0 C3e, cycle 1)', () => {
  const { calledHook, matcherReaches, hookCommand, handoffCommand } = require('./runtime-hooks');
  test.each([
    [hookCommand('claude', 'quality-gate.cjs'), 'quality-gate.cjs'],
    [hookCommand('codex', 'review-budget.cjs'), 'review-budget.cjs'],
    [handoffCommand(), 'context-handoff.cjs'],
    ['node .claude/hooks/quality-gate.cjs', 'quality-gate.cjs'],
    ['node "$CLAUDE_PROJECT_DIR"/.claude/hooks/quality-gate.cjs', 'quality-gate.cjs'],
    ['node "$CLAUDE_PROJECT_DIR/.claude/hooks/review-budget.cjs"', 'review-budget.cjs'],
    ['"C:/Program Files/nodejs/node.exe" "C:/x y/.claude/hooks/context-handoff.cjs" --scope=global', 'context-handoff.cjs'],
    ['node --enable-source-maps .claude/hooks/quality-gate.cjs', 'quality-gate.cjs'],
    ['node .claude/hooks/quality-gate.cjs || exit 0', null],
    ['node .claude/hooks/review-budget.cjs && node scripts/product-edit-check.cjs', null],
    ['node .claude/hooks/quality-gate.cjs; true', null],
    ['echo node .claude/hooks/quality-gate.cjs', null],
    ['node .claude/hooks/quality-gate.cjs.bak', null],
    ['node scripts/gate.mjs', null],
  ])('%s -> %s', (command, file) => {
    expect((calledHook(command) || {}).file || null).toBe(file);
  });

  test('matcherReaches', () => {
    expect(matcherReaches('^(Bash|PowerShell)$', 'PowerShell')).toBe(true);
    expect(matcherReaches('NoSuchTool', 'Bash')).toBe(false);
    expect(matcherReaches(undefined, 'Bash')).toBe(true);
    expect(matcherReaches('*', 'Bash')).toBe(true);
  });
});

// 3.7.3 (#241, C1 / C2): a product's own fail-open Codex gate registration - the 3.3.0 wrapper running another gate
// file than the released forms - is named, never replaced. review-budget's registrations are not (44-5).
describe('a product\'s own fail-open Codex gate registration (3.7.3 C1)', () => {
  const runtime = require('./runtime-hooks');
  // The 3.3.0 wrapper text, written out (not built by the code under test); `joinArgs` names the path below the root.
  const wrapper330 = (joinArgs) => `node -e "const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,${joinArgs})],{stdio:'inherit'});process.exit(child.status??1)"`;
  const declared = { 'quality-gate.cjs': 'scripts/gate.cjs' };

  test.each([
    ['the 3.3.0 wrapper of .claude/hooks', wrapper330("'.claude','hooks','quality-gate.cjs'"), {}, '.claude/hooks/quality-gate.cjs'],
    ['the 3.3.0 wrapper of .claude/hooks, with a declared gate', wrapper330("'.claude','hooks','quality-gate.cjs'"), declared, '.claude/hooks/quality-gate.cjs'],
    ['the 3.3.0 wrapper of a path ending in the declared gate', wrapper330("'tools','scripts','gate.cjs'"), declared, 'tools/scripts/gate.cjs'],
    ['the released 3.3.0 wrapper of .codex/hooks (upgrade replaces it)', wrapper330("'.codex','hooks','quality-gate.cjs'"), {}, null],
    ['the released 3.7.0 wrapper of the declared gate (upgrade replaces it)', wrapper330("'scripts','gate.cjs'"), declared, null],
    ['the current gate registration', () => runtime.hookCommand('codex', 'quality-gate.cjs'), {}, null],
    ['the current declared gate registration', () => runtime.declaredCommand('codex', 'quality-gate.cjs', 'scripts/gate.cjs'), declared, null],
    ['review-budget of .claude/hooks (44-5: no gate, the released one fails open too)', wrapper330("'.claude','hooks','review-budget.cjs'"), {}, null],
    ['review-budget of .codex/hooks', wrapper330("'.codex','hooks','review-budget.cjs'"), {}, null],
    ['a declared review-budget', wrapper330("'scripts','rb.cjs'"), { 'review-budget.cjs': 'scripts/rb.cjs' }, null],
    ['an undeclared file', wrapper330("'scripts','gate.cjs'"), {}, null],
    ['a hand-written command', 'node .claude/hooks/quality-gate.cjs', {}, null],
    ['the 3.3.0 wrapper of .claude/hooks with exit 0 instead of 1', wrapper330("'.claude','hooks','quality-gate.cjs'").replace('??1', '??0'), {}, null],
  ])('%s', (_name, command, given, expected) => {
    expect(runtime.ownFailOpenCodexGate(typeof command === 'function' ? command() : command, given)).toBe(expected);
  });

  test('the fix is the fail-closed wrapper of the same file; registrations are listed with their position', () => {
    const own = wrapper330("'.claude','hooks','quality-gate.cjs'");
    const json = { hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command', command: 'node scripts/own.cjs' }] },
        { matcher: '^(Bash|shell)$', hooks: [{ type: 'command', command: 'node scripts/first.cjs' }, { type: 'command', command: own, timeout: 30 }] },
        { matcher: 'spawn_agent', hooks: [{ type: 'command', command: wrapper330("'.claude','hooks','review-budget.cjs'"), timeout: 30 }] },
      ],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: own }] }],
    } };
    const found = runtime.ownFailOpenCodexGates(json, {});
    expect(found).toEqual([{ at: 'PreToolUse[1].hooks[1]', path: '.claude/hooks/quality-gate.cjs', command: runtime.codexGateCommandAt('.claude/hooks/quality-gate.cjs') }]);
    expect(found[0].command).toBe(runtime.declaredCommand('codex', 'quality-gate.cjs', '.claude/hooks/quality-gate.cjs'));
    expect(found[0].command).toContain("p.join(r,'.claude','hooks','quality-gate.cjs')");
    expect(runtime.ownFailOpenCodexGates(null, {})).toEqual([]);
    expect(runtime.ownFailOpenCodexGates({ hooks: { PreToolUse: 'x' } }, {})).toEqual([]);
  });

  test('setupRuntimeHooks leaves such a registration as it is (upgrade and init)', () => {
    const own = { matcher: '^Bash$', hooks: [{ type: 'command', command: wrapper330("'.claude','hooks','quality-gate.cjs'"), timeout: 30 }] };
    writeConfig('codex', { hooks: { PreToolUse: [own] } });
    setupRuntimeHooks(project, 'codex', { preserveCodex: true, copyScripts: false });
    expect(readConfig('codex').hooks.PreToolUse[0]).toEqual(own);
    expect(readConfig('codex').hooks.PreToolUse.filter((e) => e.hooks.some((h) => (runtime.calledHook(h.command) || {}).file === 'quality-gate.cjs'))).toHaveLength(1);
  });

  // 44-1: Codex keys a hook's trust by its position (<event>:<group>:<handler>), so what upgrade adds goes to the end
  // of each event's array and every registration already there keeps its index.
  test('a gate registration upgrade adds goes to the end of PreToolUse; the ones there keep their positions', () => {
    const before = [
      { matcher: 'spawn_agent', hooks: [{ type: 'command', command: wrapper330("'.claude','hooks','review-budget.cjs'"), timeout: 30 }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: 'node scripts/own.cjs' }] },
    ];
    writeConfig('codex', { hooks: { PreToolUse: before } });
    setupRuntimeHooks(project, 'codex', { preserveCodex: true, copyScripts: false });
    const pre = readConfig('codex').hooks.PreToolUse;
    expect(pre.slice(0, 2)).toEqual(before);
    expect(pre).toHaveLength(3);
    expect(pre[2]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: runtime.hookCommand('codex', 'quality-gate.cjs'), timeout: 30 }] });
  });
});

// 3.7.2 (#234, G2 / G4): Codex's gate registration fails closed and gives the gate 25 s. It refuses the way the gate
// does - one block JSON on stdout and exit 0 - since Codex on Windows starts hooks through PowerShell, which turns
// exit 2 into 1, a failed hook Codex does not act on (C6-M3 of the quality check).
describe('Codex gate wrapper (3.7.2)', () => {
  const { hookCommand, declaredCommand, calledHook } = require('./runtime-hooks');
  const scratch = [];
  afterEach(() => { while (scratch.length) fs.rmSync(scratch.pop(), { recursive: true, force: true }); });
  const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-codex-gate-')); scratch.push(d); return d; };
  const gate = (body, rel = '.codex/hooks/quality-gate.cjs') => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), body);
  };
  const run = (command, { cwd = path.join(project, 'nested'), searchPath, input = '{}', extraEnv = {} } = {}) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => searchPath === undefined || key.toUpperCase() !== 'PATH'));
    return spawnSync(process.execPath, ['-e', /^node -e "([^"]*)"$/.exec(command)[1]], { cwd, env: { ...(searchPath === undefined ? env : { ...env, PATH: searchPath }), ...extraEnv }, input, encoding: 'utf8' });
  };
  const command = () => hookCommand('codex', 'quality-gate.cjs');

  test('runs the gate from the git root and passes its answer through when it ends with 0', () => {
    gate("let s='';process.stdin.on('data',(c)=>{s+=c}).on('end',()=>{process.stdout.write('got:'+s)})");
    expect(run(command(), { input: '{"a":1}' })).toMatchObject({ status: 0, stdout: 'got:{"a":1}' });
    gate("process.stdout.write(JSON.stringify({decision:'block',reason:'from the gate',hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'from the gate'}}))");
    blocked(run(command()), /^from the gate$/, { stderr: false });
  });

  test('a gate that refuses with exit 2 and stderr is turned into one block JSON with that reason', () => {
    gate("process.stdout.write('got:');process.stderr.write('own reason\\n');process.exit(2)");
    const r = run(command());
    blocked(r, /^own reason$/, { stderr: false });
    expect(r.stderr).toBe('own reason\n');
    gate('process.exit(2)');
    blocked(run(command()), /^ai-dev-helm: the quality gate stopped this command\.$/, { stderr: false });
  });

  test('refuses the command (one block JSON, exit 0) when the gate cannot run: no gate file, no git, a failing or hanging gate', () => {
    blocked(run(command()), /\.codex\/hooks\/quality-gate\.cjs was not found under the git root .*npx @crearize\/ai-dev-helm upgrade.*so this command is stopped/);
    gate('process.exit(0)');
    blocked(run(command(), { searchPath: tempDir() }), /git could not find the repository root .*so this command is stopped/);
    // A gate that printed its own JSON and then failed: only the wrapper's JSON is printed (two would be invalid output).
    for (const body of ['process.exit(1)', 'throw new Error("broken copy")', 'process.exit(3)', "process.stdout.write(JSON.stringify({decision:'block',reason:'x'}));process.exit(1)"]) {
      gate(body);
      blocked(run(command()), /the quality gate did not finish .*so this command is stopped/);
    }
    gate('setInterval(()=>{},1000)');
    const start = Date.now();
    // The deadline shortened to 1.5 s for the test (the text is the same but for that number).
    blocked(run(command().replace('25000-(Date.now()-t0)', '1500-(Date.now()-t0)')), /ran past 25 s\), so this command is stopped/);
    expect(Date.now() - start).toBeLessThan(20000);
    expect(command()).toContain("{stdio:['inherit','pipe','pipe'],env:{...process.env,AI_DEV_HELM_HOOK_DEADLINE:String(t0+23500)},timeout:Math.max(1000,25000-(Date.now()-t0))}");
    expect(command()).not.toContain('process.exit(');
  });

  test.skipIf(process.platform === 'win32')('refuses the command when the gate is killed by a signal', () => {
    gate("process.stdout.write('partial');process.kill(process.pid,'SIGKILL')");
    blocked(run(command()), /the quality gate did not finish/);
  });

  const notRun = /git does not take this directory as a work tree \(outside a repository, a repository git refuses, or a bare repository\), so the quality gate is not run/;
  test('outside a repository (git exits 128) there is no gate to find: the call goes through', () => {
    const outside = run(command(), { cwd: tempDir(), input: JSON.stringify({ tool_input: { command: 'git push origin main' } }) });
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe('');
    expect(outside.stderr).toMatch(notRun);
  });

  // C1-M5 and round 6 of the quality check: git exits 128 in more places than outside a repository. Inside a .git
  // directory git push and merge still work but no gate can run, so the wrapper stops every call there (the command is
  // not read: no spelling gets through) - decided by the path alone. Everywhere else git exits 128 (a broken .git, a bare
  // repository with work trees beside it, GIT_CEILING_DIRECTORIES) the call goes through as in 3.7.1: git refuses a
  // refused repository itself. No gate file runs where git exits 128 (no root to find it under).
  test('3.7.2 (C1-M5): where git exits 128, only inside a .git directory is the call stopped; no gate file runs', { timeout: 120000 }, () => {
    const ran = path.join(tempDir(), 'ran');
    const marker = `require('fs').writeFileSync(${JSON.stringify(ran)},'x');process.exitCode=0`;
    gate(marker);
    const payload = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    const status128 = (cwd, env = {}) => expect(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: { ...process.env, ...env } }).status, cwd).toBe(128);
    const inside = [path.join(project, '.git'), path.join(project, '.git', 'refs')];
    for (const cwd of inside) {
      status128(cwd);
      // Any command - a gate word, one built to hide it (C5-M3), none, or no readable command - is stopped.
      for (const input of [payload('git push origin main'), payload("git pu''sh origin feat:main"), payload('ls -la'), 'not json']) {
        blocked(run(command(), { cwd, input }), /the working directory is inside a \.git directory, where git push and merge still work but the quality gate cannot run \(start Codex in the work tree, outside \.git\), so this command is stopped/);
      }
    }
    // Where git exits 128 but the path has no .git segment, the call goes through (C5-H2, C5-H3 of round 5).
    const broken = tempDir(); // a broken .git (a gitdir file pointing nowhere), with a gate file that must not run
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ./missing\n');
    fs.mkdirSync(path.join(broken, 'sub'));
    fs.mkdirSync(path.join(broken, '.codex', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(broken, '.codex', 'hooks', 'quality-gate.cjs'), marker);
    const bare = tempDir(); // a bare repository with work trees beside it: `.bare` and a `.git` file naming it
    expect(spawnSync('git', ['init', '-q', '--bare', path.join(bare, '.bare')]).status).toBe(0);
    fs.writeFileSync(path.join(bare, '.git'), 'gitdir: ./.bare\n');
    const ceiling = { GIT_CEILING_DIRECTORIES: project };
    const outside = [[path.join(broken, 'sub'), {}], [bare, {}], [path.join(project, 'nested'), ceiling]];
    for (const [cwd, extraEnv] of outside) {
      status128(cwd, extraEnv);
      const r = run(command(), { cwd, extraEnv, input: payload('git -C feat2 push -u origin feat2') });
      expect(r.status, cwd).toBe(0);
      expect(r.stdout, cwd).toBe('');
      expect(r.stderr, cwd).toMatch(notRun);
    }
    expect(fs.existsSync(ran)).toBe(false);
  });

  test('a declared gate (gate.script) gets the same wrapper with its own path', () => {
    const declaredGate = declaredCommand('codex', 'quality-gate.cjs', 'scripts/gate.cjs');
    expect(run(declaredGate).stderr).toMatch(/scripts\/gate\.cjs was not found under the git root/);
    gate("process.stdout.write('declared')", 'scripts/gate.cjs');
    expect(run(declaredGate)).toMatchObject({ status: 0, stdout: 'declared' });
    // review-budget's Codex registration is the 3.3.0 wrapper still (no gate; its trust stays).
    expect(declaredCommand('codex', 'review-budget.cjs', 'scripts/rb.cjs')).toContain('process.exit(child.status??1)');
  });

  test('a re-run replaces a released fail-open gate registration in place, keeping its matcher, keys and position', () => {
    const own = { matcher: 'Read', hooks: [{ type: 'command', command: 'node scripts/own.cjs' }] };
    const old = legacyCodexWrapper("'.codex','hooks','quality-gate.cjs'");
    writeConfig('codex', { hooks: { PreToolUse: [own, { matcher: '^(Bash|shell)$', hooks: [{ type: 'command', command: 'node scripts/first.cjs' }, { type: 'command', command: old, timeout: 20, statusMessage: 'gate' }] }] } });
    for (let n = 0; n < 2; n++) setupRuntimeHooks(project, 'codex', { preserveCodex: true, copyScripts: false });
    const pre = readConfig('codex').hooks.PreToolUse;
    expect(pre[0]).toEqual(own);
    expect(pre[1]).toEqual({ matcher: '^(Bash|shell)$', hooks: [{ type: 'command', command: 'node scripts/first.cjs' }, { type: 'command', command: command(), timeout: 20, statusMessage: 'gate' }] });
    expect(pre.filter((entry) => entry.hooks.some((hook) => (calledHook(hook.command) || {}).file === 'quality-gate.cjs'))).toHaveLength(1);
    // A declared gate's released registration too.
    fs.writeFileSync(path.join(project, '.ai-dev-helm.json'), JSON.stringify({ gate: { script: 'scripts/gate.cjs' } }));
    writeConfig('codex', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: legacyCodexWrapper("'scripts','gate.cjs'"), timeout: 30 }] }] } });
    setupRuntimeHooks(project, 'codex', { preserveCodex: true, copyScripts: false });
    expect(readConfig('codex').hooks.PreToolUse[0].hooks[0].command).toBe(declaredCommand('codex', 'quality-gate.cjs', 'scripts/gate.cjs'));
  });
});

// 3.7.2 (C6-M3): a refusal Codex acts on whatever shell starts the hook - exit 0 and one block JSON (the whole stdout
// parses as one JSON text), with the reason on stderr too unless the gate's own stderr is the reason.
function blocked(r, reason, { stderr = true } = {}) {
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout.trim());
  expect(out.decision).toBe('block');
  expect(out.reason).toMatch(reason);
  expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason });
  if (stderr) expect(r.stderr).toMatch(reason);
}

// 3.7.2 (C6-M3): codex-cli 0.167.0 starts a hook through the turn's shell - on Windows PowerShell's
// `-NoProfile -Command <command>`, or `COMSPEC`'s `/C` when no shell is found. PowerShell turns exit 2 into 1, which
// Codex reads as a failed hook and does not act on; the wrapper's refusals are one block JSON and exit 0 in every one.
describe.skipIf(process.platform !== 'win32')('Codex gate wrapper started the way Codex starts it on Windows (3.7.2, C6-M3)', () => {
  const { hookCommand } = require('./runtime-hooks');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmdExe = process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe');
  const launchers = {
    powershell: (command, options) => spawnSync(powershell, ['-NoProfile', '-Command', command], options),
    cmd: (command, options) => spawnSync(cmdExe, ['/d', '/s', '/c', `"${command}"`], { ...options, windowsVerbatimArguments: true }),
    direct: (command, options) => spawnSync(process.execPath, ['-e', /^node -e "([^"]*)"$/.exec(command)[1]], options),
  };
  const scratch = [];
  afterEach(() => { while (scratch.length) fs.rmSync(scratch.pop(), { recursive: true, force: true }); });
  const gateFile = () => path.join(project, '.codex', 'hooks', 'quality-gate.cjs');
  const gate = (body) => { fs.mkdirSync(path.dirname(gateFile()), { recursive: true }); fs.writeFileSync(gateFile(), body); };
  const run = (launcher, command, { cwd = path.join(project, 'nested'), env = process.env, input = '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' } = {}) =>
    launchers[launcher](command, { cwd, env, input, encoding: 'utf8' });
  // node is found, git is not (a PATH of node's own folder and the system folders).
  const noGitEnv = () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    return { ...env, PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32'), path.dirname(powershell)].join(';') };
  };

  test.each(Object.keys(launchers))('%s: every refusal is one block JSON and exit 0; a gate\'s exit-0 answer is passed on', (launcher) => {
    const command = hookCommand('codex', 'quality-gate.cjs');
    blocked(run(launcher, command), /quality-gate\.cjs was not found under the git root/);
    for (const body of ['process.exit(1)', "process.stdout.write(JSON.stringify({decision:'block',reason:'x'}));process.exit(3)"]) {
      gate(body);
      blocked(run(launcher, command), /the quality gate did not finish/);
    }
    gate("process.stderr.write('own reason');process.exit(2)");
    blocked(run(launcher, command), /^own reason$/, { stderr: false });
    gate("process.stdout.write(JSON.stringify({decision:'block',reason:'x'}));process.exit(2)");
    blocked(run(launcher, command), /^ai-dev-helm: the quality gate stopped this command\.$/, { stderr: false });
    gate('setInterval(()=>{},1000)');
    blocked(run(launcher, command.replace('25000-(Date.now()-t0)', '1500-(Date.now()-t0)')), /ran past 25 s/);
    gate("let s='';process.stdin.on('data',(c)=>{s+=c}).on('end',()=>{const m='gate saw '+JSON.parse(s).tool_input.command;process.stdout.write(JSON.stringify({decision:'block',reason:m,hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:m}}))})");
    blocked(run(launcher, command), /^gate saw git push origin main$/, { stderr: false });
    if (!fs.existsSync(path.join(path.dirname(process.execPath), 'git.exe'))) {
      blocked(run(launcher, command, { env: noGitEnv() }), /git could not find the repository root/);
    }
    blocked(run(launcher, command, { cwd: path.join(project, '.git') }), /inside a \.git directory/);
    gate('process.exit(0)');
    expect(run(launcher, command)).toMatchObject({ status: 0, stdout: '' });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-codex-outside-'));
    scratch.push(elsewhere);
    const outside = run(launcher, command, { cwd: elsewhere });
    expect(outside).toMatchObject({ status: 0, stdout: '' });
    expect(outside.stderr).toMatch(/so the quality gate is not run/);
  }, 120000);
});

// The 3.3.0-3.7.1 Codex wrapper text (Codex trust hashed it); `joinArgs` names the path below the git root.
function legacyCodexWrapper(joinArgs) {
  return `node -e "const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,${joinArgs})],{stdio:'inherit'});process.exit(child.status??1)"`;
}
