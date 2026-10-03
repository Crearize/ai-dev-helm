'use strict';

// codex-trust (H-52 / P10a item 2): a read-only check that Codex will run the
// project's hooks. Every Codex config here lives in a temp directory; nothing
// reads or writes a real ~/.codex or CODEX_HOME.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { checkCodexTrust, codexHookHash, resolveCodexHome } = require('./codex-trust');
const { setupRuntimeHooks } = require('./runtime-hooks');
const { upgradeCodexHooksFile } = require('./init');
const { PACKAGE_ROOT } = require('./utils');

const FIXTURE_320 = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'runtime-hooks', 'codex-hooks-3.2.0.json');
const cli = path.join(PACKAGE_ROOT, 'bin', 'cli.js');

// The hashes Codex 0.156.1 itself reported (app-server `hooks/list`,
// `currentHash`) for the registration init wrote in 3.2.0.
const CODEX_0_156_1_HASHES = {
  'pre_tool_use:0:0': 'sha256:8d79fff5d7c15b1473795fa464f4b202a81fa4e9ae36979a838182e1b15f65d0',
  'pre_tool_use:1:0': 'sha256:e293277161dccb683d41f5b03c2ae73273ea71e078907d640ce19465f8e17ce0',
  'post_tool_use:0:0': 'sha256:1b6a2d7c519fe80e33235555318393ab8b0cc5edff3815333e12754c384d7543',
};

let root;
let project;
let codexHome;
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-codex-trust-')));
  project = path.join(root, 'project');
  codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.mkdirSync(codexHome);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, stdio: 'ignore' });
  fs.copyFileSync(FIXTURE_320, path.join(project, '.codex', 'hooks.json'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const hooksJson = () => path.join(project, '.codex', 'hooks.json');
const tomlKey = (s) => JSON.stringify(s); // A TOML basic string accepts JSON's escapes.
const projectTrust = (dir = project) => `[projects.${tomlKey(dir)}]\ntrust_level = "trusted"\n`;
const hookState = (key, body) => `[hooks.state.${tomlKey(key)}]\n${body}\n`;
const allTrusted = (hooksPath = hooksJson()) => Object.entries(CODEX_0_156_1_HASHES)
  .map(([id, hash]) => hookState(`${hooksPath}:${id}`, `trusted_hash = "${hash}"`)).join('');
const writeConfig = (text) => fs.writeFileSync(path.join(codexHome, 'config.toml'), text);
const check = (over = {}) => checkCodexTrust({ projectDir: project, codexHome, ...over });
const text = (result) => result.lines.join('\n');

describe('codexHookHash', () => {
  it('reproduces the hashes Codex 0.156.1 reports for the 3.2.0 registration', () => {
    const { hooks } = JSON.parse(fs.readFileSync(FIXTURE_320, 'utf8'));
    for (const platform of ['win32', 'linux']) {
      expect(codexHookHash('PreToolUse', hooks.PreToolUse[0].matcher, hooks.PreToolUse[0].hooks[0], { platform }))
        .toBe(CODEX_0_156_1_HASHES['pre_tool_use:0:0']);
      expect(codexHookHash('PreToolUse', hooks.PreToolUse[1].matcher, hooks.PreToolUse[1].hooks[0], { platform }))
        .toBe(CODEX_0_156_1_HASHES['pre_tool_use:1:0']);
      expect(codexHookHash('PostToolUse', hooks.PostToolUse[0].matcher, hooks.PostToolUse[0].hooks[0], { platform }))
        .toBe(CODEX_0_156_1_HASHES['post_tool_use:0:0']);
    }
  });

  it('changes with the registration (matcher, command, timeout) but has no input for the script contents', () => {
    const base = { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 30 };
    const h = codexHookHash('PreToolUse', 'Bash', base);
    expect(codexHookHash('PreToolUse', '^Bash$', base)).not.toBe(h);
    expect(codexHookHash('PreToolUse', 'Bash', { ...base, command: `${base.command} ` })).not.toBe(h);
    expect(codexHookHash('PreToolUse', 'Bash', { ...base, timeout: 31 })).not.toBe(h);
    // Codex's own defaults: no timeout is 600 s, async false.
    expect(codexHookHash('PreToolUse', 'Bash', { ...base, timeout: undefined }))
      .toBe(codexHookHash('PreToolUse', 'Bash', { ...base, timeout: 600, async: false }));
  });

  it('reads only what it can read the way Codex does', () => {
    expect(codexHookHash('PreToolUse', 'Bash', { type: 'mcp_tool', server: 's', tool: 't' })).toBeNull();
    expect(codexHookHash('PreToolUse', 'Bash', { type: 'command', command: 'x', timeout: '30' })).toBeNull();
    expect(codexHookHash('NoSuchEvent', 'Bash', { type: 'command', command: 'x' })).toBeNull();
  });
});

describe('the 3.2.1 registration is the one 3.2.0 wrote (trust survives the update)', () => {
  // Codex ties trust to the registration, so 3.2.1 must write exactly what
  // 3.2.0 wrote. The fixture is the output of v3.2.0's setupRuntimeHooks on
  // v3.2.0's codex-hooks.json.template.
  it('a fresh init writes the same .codex/hooks.json as 3.2.0', () => {
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'templates', 'codex-hooks.json.template'), hooksJson());
    setupRuntimeHooks(project, 'codex');
    expect(JSON.parse(fs.readFileSync(hooksJson(), 'utf8'))).toEqual(JSON.parse(fs.readFileSync(FIXTURE_320, 'utf8')));
  });

  it('re-running init over a 3.2.0 install leaves .codex/hooks.json byte for byte', () => {
    const before = fs.readFileSync(hooksJson(), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(upgradeCodexHooksFile(hooksJson())).toBeFalsy();
      setupRuntimeHooks(project, 'codex');
    } finally {
      log.mockRestore();
    }
    expect(fs.readFileSync(hooksJson(), 'utf8')).toBe(before);
  });
});

