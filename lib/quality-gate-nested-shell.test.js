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
  // `ec`, or any leading part of `encodedcommand` from `e`, any case, after
  // `-`, `/` or (pwsh) a doubled dash: the spellings powershell.exe 5.1 (see
  // the live test below) and pwsh 7 (CommandLineParameterParser.cs) accept.
  const NAMES = ['ec', ...Array.from({ length: 'encodedcommand'.length }, (_, i) => 'encodedcommand'.slice(0, i + 1))];

  it('refuses every encoded-command spelling, for powershell and pwsh, gate word or not', () => {
    for (const exe of ['powershell', 'pwsh', 'powershell.exe', 'PWSH.EXE', 'PowerShell']) {
      for (const prefix of ['-', '/', '--']) {
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

  it('refuses them through a path, quotes, another shell, a line continuation or after other parameters', () => {
    for (const command of [
      `"C:/Program Files/PowerShell/7/pwsh.exe" -NoProfile -e ${B64}`,
      `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -ec ${B64}`,
      `bash -c "pwsh -enc ${B64}"`,
      `cmd /c powershell -enc ${B64}`,
      `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -enc ${B64}`,
      `powershell "-enc" ${B64}`,
      `git status && pwsh -e ${B64}`,
      `powershell -NoProfile \`\n-enc ${B64}`,
      `pwsh -NoProfile \\\n  -e ${B64}`,
    ]) expectUnreadable(command);
  });

  it('refuses a script read from standard input with -Command -', () => {
    for (const command of [
      'echo git push origin main | powershell -Command -',
      'echo Get-Date | powershell -c -',
      'echo Get-Date | pwsh -NoProfile -Command -',
      'echo Get-Date | powershell /Command -',
      'pwsh -Command -',
    ]) expectUnreadable(command);
  });

  it('lets everyday PowerShell and commands that only mention it through', () => {
    for (const command of [
      'powershell -ExecutionPolicy Bypass -File x.ps1',
      'powershell -ep Bypass -File x.ps1',
      'powershell -ex Bypass -File x.ps1',
      'pwsh -NoProfile -File build.ps1 -Environment dev',
      'powershell -NoProfile -Command "Get-ChildItem | Select-Object Name"',
      'pwsh -File build.ps1 | tee build.log',
      'powershell -NoLogo -NonInteractive -Command "npm test"',
      'powershell -Command Get-Date',
      'pwsh -NoProfile -Command Get-Date',
      'pwsh -v',
      'pwsh --version',
      'Get-Process pwsh',
      'Stop-Process -Name pwsh -Force',
      'cat docs/powershell/notes.md',
      'ls "C:/Program Files/PowerShell/"',
      'npm test',
      'npm test 2>&1 | tail -5',
      'git grep -n "cmd|bash" -- "*.js"',
      'grep -e foo -e bar README.md | sort < list.txt',
      // H-16: a search term, a pipeline before a PowerShell script, an -e
      // in another command after it.
      'npx vitest run -t "powershell|pwsh"',
      "rg 'pwsh|powershell' docs",
      'git log | grep -i powershell',
      'npm test | tail -1; pwsh -File report.ps1',
      'pwsh -File build.ps1; grep -e foo README.md',
      'pwsh -File x.ps1 -Name "$a-$b"',
    ]) expectAllow(command);
  });

  it('over-refuses a mention of an encoded-command parameter after the name, with guidance', () => {
    for (const command of [
      'git commit -m "explain why pwsh -enc is refused"',
      'rg pwsh -e enc docs',
      'powershell -NoProfile -File scripts/build.ps1 -e prod',
    ]) {
      expectUnreadable(command);
      expect(classify(command, makeCtx()).reason, command).toMatch(/rerun it without them/);
    }
  });

  it('reads long commands in linear time', () => {
    for (const [command, refused] of [
      [`git status${' '.repeat(200 * 1024)}x`, false],
      [`git status${' \t'.repeat(100 * 1024)}| tail -5 x`, false],
      [' '.repeat(200 * 1024), false],
      ['pwsh -a '.repeat(25 * 1024), false],
      [`${'x | '.repeat(50 * 1024)}pwsh`, false],
      [`${'\\\n'.repeat(100 * 1024)} powershell -enc x`, true],
      [`${'"'.repeat(200 * 1024)} powershell -enc x`, true],
      [`pwsh -enc ${B64} `.repeat(4 * 1024), true],
    ]) {
      const started = Date.now();
      const verdict = classify(command, makeCtx());
      expect(Date.now() - started, `${command.slice(0, 20)}...`).toBeLessThan(500);
      expect(verdict.reason === undefined ? false : /PowerShell script/.test(verdict.reason), command.slice(0, 20)).toBe(refused);
    }
  });
});

// The live oracle: every ASCII spelling the installed Windows PowerShell 5.1
// runs as an encoded command must be refused. Windows only. (5.1 also takes
// a Unicode dash before the name; a lookalike is out of scope, see the header.)
const hasWindowsPowerShell = process.platform === 'win32'
  && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30000 }).status === 0;
