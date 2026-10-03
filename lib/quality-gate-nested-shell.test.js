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
            expectUnreadable(`${exe} -NoProfile ${prefix}${spelled}:${B64}`);
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
      `cmd /c"pwsh -e ${B64}"`,
      `cmd /s/cpwsh -e ${B64}`,
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
      'pwsh -Command -',
      'pwsh -Command:-',
      'pwsh -File:-',
    ]) expectUnreadable(command);
  });

  it('refuses standard input given by any input redirection or a |& pipe', () => {
    for (const command of [
      'powershell -NoProfile 0<s.ps1',
      'powershell -NoProfile 0< s.ps1',
      'powershell -NoProfile<s.ps1',
      '< s.ps1 powershell -NoProfile',
      '<s.ps1 pwsh',
      'pwsh -NoProfile << EOF\nGet-Date\nEOF',
      'pwsh -NoProfile <<< "Get-Date"',
      'pwsh -NoProfile < <(echo Get-Date)',
      'echo Get-Date |& pwsh -NoProfile',
      'cat s.ps1 | sudo pwsh',
      'bash -c "cat s.ps1 | pwsh"',
      "sh -lc 'pwsh < s.ps1'",
      'cmd /c "type s.ps1 | powershell -NoProfile"',
      'pwsh -Command "Get-Content s.ps1 | pwsh"',
    ]) expectUnreadable(command);
  });

  it('reads the text whatever the layout: newlines after a pipe, groups, comments, nested shells', () => {
    for (const command of [
      'echo Get-Date |\npwsh -NoProfile',
      'echo Get-Date |\r\n  pwsh -NoProfile',
      'bash -c "echo Get-Date |\npwsh -NoProfile"',
      'pwsh -Command "Get-Content s.ps1 |\npwsh -NoProfile"',
      'echo Get-Date |\n# the script\npwsh -NoProfile',
      'echo Get-Date | (pwsh -NoProfile)',
      'echo Get-Date | { pwsh -NoProfile; }',
      '(pwsh -NoProfile) < s.ps1',
      '{ pwsh -NoProfile; } < s.ps1',
      'echo Get-Date | powershell -NoProfile powershell -NoProfile',
      'bash <<< "pwsh -e x"',
      'echo Get-Date |\u00A0pwsh',
      'echo Get-Date > >(pwsh -NoProfile)',
      'echo Get-Date | tee >(pwsh -NoProfile)',
      'coproc pwsh -NoProfile; echo Get-Date >&"${COPROC[1]}"',
      `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERS~1.EXE -e ${B64}`,
    ]) expectUnreadable(command);
  });

  it('reads the executable name with quotes and escape characters removed, and pwsh*/powershell* names', () => {
    for (const command of [
      `power''shell -e ${B64}`,
      `power""shell -e ${B64}`,
      `power\\shell -e ${B64}`,
      `power\`shell -e ${B64}`,
      `& power'shell' -e ${B64}`,
      `& \u2018pwsh\u2019 -e ${B64}`,
      `"pw"sh -e ${B64}`,
      `$'pwsh' -e ${B64}`,
      `$"pwsh" -e ${B64}`,
      `sudo $'pwsh' -NoProfile -e ${B64}`,
      `bash -c $'pwsh -enc ${B64}'`,
      `pwsh-preview -enc ${B64}`,
      `pwsh-preview.exe -enc ${B64}`,
      `powershell_ise.exe -e ${B64}`,
      `C:/tools/PWSH-7.4.EXE -e ${B64}`,
      `C:\\tools\\pwsh.exe -e ${B64}`,
      `FOO=1 pwsh -e ${B64}`,
      `SHELL=pwsh x -e ${B64}`,
      `sudo -u ci pwsh -e ${B64}`,
      `sudo -iu root pwsh -e ${B64}`,
      `env -i pwsh -e ${B64}`,
      `timeout 30 pwsh -e ${B64}`,
      `start "" pwsh -e ${B64}`,
      `start /D C:\\ pwsh -e ${B64}`,
      `wsl -d Ubuntu pwsh -e ${B64}`,
      `echo \`pwsh -e ${B64}\``,
      `x=$(pwsh -e ${B64})`,
      `(pwsh -e ${B64})`,
    ]) expectUnreadable(command);
    for (const command of ['pwshx -e x', 'mypwsh -e x', 'powershellx -e x', 'Get-Command pwsh-preview']) expectAllow(command);
  });

  it('reads a cmd caret as cmd does: removed', () => {
    for (const command of [
      `powershell^ -e ${B64}`,
      `powershell ^ -e ${B64}`,
      `powershell -NoProfile ^\n-enc ${B64}`,
      `cmd /c powershell^ -e^nc ${B64}`,
      `p^owershell -e ${B64}`,
    ]) expectUnreadable(command);
  });

  it('folds line continuations (\\, backtick, ^) inside the executable name or a parameter', () => {
    for (const cont of ['\\\n', '\\\r\n', '`\n', '`\r\n', '^\n', '^\r\n']) {
      for (const command of [
        `pw${cont}sh -enc ${B64}`,
        `power${cont}shell -NoProfile -e ${B64}`,
        `pwsh /${cont}enc ${B64}`,
        `pwsh -NoProfile /en${cont}codedcommand ${B64}`,
        `pw${cont}sh /${cont}enc ${B64}`,
      ]) expectUnreadable(command);
    }
  });

  it('reads the command again with expansions that may be empty removed', () => {
    // A `$name` is closed by a quote, as a letter after it would be part of the name.
    for (const expansion of ['$@', '$*', '$1', '$#', '${x}', '${EMPTY:-}', '$x""', "$EMPTY''", '%x%', '%EMPTY%']) {
      for (const command of [
        `pw${expansion}sh -enc ${B64}`,
        `power${expansion}shell -NoProfile -e ${B64}`,
        `pwsh /${expansion}enc ${B64}`,
        `pwsh -NoProfile /en${expansion}c ${B64}`,
        `p"${expansion}"wsh /"${expansion}"enc ${B64}`,
      ]) expectUnreadable(command);
    }
  });

  it('lets everyday PowerShell and commands without a PowerShell word through', () => {
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
    ]) expectAllow(command);
  });

  // The rule reads text, not structure, so these are refused on purpose: a
  // refusal costs a rephrase, a miss would be a hole. The message says how.
  const expectOverRefused = (command) => {
    expectUnreadable(command);
    const { reason } = classify(command, makeCtx());
    expect(reason, command).toMatch(/rerun it without the PowerShell text, or split it into separate commands/);
  };

  it('over-refuses search terms and messages that mention these PowerShell forms, with guidance', () => {
    for (const command of [
      'npx vitest run -t "powershell|pwsh"',
      'git grep -n "cmd|powershell" -- "*.js"',
      'Select-String -Pattern "bash|pwsh" -Path *.md',
      "rg 'pwsh|powershell' docs",
      'grep -E "x < powershell" notes.txt',
      'grep -n powershell -e foo README.md',
      'rg pwsh -e enc docs',
      'echo "never run powershell -enc"',
      'git commit -m "explain why pwsh -enc is refused"',
      'git log | grep -i powershell',
    ]) expectOverRefused(command);
  });

  it('over-refuses a later -e and an earlier pipeline, with guidance', () => {
    for (const command of [
      'powershell -NoProfile -File scripts/build.ps1 -e prod',
      'pwsh -NoProfile -Command "Write-Output -e"',
      'powershell -NoProfile Write-Output -e',
      'powershell -NoProfile -NonInteractive Write-Output -enc x',
      'pwsh -nop -noni ./build.ps1 -e prod',
      'npm test | tail -1; pwsh -File report.ps1',
      'echo hi | powershell -Command Write-Output $input',
    ]) expectOverRefused(command);
  });

  it('reads the trailing output plumbing in linear time (200 KB of blanks)', () => {
    for (const command of [
      `git status${' '.repeat(60 * 1024)}x`,
      `git status${' '.repeat(200 * 1024)}x`,
      `git status${' \t'.repeat(100 * 1024)}| tail -5 x`,
      ' '.repeat(200 * 1024),
    ]) {
      const started = Date.now();
      classify(command, makeCtx());
      expect(Date.now() - started, `${command.length} chars`).toBeLessThan(500);
    }
  });

  it('reads a 200 KB command crowded with PowerShell tokens, pipes and redirections in linear time', () => {
    for (const [command, refused] of [
      ['pwsh -a '.repeat(25 * 1024), false],
      ['pwsh '.repeat(40 * 1024), false],
      ['a/pwsh'.repeat(34 * 1024), false],
      ['0'.repeat(200 * 1024), false],
      [`${'1'.repeat(200 * 1024)} pwsh`, false],
      [`pwsh ${'| x '.repeat(50 * 1024)}`, false],
      [`${'x | '.repeat(50 * 1024)}pwsh`, true],
      [`pwsh ${'<'.repeat(200 * 1024)}`, true],
      [`pwsh -enc ${B64} `.repeat(4 * 1024), true],
    ]) {
      const started = Date.now();
      const verdict = classify(command, makeCtx());
      expect(Date.now() - started, `${command.slice(0, 20)}...`).toBeLessThan(500);
      expect(verdict.reason === undefined ? false : /PowerShell script/.test(verdict.reason), command.slice(0, 20)).toBe(refused);
    }
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

describe('the hook header lists what it does not read', () => {
  const header = fs.readFileSync(HOOK, 'utf8').replace(/\r\n/g, '\n').split("const fs = require('fs');")[0];
  it.each([
    'Invoke-Expression', '`iex`', '`Start-Process`', '`& { ... }`', '`-File <path>`',
    '`node -e`', '`python -c`', '`eval`', '`source`', '`. <file>`', '`xargs`', '`find -exec`',
    'an alias or a', 'function', 'environment variable',
    '`Start-Process -ArgumentList`', '`ssh`', '`docker exec`', 'character-code escapes', 'brace expansion',
    'assembled from variables or read from a file',
  ])('%s', (item) => {
    const nothingSection = header.split('Nothing here can see through').pop();
    expect(nothingSection).toContain(item);
  });

  it('documents the nested-shell refusal and alwaysDeny as an over-refusing text rule', () => {
    expect(header).toMatch(/NESTED SHELLS \(H-52\)/);
    expect(header).toMatch(/ALWAYS REFUSED \(`alwaysDeny`/);
    expect(header).toMatch(/with a flag on\s+\/\/ HEAD is refused/);
    const always = header.split('ALWAYS REFUSED (`alwaysDeny`').pop().split('Nothing here can see through')[0];
    expect(always).toMatch(/TEXT RULE, not a\s+\/\/ parse/);
    expect(always).toMatch(/over-refuses on purpose/);
    expect(always).toMatch(/Rerun such a command without the\s+\/\/ PowerShell text, or split it into separate commands/);
    for (const item of ['character-code escapes', 'brace expansion', '`Start-Process -ArgumentList`', '`ssh`', '`docker exec`', 'assembled']) {
      expect(always).toContain(item);
    }
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