describe('checkCodexTrust', () => {
  it('(i) no hooks.state entry: ACTION REQUIRED, not trusted', () => {
    writeConfig(projectTrust());
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/ACTION REQUIRED: Codex hooks are not trusted: .*pre_tool_use:0:0.*quality-gate\.cjs/);
    expect(text(result)).toMatch(/Result: ACTION REQUIRED/);
  });

  it('(ii) entries only for another hooks.json: ACTION REQUIRED', () => {
    writeConfig(projectTrust() + allTrusted(path.join(root, 'other', '.codex', 'hooks.json')));
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/Codex hooks are not trusted/);
  });

  it('(iii) the right entries with the current hashes: ok', () => {
    writeConfig(projectTrust() + allTrusted());
    const result = check();
    expect(result.exitCode, text(result)).toBe(0);
    expect(text(result)).toMatch(/trusted: pre_tool_use:0:0/);
    expect(text(result)).toMatch(/Result: ok/);
    expect(text(result)).not.toMatch(/ACTION REQUIRED/);
  });

  it('(iv) no project trust_level: ACTION REQUIRED even with the hooks trusted', () => {
    writeConfig(allTrusted());
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/ACTION REQUIRED: the project is not trusted/);
  });

  it('an untrusted project entry is ACTION REQUIRED too', () => {
    writeConfig(`[projects.${tomlKey(project)}]\ntrust_level = "untrusted"\n` + allTrusted());
    expect(check().exitCode).toBe(1);
  });

  it('a trusted_hash that no longer matches the registration is stale trust', () => {
    writeConfig(projectTrust() + allTrusted().replace(CODEX_0_156_1_HASHES['pre_tool_use:0:0'], `sha256:${'0'.repeat(64)}`));
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/ACTION REQUIRED: Codex hooks changed since trusted \(stale trust\): pre_tool_use:0:0/);
  });

  it('a disabled hook is ACTION REQUIRED', () => {
    writeConfig(projectTrust() + allTrusted() + hookState(`${hooksJson()}:pre_tool_use:2:0`, 'enabled = false'));
    fs.writeFileSync(hooksJson(), JSON.stringify({ hooks: { PreToolUse: [
      ...JSON.parse(fs.readFileSync(FIXTURE_320, 'utf8')).hooks.PreToolUse,
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node x.cjs' }] },
    ], PostToolUse: JSON.parse(fs.readFileSync(FIXTURE_320, 'utf8')).hooks.PostToolUse } }));
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/pre_tool_use:2:0 .* is disabled/);
  });

  it('a hook whose hash cannot be computed is not called trusted', () => {
    fs.writeFileSync(hooksJson(), JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 's', tool: 't' }] },
    ] } }));
    writeConfig(projectTrust() + hookState(`${hooksJson()}:pre_tool_use:0:0`, 'trusted_hash = "sha256:abc"'));
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/ACTION REQUIRED: Codex hooks have a trusted entry, but this check cannot compute their hash .* cannot be confirmed: pre_tool_use:0:0/);
    expect(text(result)).not.toMatch(/^trusted: /m);
    expect(text(result)).toMatch(/Result: ACTION REQUIRED/);
  });

  it('on Windows, matches the project without case, but hooks trusted under another case are ACTION REQUIRED', () => {
    const upper = (p) => p.toUpperCase();
    writeConfig(projectTrust(upper(project)) + allTrusted(upper(hooksJson())));
    const result = check({ platform: 'win32' });
    expect(result.exitCode, text(result)).toBe(1);
    expect(text(result)).toMatch(/project trust: trusted/);
    expect(text(result)).toMatch(/ACTION REQUIRED: Codex hooks are trusted only under another spelling of the path: pre_tool_use:0:0 .* as ".*HOOKS\.JSON"/);
    expect(text(result)).toMatch(/Launch Codex from exactly the recorded path, or open \/hooks from the current one and trust them again/);
    expect(text(result)).not.toMatch(/Result: ok/);
    if (process.platform !== 'win32') expect(check({ platform: 'linux' }).exitCode).toBe(1);
  });

  it('keys spelled with the other separator are ACTION REQUIRED (Codex does not fold separators)', () => {
    const flip = (p) => (p.includes('\\') ? p.replace(/\\/g, '/') : p.replace(/\//g, '\\'));
    writeConfig(projectTrust(flip(project)) + allTrusted(flip(hooksJson())));
    const result = check({ platform: 'win32' });
    expect(result.exitCode, text(result)).toBe(1);
    expect(text(result)).toContain(`the project is trusted only under the spelling "${flip(project)}"`);
    expect(text(result)).toMatch(/Codex hooks are trusted only under another spelling/);
  });

  it('looks project trust up in Codex order (the project directory before the repository root), not file order', () => {
    const pkg = path.join(project, 'pkg');
    fs.mkdirSync(path.join(pkg, '.codex'), { recursive: true });
    fs.copyFileSync(FIXTURE_320, path.join(pkg, '.codex', 'hooks.json'));
    const pkgHooks = path.join(pkg, '.codex', 'hooks.json');
    writeConfig(`[projects.${tomlKey(project)}]\ntrust_level = "untrusted"\n${projectTrust(pkg)}${allTrusted(pkgHooks)}`);
    const result = checkCodexTrust({ projectDir: pkg, codexHome });
    expect(result.exitCode, text(result)).toBe(0);
    expect(text(result)).toContain(`project trust: trusted ("${pkg}")`);
  });

  it('passes over a project entry without trust_level, as Codex does', () => {
    const pkg = path.join(project, 'pkg');
    fs.mkdirSync(path.join(pkg, '.codex'), { recursive: true });
    fs.copyFileSync(FIXTURE_320, path.join(pkg, '.codex', 'hooks.json'));
    writeConfig(`[projects.${tomlKey(pkg)}]\nnote = "no trust level"\n${projectTrust()}${allTrusted(path.join(pkg, '.codex', 'hooks.json'))}`);
    const result = checkCodexTrust({ projectDir: pkg, codexHome });
    expect(result.exitCode, text(result)).toBe(0);
    expect(text(result)).toContain(`project trust: trusted ("${project}")`);
    // With no other entry, the project is not trusted (not "trust_level undefined").
    writeConfig(`[projects.${tomlKey(project)}]\nnote = "no trust level"\n${allTrusted()}`);
    const alone = check();
    expect(alone.exitCode).toBe(1);
    expect(text(alone)).toMatch(/ACTION REQUIRED: the project is not trusted/);
  });

  // A --dir spelled in another case resolves to the same directory on a
  // case-insensitive file system, but Codex keys trust by the spelling it is
  // started from: exit 1, the safe side.
  const caseInsensitiveFs = fs.existsSync(os.tmpdir().toUpperCase()) && fs.existsSync(os.tmpdir().toLowerCase());
  it.runIf(caseInsensitiveFs)('a --dir spelled in another case than the recorded keys is ACTION REQUIRED', () => {
    writeConfig(projectTrust() + allTrusted());
    expect(check().exitCode).toBe(0);
    const result = checkCodexTrust({ projectDir: project.toUpperCase(), codexHome });
    expect(result.exitCode, text(result)).toBe(1);
    expect(text(result)).toMatch(/trusted only under another spelling of the path|spelled differently from the path given/);
    expect(text(result)).not.toMatch(/Result: ok/);
  });

  it('a config.toml with a byte order mark is read (exit 0)', () => {
    writeConfig(`﻿${projectTrust()}${allTrusted()}`);
    const result = check();
    expect(result.exitCode, text(result)).toBe(0);
  });

  it('reads only: the config and hooks.json are unchanged', () => {
    const config = projectTrust() + allTrusted();
    writeConfig(config);
    const configFile = path.join(codexHome, 'config.toml');
    const before = [fs.statSync(configFile).mtimeMs, fs.statSync(hooksJson()).mtimeMs, fs.readFileSync(hooksJson(), 'utf8')];
    check();
    check({ platform: 'win32' });
    expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
    expect([fs.statSync(configFile).mtimeMs, fs.statSync(hooksJson()).mtimeMs, fs.readFileSync(hooksJson(), 'utf8')]).toEqual(before);
    expect(fs.readdirSync(codexHome)).toEqual(['config.toml']);
  });

  it('reports an unknown event as a note and an unknown top-level key as ACTION REQUIRED', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_320, 'utf8'));
    writeConfig(projectTrust() + allTrusted());
    fs.writeFileSync(hooksJson(), JSON.stringify({ description: 'x', hooks: { ...fixture.hooks, OnSomething: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
    const unknownEvent = check();
    expect(unknownEvent.exitCode, text(unknownEvent)).toBe(0);
    expect(text(unknownEvent)).toMatch(/note: unknown event "OnSomething" in hooks.json: Codex ignores it/);
    fs.writeFileSync(hooksJson(), JSON.stringify({ ...fixture, version: 1 }));
    const unknownKey = check();
    expect(unknownKey.exitCode).toBe(1);
    expect(text(unknownKey)).toMatch(/ACTION REQUIRED: Codex cannot load .*hooks\.json \(unknown top-level key "version"/);
    fs.writeFileSync(hooksJson(), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'shell', command: 'x' }] }] } }));
    expect(text(check())).toMatch(/PreToolUse\[0\]\.hooks\[0\] has an unknown type "shell"/);
  });

  it('a hooks.json with a byte order mark is ACTION REQUIRED (Codex cannot parse it)', () => {
    writeConfig(projectTrust() + allTrusted());
    fs.writeFileSync(hooksJson(), `﻿${fs.readFileSync(FIXTURE_320, 'utf8')}`);
    const result = check();
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/starts with a byte order mark \(BOM\)\. Codex cannot parse it/);
  });

  it('a hooks.json syntax error is exit 2 with its kind and position only, never the file text', () => {
    writeConfig(projectTrust());
    fs.writeFileSync(hooksJson(), '{"hooks": {"token": "sk-secret-value" oops}}');
    const result = check();
    expect(result.exitCode).toBe(2);
    expect(text(result)).toMatch(/UNREADABLE: could not read the project hooks: .*hooks\.json \(SyntaxError at (line \d+ column \d+|position \d+)\)/);
    expect(text(result)).not.toMatch(/sk-secret-value|oops/);
  });

  it('exit 2 for a config.toml that is a directory and for files over 1 MB', () => {
    fs.mkdirSync(path.join(codexHome, 'config.toml'));
    const dir = check();
    expect(dir.exitCode).toBe(2);
    expect(text(dir)).toMatch(/config\.toml \(it is a directory\)/);
    fs.rmdirSync(path.join(codexHome, 'config.toml'));
    writeConfig(projectTrust() + allTrusted());
    fs.writeFileSync(hooksJson(), `${JSON.stringify(JSON.parse(fs.readFileSync(FIXTURE_320, 'utf8')))}${' '.repeat(1024 * 1024)}`);
    const big = check();
    expect(big.exitCode).toBe(2);
    expect(text(big)).toMatch(/larger than 1 MB, not read/);
  });

  it('a TOML 1.0 array of mixed types is exit 2 (read as TOML 0.5, the safe side)', () => {
    writeConfig(`mixed = [1, "a"]\n${projectTrust()}${allTrusted()}`);
    const result = check();
    expect(result.exitCode).toBe(2);
    expect(text(result)).toMatch(/TOML 1\.0 allows arrays of mixed types/);
  });
});

