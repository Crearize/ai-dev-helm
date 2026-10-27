'use strict';

// 3.7.1 (D4): Cursor's gate - `.cursor/hooks.json` beforeShellExecution runs the distributed quality-gate.cjs with
// the argument `cursor`. The registration is found by its command and replaced; every other registration and key of
// the file stays. The wrapper finds the gate from the git root (gate.script, .claude, .codex, .cursor) and stops the
// command (exit 2, failClosed) when there is none. A Cursor-only product gets its own copy of the gate; hook-selftest
// checks the registration and runs the decision table through Cursor's input and output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { setupCursorHooks, cursorGateCommand, isCursorGate } = require('./runtime-hooks');
const { runHookSelftest, checkInstall } = require('./hook-selftest');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'templates', 'hooks', 'quality-gate.cjs');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cursor-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const file = () => path.join(dir, '.cursor', 'hooks.json');
const readHooks = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const writeHooks = (value) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), typeof value === 'string' ? value : JSON.stringify(value, null, 2)); };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

describe('the registration in .cursor/hooks.json', () => {
  test('is created fail-closed, without a matcher, and a second run changes nothing', () => {
    expect(setupCursorHooks(dir)).toEqual([]);
    expect(readHooks()).toEqual({ version: 1, hooks: { beforeShellExecution: [{ command: cursorGateCommand(), timeout: 30, failClosed: true }] } });
    const before = fs.readFileSync(file(), 'utf8');
    setupCursorHooks(dir);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file())).filter((f) => /\.backup\./.test(f))).toEqual([]);
    expect(isCursorGate(cursorGateCommand())).toBe(true);
    expect(cursorGateCommand()).not.toMatch(/[$`]/);
  });

  test('keeps the product\'s other registrations and keys, and replaces an older harness registration once', () => {
    const own = { command: 'node .cursor/hooks/quality-gate.mjs', matcher: '(push|merge)', timeout: 30, failClosed: true };
    const older = { command: `node -e "require('x');['.claude','hooks','quality-gate.cjs']" cursor`, timeout: 10 };
    writeHooks({ version: 1, custom: true, hooks: { beforeShellExecution: [own, older], afterFileEdit: [{ command: 'node fmt.js' }] } });
    setupCursorHooks(dir);
    const after = readHooks();
    expect(after.custom).toBe(true);
    expect(after.hooks.afterFileEdit).toEqual([{ command: 'node fmt.js' }]);
    expect(after.hooks.beforeShellExecution).toEqual([own, { command: cursorGateCommand(), timeout: 30, failClosed: true }]);
    expect(fs.readdirSync(path.dirname(file())).filter((f) => /\.backup\./.test(f))).toHaveLength(1);
  });

  test('keeps the product\'s key order, so a second run does not rewrite the file', () => {
    writeHooks({ hooks: { beforeShellExecution: [{ command: cursorGateCommand(), timeout: 30, failClosed: true }] }, version: 1 });
    const before = fs.readFileSync(file(), 'utf8');
    setupCursorHooks(dir);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file())).filter((f) => /\.backup\./.test(f))).toEqual([]);
  });

  test('a file it cannot read is left as it is, with a warning', () => {
    writeHooks('{ not json');
    expect(setupCursorHooks(dir).join('\n')).toMatch(/ACTION REQUIRED: .*could not be read as JSON/);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ not json');
    writeHooks({ hooks: { beforeShellExecution: {} } });
    expect(setupCursorHooks(dir).join('\n')).toMatch(/is not a Cursor hooks file/);
  });

  test('a declared gate.script is the first place the wrapper looks', () => {
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ version: '3.7.1', gate: { script: 'scripts/gate.mjs' } }));
    setupCursorHooks(dir);
    const command = readHooks().hooks.beforeShellExecution[0].command;
    expect(command).toBe(cursorGateCommand('scripts/gate.mjs'));
    expect(command.indexOf("'scripts','gate.mjs'")).toBeLessThan(command.indexOf("'.claude','hooks'"));
  });
});

describe('the wrapper', () => {
  // The wrapper's source, run as Cursor runs `node -e "<source>" cursor` (no shell in between here).
  const source = (command) => /^node -e "([^"]*)" cursor$/.exec(command)[1];
  const repo = () => {
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'app.js'), '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat');
  };
  const run = (command, payload) => spawnSync(process.execPath, ['-e', source(command), 'cursor'], { cwd: dir, input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000 });
  const place = (rel, text = fs.readFileSync(GATE)) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

  test('runs the first gate it finds with Cursor\'s input and output; none found stops the command (exit 2)', () => {
    repo();
    const none = run(cursorGateCommand(), { command: 'npm test', cwd: dir });
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/no quality-gate\.cjs was found/);
    place('.cursor/hooks/quality-gate.cjs');
    const denied = run(cursorGateCommand(), { command: 'git push origin HEAD:main', cwd: dir });
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).permission).toBe('deny');
    expect(JSON.parse(run(cursorGateCommand(), { command: 'npm test', cwd: dir }).stdout)).toEqual({ permission: 'allow' });
    // .claude before .cursor; the declared file before both.
    place('.claude/hooks/quality-gate.cjs', 'process.stdout.write(JSON.stringify({permission:"deny",user_message:"claude copy",agent_message:"claude copy"}))');
    expect(JSON.parse(run(cursorGateCommand(), { command: 'npm test', cwd: dir }).stdout).user_message).toBe('claude copy');
    place('scripts/gate.cjs', 'process.stdout.write(JSON.stringify({permission:"allow",arg:process.argv[2]}))');
    expect(JSON.parse(run(cursorGateCommand('scripts/gate.cjs'), { command: 'npm test', cwd: dir }).stdout)).toEqual({ permission: 'allow', arg: 'cursor' });
    // A gate that does not answer with Cursor's permission - Claude's output, silence, a failure - stops the command.
    for (const body of ['process.stdout.write(JSON.stringify({decision:"block",reason:"x"}))', '', 'process.exit(1)', 'process.stdout.write("not json")']) {
      place('scripts/gate.cjs', body);
      const r = run(cursorGateCommand('scripts/gate.cjs'), { command: 'npm test', cwd: dir });
      expect(r.status, body).toBe(2);
      expect(r.stdout, body).toBe('');
      expect(r.stderr, body).toMatch(/did not answer with a Cursor permission/);
    }
  }, 60000);
});

describe('init and hook-selftest', () => {
  const init = (tools) => {
    git(dir, 'init', '-q', '-b', 'main');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cli.js'), 'init', '--yes', '--project-name', 'p', '--tools', tools, '--skills', 'project', '--stacks', ''], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr + r.stdout).toBe(0);
  };

  test('a Cursor-only product gets the registration and its own gate copy; the table runs through Cursor\'s output', () => {
    init('cursor');
    expect(readHooks().hooks.beforeShellExecution).toEqual([{ command: cursorGateCommand(), timeout: 30, failClosed: true }]);
    expect(fs.readFileSync(path.join(dir, '.cursor', 'hooks', 'quality-gate.cjs'), 'utf8')).toBe(fs.readFileSync(GATE, 'utf8'));
    const result = runHookSelftest({ dir });
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result.lines.join('\n')).toMatch(/cursor -> \.cursor\/hooks\/quality-gate\.cjs: (\d+)\/\1 cases passed/);
    expect(result.exitCode).toBe(0);
  }, 120000);

  test('with Claude Code too, Cursor runs the .claude copy; a missing or duplicated registration fails', () => {
    init('claude-code,cursor');
    expect(fs.existsSync(path.join(dir, '.cursor', 'hooks', 'quality-gate.cjs'))).toBe(false);
    expect(checkInstall(dir)).toEqual([]);
    const result = runHookSelftest({ dir });
    expect(result.lines.join('\n')).toMatch(/cursor -> \.claude\/hooks\/quality-gate\.cjs: (\d+)\/\1 cases passed/);
    const hooks = readHooks();
    hooks.hooks.beforeShellExecution.push(hooks.hooks.beforeShellExecution[0]);
    writeHooks(hooks);
    expect(checkInstall(dir).join('\n')).toMatch(/\.cursor\/hooks\.json beforeShellExecution runs quality-gate\.cjs 2 time\(s\)/);
    fs.rmSync(file());
    expect(checkInstall(dir).join('\n')).toMatch(/runs quality-gate\.cjs 0 time\(s\)/);
  }, 120000);

  test('without cursor in tools, a product\'s own .cursor/hooks.json is not the harness\'s to check', () => {
    init('claude-code');
    writeHooks({ version: 1, hooks: { beforeShellExecution: [{ command: 'node .cursor/hooks/own.mjs', failClosed: true }], afterFileEdit: [{ command: 'node fmt.js' }] } });
    expect(checkInstall(dir)).toEqual([]);
    // A harness registration that is there is still checked (here: not fail-closed).
    writeHooks({ version: 1, hooks: { beforeShellExecution: [{ command: cursorGateCommand(), timeout: 30 }] } });
    expect(checkInstall(dir).join('\n')).toMatch(/is not failClosed: true without a matcher/);
  }, 120000);

  test('a declared gate that does not speak Cursor\'s output fails the Cursor table', () => {
    init('claude-code,cursor');
    // A gate with the Claude output only (3.7.0's): Cursor reads no permission from it.
    const claudeOnly = fs.readFileSync(GATE, 'utf8').replace("const cursor = process.argv[2] === 'cursor';", 'const cursor = false;');
    expect(claudeOnly).not.toBe(fs.readFileSync(GATE, 'utf8'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'gate.cjs'), claudeOnly);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.ai-dev-helm.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ ...manifest, gate: { script: 'scripts/gate.cjs' } }));
    const result = runHookSelftest({ dir });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toMatch(/FAIL cursor\/quality-gate \(scripts\/gate\.cjs\): .*got no Cursor output/);
  }, 120000);

  test('a declared gate that speaks Cursor and denies an unreadable payload (fail-closed) passes the Cursor table', () => {
    init('claude-code,cursor');
    // The product's gate: an unreadable payload is denied in either output; anything else goes to the distributed gate.
    const failClosed = `const { spawnSync } = require('child_process');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const cursor = process.argv[2] === 'cursor';
  try { JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify(cursor ? { permission: 'deny', user_message: 'unreadable payload' } : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'unreadable payload' } }));
    return;
  }
  const run = spawnSync(process.execPath, [${JSON.stringify(GATE)}, ...process.argv.slice(2)], { input, encoding: 'utf8' });
  process.stdout.write(run.stdout || '');
});
`;
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'gate.cjs'), failClosed);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.ai-dev-helm.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ ...manifest, gate: { script: 'scripts/gate.cjs' } }));
    const result = runHookSelftest({ dir });
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result.lines.join('\n')).toMatch(/cursor -> scripts\/gate\.cjs: (\d+)\/\1 cases passed/);
    expect(result.exitCode).toBe(0);
  }, 120000);
});
