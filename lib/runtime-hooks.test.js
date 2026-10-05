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
    expect(JSON.parse(inRepo.stdout).systemMessage).toMatch(/npx @crearize\/ai-dev-helm init/);
    expect(JSON.parse(inRepo.stdout).systemMessage).not.toMatch(/git could not find/);
    const outside = run(hookCommand('claude', 'quality-gate.cjs'), { cwd: tempDir(), extraEnv: { CLAUDE_PROJECT_DIR: tempDir() }, input: '{}' });
    expect(outside.stderr).not.toMatch(/fatal/);
    const noGit = run(hookCommand('claude', 'quality-gate.cjs'), { cwd: project, searchPath: tempDir(), input: '{}' });
    expect(JSON.parse(noGit.stdout).systemMessage).toMatch(/git could not find the repository root/);
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
