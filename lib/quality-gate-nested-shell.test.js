'use strict';

// H-52 / P10a item 3: nested shells and unreadable PowerShell scripts.
//
// Since PR #173 the gate reads an ALLOWLISTED simple form, and
// `powershell` / `pwsh` / `cmd` / `bash` are not command words in it, so a
// nested shell that visibly holds a gate word is refused as "not simple"
// (the design's recursive unwrapping is not needed). The design's contrast
// "allow `powershell -Command \"git push origin main\"` when the flag is on
// HEAD" is therefore REFUSED by design - the push must run as its own simple
// command. What is new here is `alwaysDeny`: an encoded or stdin PowerShell
// script is refused whether or not a gate word is visible.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { PACKAGE_ROOT } = require('./utils');
const { classify } = require('../templates/hooks/quality-gate.cjs');

const HOOK = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
// `Write-Output ok`, UTF-16LE, base64: harmless whatever runs it.
const B64 = Buffer.from('Write-Output ok', 'utf16le').toString('base64');

// A ctx that answers like a repository on main with no flag (or a flag on
// HEAD), and records whether anything was resolved at all.
const makeCtx = (over = {}) => {
  const values = {
    branch: 'main', head: HEAD_SHA, flag: null, isAncestor: false, diffSinceFlag: null,
    diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
    fullRef: (name) => (name.startsWith('refs/') ? name : `refs/remotes/${name}`),
    ...over,
  };
  const ctx = { resolved: [] };
  for (const key of Object.keys(values)) {
    Object.defineProperty(ctx, key, { get: () => { ctx.resolved.push(key); return values[key]; }, enumerable: true });
  }
  return ctx;
};
const withFlag = () => makeCtx({ flag: { commit: HEAD_SHA } });

const expectNotSimple = (command, ctx = makeCtx()) => {
  const verdict = classify(command, ctx);
  expect(verdict.decision, command).toBe('block');
  expect(verdict.rule, command).toBe('2');
  expect(verdict.reason, command).toMatch(/not in the simple form/);
  expect(ctx.resolved, command).toEqual([]);
};
const expectUnreadable = (command, ctx = makeCtx()) => {
  const verdict = classify(command, ctx);
  expect(verdict.decision, command).toBe('block');
  expect(verdict.rule, command).toBe('2');
  expect(verdict.reason, command).toMatch(/encoded or stdin PowerShell script/);
  expect(ctx.resolved, command).toEqual([]);
};
const expectAllow = (command, ctx = makeCtx()) => {
  const verdict = classify(command, ctx);
  expect(verdict.decision, `${command}: ${verdict.reason}`).toBe('allow');
};

describe('nested shells that visibly push or merge are refused (regression)', () => {
  const NESTED = [
    'powershell -NoProfile -Command "git push origin main"',
    "pwsh -c 'git push origin main'",
    'cmd /c "git push origin main"',
    'bash -c "git merge feature"',
    'powershell -Command "bash -c \'git push origin main\'"',
    'powershell /Command "git push origin main"',
    'pwsh --command "git push origin main"',
    'cmd /s /c "git push origin main"',
    'cmd /c"git push origin main"',
    'bash -ec "git push origin main"',
    'bash -lc "git push origin main"',
    'powershell.exe -Command git push origin main',
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "git push origin main"',
  ];

  it.each(NESTED)('%s (main, no flag)', (command) => {
    expectNotSimple(command);
  });

  it('is refused with the flag on HEAD too: run the push as its own command', () => {
    for (const command of NESTED) expectNotSimple(command, withFlag());
    // The same push written directly passes with that flag.
    expectAllow('git push origin main', withFlag());
  });

  it('leaves nested shells without a gate word alone', () => {
    for (const command of [
      'powershell -Command "git status"',
      'bash -c "npm test"',
      'cmd /c "npm run build"',
      'pwsh -NoProfile -Command Get-Date',
    ]) expectAllow(command);
  });
});