describe('a linked git worktree (Codex reads the main checkout hooks.json)', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'ignore' });
  let worktree;
  beforeEach(() => {
    git(project, 'add', '.codex/hooks.json');
    git(project, 'commit', '-q', '-m', 'hooks');
    worktree = path.join(root, 'wt');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'wt');
    worktree = fs.realpathSync.native(worktree);
    // The worktree's own copy differs: a check that read it would see stale trust.
    const wtHooks = JSON.parse(fs.readFileSync(path.join(worktree, '.codex', 'hooks.json'), 'utf8'));
    wtHooks.hooks.PreToolUse[0].hooks[0].timeout = 99;
    fs.writeFileSync(path.join(worktree, '.codex', 'hooks.json'), JSON.stringify(wtHooks));
  });

  it('reads and keys trust by the main checkout path, and says which hooks.json it read', () => {
    writeConfig(projectTrust() + allTrusted());
    const result = checkCodexTrust({ projectDir: worktree, codexHome });
    expect(result.exitCode, text(result)).toBe(0);
    expect(text(result)).toContain(`Hooks: ${hooksJson()}`);
    expect(text(result)).toMatch(/linked git worktree, so Codex reads the main checkout's hooks\.json above/);
    expect(text(result)).toContain(`project trust: trusted ("${project}")`);
  });

  it('maps a subdirectory of the worktree to the same subdirectory of the main checkout', () => {
    const mainPkgHooks = path.join(project, 'pkg', '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(mainPkgHooks), { recursive: true });
    fs.copyFileSync(FIXTURE_320, mainPkgHooks);
    git(project, 'add', 'pkg/.codex/hooks.json');
    git(project, 'commit', '-q', '-m', 'pkg hooks');
    git(worktree, 'merge', '-q', 'main');
    writeConfig(projectTrust() + allTrusted(mainPkgHooks));
    const result = checkCodexTrust({ projectDir: path.join(worktree, 'pkg'), codexHome });
    expect(result.exitCode, text(result)).toBe(0);
    expect(text(result)).toContain(`Hooks: ${mainPkgHooks}`);
    expect(text(result)).toContain(`project trust: trusted ("${project}")`);
  });

  it('a main-checkout hooks.json with a byte order mark is ACTION REQUIRED from the worktree too', () => {
    writeConfig(projectTrust() + allTrusted());
    fs.writeFileSync(hooksJson(), `﻿${fs.readFileSync(FIXTURE_320, 'utf8')}`);
    const result = checkCodexTrust({ projectDir: worktree, codexHome });
    expect(result.exitCode, text(result)).toBe(1);
    expect(text(result)).toContain(`${hooksJson()} starts with a byte order mark (BOM)`);
  });

  it('trust recorded under the worktree path does not count', () => {
    writeConfig(projectTrust() + allTrusted(path.join(worktree, '.codex', 'hooks.json')));
    const result = checkCodexTrust({ projectDir: worktree, codexHome });
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/Codex hooks are not trusted/);
  });

  it('is ACTION REQUIRED when the worktree has no .codex/ (Codex then loads no project hooks)', () => {
    writeConfig(projectTrust() + allTrusted());
    fs.rmSync(path.join(worktree, '.codex'), { recursive: true, force: true });
    const result = checkCodexTrust({ projectDir: worktree, codexHome });
    expect(result.exitCode).toBe(1);
    expect(text(result)).toMatch(/does not exist in this worktree/);
  });

  it('exit 2 with the attempted path when config.toml or hooks.json is unreadable', () => {
    const missing = check();
    expect(missing.exitCode).toBe(2);
    expect(text(missing)).toContain(path.join(codexHome, 'config.toml'));
    writeConfig('this is = = not toml');
    expect(check().exitCode).toBe(2);
    writeConfig(projectTrust());
    fs.writeFileSync(hooksJson(), '{');
    const badHooks = check();
    expect(badHooks.exitCode).toBe(2);
    expect(text(badHooks)).toContain(hooksJson());
  });
});

