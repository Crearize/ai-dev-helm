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
    expect(config.hooks.PreToolUse.some((entry) => entry.matcher === '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent)$')).toBe(true);
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
