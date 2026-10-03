'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { PACKAGE_ROOT, SKILL_SCOPE, copyDirSync } = require('./utils');
const { resolveInitChoices } = require('./init');

const CLI = path.join(PACKAGE_ROOT, 'bin', 'cli.js');

function runInit(cwd, args) {
  // stdin is a pipe (not a TTY), as in CI / when an AI agent runs init.
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: 120000,
  });
}

describe('resolveInitChoices (H-54)', () => {
  it('uses defaults with --yes and never leaves a field to prompt', () => {
    const c = resolveInitChoices({ yes: true }, { isTTY: false, cwd: path.join('x', 'my-app') });
    expect(c.projectName).toBe('my-app');
    expect(c.tools).toEqual(['claude-code']);
    expect(c.skillChoice).toBe(SKILL_SCOPE.ALL);
    expect(Array.isArray(c.stacks)).toBe(true);
  });

  it('accepts all flags without --yes when not a TTY', () => {
    const c = resolveInitChoices(
      { projectName: 'p', tools: 'claude-code,codex', skills: 'superpowers' },
      { isTTY: false }
    );
    expect(c.tools).toEqual(['claude-code', 'codex']);
    expect(c.skillChoice).toBe(SKILL_SCOPE.SUPERPOWERS_ONLY);
  });

  it('errors without a TTY when project name / tools are missing', () => {
    expect(() => resolveInitChoices({ tools: 'codex' }, { isTTY: false })).toThrow(/--project-name/);
    expect(() => resolveInitChoices({ projectName: 'p' }, { isTTY: false })).toThrow(/--tools/);
  });

  it('leaves fields to the prompter on a TTY without --yes', () => {
    const c = resolveInitChoices({}, { isTTY: true });
    expect(c.projectName).toBeUndefined();
    expect(c.tools).toBeUndefined();
  });

  it('rejects unknown tool / skill / stack values', () => {
    const base = { projectName: 'p', tools: 'codex' };
    expect(() => resolveInitChoices({ ...base, tools: 'vim' }, { isTTY: false })).toThrow(/Unknown tool/);
    expect(() => resolveInitChoices({ ...base, skills: 'nope' }, { isTTY: false })).toThrow(/Unknown skill/);
    expect(() => resolveInitChoices({ ...base, stacks: 'nope' }, { isTTY: false })).toThrow(/Unknown stack/);
  });
});

describe('init CLI non-interactive and re-init (H-54, H-53)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-ni-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('completes with all options given and no TTY', () => {
    const r = runInit(dir, ['--project-name', 'demo', '--tools', 'claude-code', '--skills', 'project']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain('demo');
  });

  it('exits 1 when a required option is missing and no TTY', () => {
    const r = runInit(dir, ['--project-name', 'demo']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/--tools/);
  });

  it('--yes completes with defaults (project name = directory name)', () => {
    const r = runInit(dir, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(path.basename(dir));
  });

  it('re-init keeps edited files and writes <file>.ai-dev-helm-new instead', () => {
    const args = ['--yes', '--skills', 'project'];
    expect(runInit(dir, args).status).toBe(0);

    const edited = path.join(dir, 'skills', 'project');
    const skillDir = fs.readdirSync(edited).find((n) => fs.existsSync(path.join(edited, n, 'SKILL.md')));
    const target = path.join(edited, skillDir, 'SKILL.md');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, original + '\nLOCAL EDIT\n');

    const r = runInit(dir, args);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain('LOCAL EDIT');
    expect(fs.readFileSync(target + '.ai-dev-helm-new', 'utf8')).toBe(original);
    expect(r.stdout).toMatch(/ACTION REQUIRED: 1 file/);

    // A third run with an unedited tree produces no further kept files.
    fs.writeFileSync(target, original);
    fs.rmSync(target + '.ai-dev-helm-new');
    const r3 = runInit(dir, args);
    expect(r3.stdout).not.toMatch(/ai-dev-helm-new/);
  });
});

describe('copyDirSync keep-local mode', () => {
  it('overwrites without `kept`, preserves with it, ignores CRLF-only differences', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-src-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dest-'));
    try {
      fs.writeFileSync(path.join(src, 'a.md'), 'new\nline\n');
      fs.writeFileSync(path.join(dest, 'a.md'), 'old\n');
      const kept = [];
      copyDirSync(src, dest, { kept });
      expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('old\n');
      expect(kept).toEqual([path.join(dest, 'a.md')]);

      fs.writeFileSync(path.join(dest, 'a.md'), 'new\r\nline\r\n');
      fs.rmSync(path.join(dest, 'a.md.ai-dev-helm-new'));
      const kept2 = [];
      copyDirSync(src, dest, { kept: kept2 });
      expect(kept2).toEqual([]);
      expect(fs.existsSync(path.join(dest, 'a.md.ai-dev-helm-new'))).toBe(false);

      copyDirSync(src, dest, {});
      expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('new\nline\n');
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