describe.skipIf(!hasWindowsPowerShell)('alwaysDeny against powershell.exe 5.1', () => {
  it('refuses each encoded-command spelling 5.1 actually runs', () => {
    const accepted = [];
    for (const param of ['-e', '-ec', '-en', '-enc', '-EncodedCommand', '/e', '/ENC', '--enc', '-ea', '-enc:']) {
      const args = param.endsWith(':') ? [`${param}${B64}`] : [param, B64];
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', timeout: 30000, input: '' });
      if ((r.stdout || '').trim() === 'ok') {
        accepted.push(param);
        expectUnreadable(`powershell -NoProfile -NonInteractive ${args.join(' ')}`);
      }
    }
    // What 5.1 accepted on Windows 11 when this was written; `--enc`, `-ea`
    // and the `:` form are not encoded commands there.
    expect(accepted).toEqual(['-e', '-ec', '-en', '-enc', '-EncodedCommand', '/e', '/ENC']);
  }, 120000);

  it('over-refuses a later -e that 5.1 takes as script text (the rule reads text, not positions)', () => {
    for (const args of [
      ['-NoProfile', '-NonInteractive', 'Write-Output', '-e', B64],
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', 'Write-Output', '-enc', B64],
    ]) {
      const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 30000, input: '' });
      expect((r.stdout || '').trim(), args.join(' ')).not.toBe('ok'); // Not run as an encoded command.
      expectUnreadable(`powershell ${args.join(' ')}`);
    }
    // The switches read without a value: the encoded command after them runs.
    const r = spawnSync('powershell.exe', ['-NoLogo', '-nop', '-noni', '-Sta', '-enc', B64], { encoding: 'utf8', timeout: 30000, input: '' });
    expect((r.stdout || '').trim()).toMatch(/(^|\n)ok($|\n)/);
    expectUnreadable(`powershell -NoLogo -nop -noni -Sta -enc ${B64}`);
  }, 120000);
});

describe('the hook header states the threat model', () => {
  const header = fs.readFileSync(HOOK, 'utf8').replace(/\r\n/g, '\n').split("const fs = require('fs');")[0];
  const outOfScope = header.split('THREAT MODEL').pop().split('HOW A COMMAND IS READ')[0];

  it.each([
    'ORDINARY mistakes', 'OUT OF SCOPE', 'Unicode lookalikes', 'brace expansion', 'eval', 'Invoke-Expression',
    '`git send-pack`', '`help.autocorrect`', 'alias', '`gh api`', 'npm script', 'remote.<name>.push',
  ])('lists %s', (item) => {
    expect(outOfScope).toContain(item);
  });

  it('documents the nested-shell refusal, the one-reading alwaysDeny and the output (H-58)', () => {
    expect(header).toMatch(/NESTED SHELLS \(H-52\)/);
    expect(header).toMatch(/with a flag on HEAD is\s+\/\/ refused/);
    const always = header.split('ALWAYS REFUSED (`alwaysDeny`').pop();
    expect(always).toMatch(/read\s+\/\/ once/);
    expect(always).toMatch(/`-command -` \/ `-c -`/);
    expect(header).toMatch(/Rule 6 \(output\): a block prints both the legacy `decision: "block"`/);
    expect(header).toMatch(/permissionDecision: "deny"/);
    expect(header).toMatch(/an allow prints nothing/);
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