describe('where the Codex config is read from (M1)', () => {
  it('--codex-home > CODEX_HOME > ~/.codex, with USERPROFILE on Windows and HOME elsewhere', () => {
    const env = { CODEX_HOME: path.join(root, 'env-home'), HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'u') };
    expect(resolveCodexHome({ codexHome: codexHome, env })).toEqual({ dir: codexHome, source: '--codex-home' });
    expect(resolveCodexHome({ env })).toEqual({ dir: env.CODEX_HOME, source: 'CODEX_HOME' });
    expect(resolveCodexHome({ env: { HOME: env.HOME, USERPROFILE: env.USERPROFILE }, platform: 'win32' }).dir).toBe(path.join(env.USERPROFILE, '.codex'));
    expect(resolveCodexHome({ env: { HOME: env.HOME, USERPROFILE: env.USERPROFILE }, platform: 'linux' }).dir).toBe(path.join(env.HOME, '.codex'));
  });

  // The CLI runs with HOME / USERPROFILE pointed at a temp directory and
  // CODEX_HOME removed, so the real ~/.codex is never read.
  const runCli = (args, envOver) => {
    const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), ...envOver };
    delete env.CODEX_HOME;
    if (envOver && envOver.CODEX_HOME) env.CODEX_HOME = envOver.CODEX_HOME;
    return spawnSync(process.execPath, [cli, 'codex-trust', '--dir', project, ...args], { env, encoding: 'utf8', timeout: 30000 });
  };

  it('with neither --codex-home nor CODEX_HOME: reads ~/.codex, prints the path and the --codex-home note', () => {
    const defaultHome = path.join(root, 'home', '.codex');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.writeFileSync(path.join(defaultHome, 'config.toml'), projectTrust() + allTrusted());
    const result = runCli([]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Codex config read: ${path.join(defaultHome, 'config.toml')}`);
    expect(result.stdout).toMatch(/pass it with --codex-home/);
  });

  it('an empty --codex-home is an error (exit 2), not a fall back to CODEX_HOME or ~/.codex', () => {
    expect(resolveCodexHome({ codexHome: '', env: { CODEX_HOME: codexHome } }).error).toMatch(/empty path/);
    const defaultHome = path.join(root, 'home', '.codex');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.writeFileSync(path.join(defaultHome, 'config.toml'), projectTrust() + allTrusted());
    writeConfig(projectTrust() + allTrusted());
    for (const envOver of [undefined, { CODEX_HOME: codexHome }]) {
      for (const args of [['--codex-home', ''], ['--codex-home='], ['--codex-home', '   '], ['--codex-home']]) {
        const result = runCli(args, envOver);
        expect(result.status, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(2);
        expect(result.stdout).toMatch(/UNREADABLE: --codex-home was given an empty path/);
        expect(result.stdout).not.toMatch(/Codex config read/);
      }
    }
  });

  it('--codex-home wins over CODEX_HOME, and a missing config.toml exits 2 naming the path', () => {
    writeConfig(projectTrust() + allTrusted());
    const envHome = path.join(root, 'env-home');
    const viaFlag = runCli(['--codex-home', codexHome], { CODEX_HOME: envHome });
    expect(viaFlag.status, viaFlag.stdout).toBe(0);
    expect(viaFlag.stdout).toContain(path.join(codexHome, 'config.toml'));
    expect(viaFlag.stdout).not.toMatch(/pass it with --codex-home/);
    const viaEnv = runCli([], { CODEX_HOME: envHome });
    expect(viaEnv.status).toBe(2);
    expect(viaEnv.stdout).toContain(path.join(envHome, 'config.toml'));
  });
});

describe('hook-trust guidance (P10a item 1)', () => {
  const runInit = (tools) => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') };
    delete env.CODEX_HOME;
    return spawnSync(process.execPath, [cli, 'init', '--project-name', 'Probe', '--tools', tools, '--skills', 'all'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  };

  it('init with Codex ends with the trust guidance and the codex-trust check', () => {
    const result = runInit('codex');
    expect(result.status, result.stderr).toBe(0);
    const tail = result.stdout.slice(result.stdout.indexOf('Setup complete!'));
    expect(tail).toMatch(/ACTION REQUIRED \(Codex\): quality-gate and review-budget do not run until you trust/);
    expect(tail).toMatch(/Trust them again whenever hooks\.json changes/);
    expect(tail).toMatch(/per Codex config location \(CODEX_HOME\)/);
    expect(tail).toMatch(/codex-trust --dir \./);
  }, 60000);

  it('init without Codex does not print it', () => {
    const result = runInit('claude-code');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/ACTION REQUIRED \(Codex\)/);
  }, 60000);

  it('harness-runtime, harness-upgrade and the AGENTS.md template carry it', () => {
    const read = (...p) => fs.readFileSync(path.join(PACKAGE_ROOT, ...p), 'utf8');
    for (const doc of [read('shared', 'documents', 'harness-runtime.md'), read('shared', 'documents', 'harness-upgrade.md')]) {
      expect(doc).toMatch(/`\/hooks` で `\.codex\/hooks\.json` のフックを信頼するまで、quality-gate も review-budget も動かない（警告も出ない）/);
      expect(doc).toMatch(/再び信頼する/);
      expect(doc).toMatch(/orca のアカウントの切り替えなど/);
      expect(doc).toMatch(/codex-trust --dir/);
    }
    const agents = read('templates', 'AGENTS.md.template');
    expect(agents).toMatch(/\*\*Hook trust \(Codex\)\*\*/);
    expect(agents).toMatch(/Trust them again after any change to `hooks\.json`/);
    expect(agents).toMatch(/per Codex config location \(`CODEX_HOME`\)/);
    expect(agents).toMatch(/codex-trust --dir/);
  });
});

test('isOutside: a directory named "..cache" is inside, only ".." segments escape', () => {
  const { isOutside } = require('./codex-trust');
  expect(isOutside('..')).toBe(true);
  expect(isOutside(['..', 'x'].join(path.sep))).toBe(true);
  expect(isOutside('..cache')).toBe(false);
  expect(isOutside(['..cache', 'pkg'].join(path.sep))).toBe(false);
});
