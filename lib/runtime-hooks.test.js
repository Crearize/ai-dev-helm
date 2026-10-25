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

  test('keeps the Codex wrapper byte-identical to 3.3.0', () => {
    // Break: any change to the Codex command voids its /hooks trust in every installed project.
    expect(hookCommand('codex', 'quality-gate.cjs')).toBe(legacy('codex', 'quality-gate.cjs'));
    expect(hookCommand('codex', 'review-budget.cjs')).toBe(legacy('codex', 'review-budget.cjs'));
    expect(hookCommand('claude', 'quality-gate.cjs')).not.toBe(legacy('claude', 'quality-gate.cjs'));
  });
});

// P10': Claude Code's PowerShell tool runs shell commands too, so the gate is
// registered for both shell tools there. Codex trusts a hook by a hash of its
// registration, so the Codex registration must not change by a byte.
describe('quality-gate matcher (P10)', () => {
  const { hookCommand } = require('./runtime-hooks');
  const { codexHookHash } = require('./codex-trust');
  const gateEntry = (config) => config.hooks.PreToolUse.find((entry) => entry.hooks.some((hook) => hook.command.includes('quality-gate.cjs')));

  test('registers the Claude Code gate for Bash and PowerShell only', () => {
    writeConfig('claude', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: oldGate('claude') }] }] } });
    setupRuntimeHooks(project, 'claude');
    const { matcher } = gateEntry(readConfig('claude'));
    expect(matcher).toBe('^(Bash|PowerShell)$');
    expect(['Bash', 'PowerShell'].every((tool) => new RegExp(matcher).test(tool))).toBe(true);
    expect(['Read', 'PowerShellX', 'Agent'].some((tool) => new RegExp(matcher).test(tool))).toBe(false);
    const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../templates/settings.json.template'), 'utf8'));
    expect(template.hooks.PreToolUse[0].matcher).toBe('^(Bash|PowerShell)$');
  });

  test('keeps the Codex registration byte-identical, so its hook trust stays valid', () => {
    writeConfig('codex', { hooks: { PreToolUse: [] } });
    setupRuntimeHooks(project, 'codex');
    const entry = gateEntry(readConfig('codex'));
    expect(entry).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('codex', 'quality-gate.cjs'), timeout: 30 }] });
    // The trusted_hash Codex recorded for 3.2.1's registration.
    expect(codexHookHash('PreToolUse', entry.matcher, entry.hooks[0], { platform: 'linux' }))
      .toBe('sha256:8d79fff5d7c15b1473795fa464f4b202a81fa4e9ae36979a838182e1b15f65d0');
    const template = fs.readFileSync(path.resolve(__dirname, '../templates/codex-hooks.json.template'), 'utf8').replace(/\r\n/g, '\n');
    expect(template).toBe('{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "^Bash$",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "node .codex/hooks/quality-gate.cjs",\n            "timeout": 30\n          }\n        ]\n      }\n    ]\n  }\n}\n');
  });
});

// #207: context-handoff keeps a record across /compact and /clear. It is Claude Code only and never blocks.
describe('context-handoff registration (#207)', () => {
  const { handoffCommand, HANDOFF_EVENTS } = require('./runtime-hooks');
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

  test('does not touch Codex', () => {
    // Break: any new Codex registration voids its /hooks trust in every installed project.
    writeConfig('codex', { hooks: { PreToolUse: [] } });
    setupRuntimeHooks(project, 'codex');
    const config = readConfig('codex');
    expect(Object.keys(config.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse']);
    expect(fs.existsSync(path.join(project, '.codex', 'hooks', 'context-handoff.cjs'))).toBe(false);
    // Codex events that context-handoff does not use are not checked, so an odd Stop there does not block the update.
    writeConfig('codex', { hooks: { PreToolUse: [], Stop: { odd: true } } });
    expect(setupRuntimeHooks(project, 'codex')).toEqual([]);
    expect(readConfig('codex').hooks.Stop).toEqual({ odd: true });
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