describe('alwaysDeny: encoded or stdin PowerShell scripts', () => {
  // The spellings powershell.exe 5.1 accepts (checked on Windows 11; see the
  // live test below) and pwsh 7 accepts (CommandLineParameterParser.cs):
  // `ec`, or any leading part of `encodedcommand` from `e`, any case, after
  // `-`, `/`, U+2013, U+2014, U+2015, or (pwsh) a doubled dash.
  const NAMES = ['ec', ...Array.from({ length: 'encodedcommand'.length }, (_, i) => 'encodedcommand'.slice(0, i + 1))];
  const PREFIXES = ['-', '/', '\u2013', '\u2014', '\u2015', '--', '\u2013\u2013'];

  it('refuses every encoded-command spelling, for powershell and pwsh, gate word or not', () => {
    for (const exe of ['powershell', 'pwsh', 'powershell.exe', 'PWSH.EXE', 'PowerShell']) {
      for (const prefix of PREFIXES) {
        for (const name of NAMES) {
          for (const spelled of [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)]) {
            expectUnreadable(`${exe} -NoProfile ${prefix}${spelled} ${B64}`);
          }
        }
      }
    }
  });

  it('refuses them on a feature branch and with a flag on HEAD', () => {
    expectUnreadable(`pwsh -enc ${B64}`, makeCtx({ branch: 'feat/x' }));
    expectUnreadable(`powershell -EncodedCommand ${B64}`, withFlag());
  });

  it('refuses them through a path, quotes, another shell, or after other parameters', () => {
    for (const command of [
      `"C:/Program Files/PowerShell/7/pwsh.exe" -NoProfile -e ${B64}`,
      `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -ec ${B64}`,
      `bash -c "pwsh -enc ${B64}"`,
      `cmd /c powershell -enc ${B64}`,
      `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -enc ${B64}`,
      `powershell "-enc" ${B64}`,
      `git status && pwsh -e ${B64}`,
    ]) expectUnreadable(command);
  });

  it('refuses a script read from standard input', () => {
    for (const command of [
      'echo git push origin main | powershell -Command -',
      'echo Get-Date | powershell -c -',
      'echo Get-Date | pwsh -NoProfile -Command -',
      'echo Get-Date | powershell /Command -',
      'echo Get-Date | pwsh -File -',
      'echo Get-Date | powershell -',
      'echo Get-Date | powershell -NoProfile',
      'powershell -NoProfile < script.ps1',
    ]) expectUnreadable(command);
  });

  it('stays linear on a text crowded with PowerShell words, refusing what it cannot finish reading', () => {
    const started = Date.now();
    expectUnreadable('pwsh -a '.repeat(120000));
    expectAllow('pwsh '.repeat(190000));
    expectAllow('a/pwsh'.repeat(150000));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stays narrow: everyday PowerShell and text that only mentions it pass', () => {
    for (const command of [
      'powershell -ExecutionPolicy Bypass -File x.ps1',
      'powershell -ep Bypass -File x.ps1',
      'powershell -ex Bypass -File x.ps1',
      'powershell -NoProfile -File scripts/build.ps1 -e prod',
      'pwsh -NoProfile -Command "Write-Output -e"',
      'powershell -Command Get-Date',
      'pwsh -v',
      'pwsh --version',
      'Get-Process pwsh',
      'Stop-Process -Name pwsh -Force',
      'git log | grep -i powershell',
      'cat docs/powershell/notes.md',
      'ls "C:/Program Files/PowerShell/"',
      'git commit -m "explain why pwsh -enc is refused"',
      'echo hi | powershell -Command Write-Output $input',
      'npm test',
    ]) expectAllow(command);
  });
});

// The live oracle: every spelling the installed Windows PowerShell 5.1 runs
// as an encoded command must be refused. Windows only.
const hasWindowsPowerShell = process.platform === 'win32'
  && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30000 }).status === 0;
describe.skipIf(!hasWindowsPowerShell)('alwaysDeny against powershell.exe 5.1', () => {
  it('refuses each encoded-command spelling 5.1 actually runs', () => {
    const accepted = [];
    for (const param of ['-e', '-ec', '-en', '-enc', '-EncodedCommand', '/e', '/ENC', '\u2013enc', '--enc', '-ea', '-enc:']) {
      const args = param.endsWith(':') ? [`${param}${B64}`] : [param, B64];
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', timeout: 30000, input: '' });
      if ((r.stdout || '').trim() === 'ok') {
        accepted.push(param);
        expectUnreadable(`powershell -NoProfile -NonInteractive ${args.join(' ')}`);
      }
    }
    // What 5.1 accepted on Windows 11 when this was written; `--enc`, `-ea`
    // and the `:` form are not encoded commands there.
    expect(accepted).toEqual(['-e', '-ec', '-en', '-enc', '-EncodedCommand', '/e', '/ENC', '\u2013enc']);
  }, 120000);
});

describe('the hook header lists what it does not read', () => {
  const header = fs.readFileSync(HOOK, 'utf8').replace(/\r\n/g, '\n').split("const fs = require('fs');")[0];
  it.each([
    'Invoke-Expression', '`iex`', '`Start-Process`', '`& { ... }`', '`-File <path>`',
    '`node -e`', '`python -c`', '`eval`', '`source`', '`. <file>`', '`xargs`', '`find -exec`',
    'an alias or a', 'function', 'environment variable',
  ])('%s', (item) => {
    const nothingSection = header.split('Nothing here can see through').pop();
    expect(nothingSection).toContain(item);
  });

  it('documents the nested-shell refusal and alwaysDeny', () => {
    expect(header).toMatch(/NESTED SHELLS \(H-52\)/);
    expect(header).toMatch(/ALWAYS REFUSED \(`alwaysDeny`/);
    expect(header).toMatch(/with a flag on\s+\/\/ HEAD is refused/);
  });
});

describe('the recorded Codex 0.156.1 payload (integration)', () => {
  let repo;
  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-codex-payload-')));
    const g = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.writeFileSync(path.join(repo, 'code.js'), 'x\n');
    g('add', 'code.js');
    g('commit', '-q', '-m', 'code');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('blocks git push origin main on main without a flag', () => {
    const fixture = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'runtime-payloads', 'codex-0.156.1-bash-exec_command.json');
    const payload = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    expect(payload.transcript_path).toBe('<redacted>');
    expect(payload).toMatchObject({ tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_input: { command: 'git push origin main' } });
    payload.cwd = repo;
    const result = spawnSync(process.execPath, [HOOK], { cwd: os.tmpdir(), input: JSON.stringify(payload), encoding: 'utf8' });
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ decision: 'block', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(out.reason).toMatch(/quality-check skill/);
  });
});
