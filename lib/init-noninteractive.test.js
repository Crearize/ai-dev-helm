'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { PACKAGE_ROOT, SKILL_SCOPE, copyDirSync, contentHash, NEW_SUFFIX } = require('./utils');
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

  const ARGS = ['--yes', '--stacks', 'nextjs-react'];
  const NEW = '.ai-dev-helm-new';
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, '.ai-dev-helm.json'), 'utf8'));
  const firstFile = (root) => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    return walk(path.join(dir, root)).filter((f) => !f.endsWith(NEW)).sort()[0];
  };

  it('records hashes of adopter-editable files and ignores *.ai-dev-helm-new in git', () => {
    expect(runInit(dir, ARGS).status).toBe(0);
    const files = manifest().files;
    expect(Object.keys(files).some((k) => k.startsWith('.claude/rules/'))).toBe(true);
    expect(Object.keys(files).some((k) => k.startsWith('lint/'))).toBe(true);
    expect(Object.keys(files).some((k) => k.startsWith('skills/'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('*.ai-dev-helm-new');
  });

  it('edited editable file is preserved with a .new; reverting the edit removes the stale .new', () => {
    expect(runInit(dir, ARGS).status).toBe(0);
    const target = firstFile('.claude/rules');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, original + '\nLOCAL EDIT\n');

    const r = runInit(dir, ARGS);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain('LOCAL EDIT');
    expect(fs.readFileSync(target + NEW, 'utf8')).toBe(original);
    expect(r.stdout).toMatch(/ACTION REQUIRED: 1 file/);

    fs.writeFileSync(target, original);
    const r3 = runInit(dir, ARGS);
    expect(fs.existsSync(target + NEW)).toBe(false);
    expect(r3.stdout).not.toMatch(/ACTION REQUIRED/);
  });

  it('unedited editable file (hash matches the record) is refreshed from upstream', () => {
    expect(runInit(dir, ARGS).status).toBe(0);
    const target = firstFile('.claude/rules');
    const rel = path.relative(dir, target).split(path.sep).join('/');
    // Simulate an older release: the file holds the old content and the record matches it.
    const old = 'old upstream content\n';
    fs.writeFileSync(target, old);
    const m = manifest();
    m.files[rel] = contentHash(Buffer.from(old));
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify(m));

    const r = runInit(dir, ARGS);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).not.toBe(old);
    expect(fs.existsSync(target + NEW)).toBe(false);
    expect(manifest().files[rel]).not.toBe(m.files[rel]);
  });

  it('upgrade from 3.2.x (no manifest): harness-owned files overwritten, editable files get .new', () => {
    expect(runInit(dir, ARGS).status).toBe(0);
    const skillRoot = path.join(dir, 'skills', 'project');
    const skillName = fs.readdirSync(skillRoot).find((n) => fs.existsSync(path.join(skillRoot, n, 'SKILL.md')));
    const skill = path.join(skillRoot, skillName, 'SKILL.md');
    const upgrade = path.join(dir, 'documents', 'development', 'harness-upgrade.md');
    const prompt = path.join(dir, '.github', 'review-prompt.md');
    const rule = firstFile('.claude/rules');
    const lintFile = firstFile('lint/eslint');
    const owned = [skill, upgrade, prompt].map((f) => [f, fs.readFileSync(f, 'utf8')]);
    const ruleSrc = fs.readFileSync(rule, 'utf8');
    for (const [f] of owned) fs.writeFileSync(f, 'stale 3.2.1\n');
    fs.writeFileSync(skill + NEW, 'stale new\n');
    fs.writeFileSync(rule, 'stale 3.2.1\n');
    fs.writeFileSync(lintFile, 'stale 3.2.1\n');
    fs.rmSync(path.join(dir, '.ai-dev-helm.json'));

    const r = runInit(dir, ARGS);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const [f, original] of owned) expect(fs.readFileSync(f, 'utf8')).toBe(original);
    expect(fs.existsSync(skill + NEW)).toBe(false);
    expect(fs.readFileSync(rule, 'utf8')).toBe('stale 3.2.1\n');
    expect(fs.readFileSync(rule + NEW, 'utf8')).toBe(ruleSrc);
    expect(fs.existsSync(lintFile + NEW)).toBe(true);
    expect(r.stdout).toContain('.ai-dev-helm-new');
  });

  it('dry-run lists the files that would get a .new and writes nothing', () => {
    expect(runInit(dir, ARGS).status).toBe(0);
    const target = firstFile('.claude/rules');
    fs.writeFileSync(target, 'edited\n');
    const r = runInit(dir, [...ARGS, '--dry-run']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/would be kept/);
    expect(r.stdout).toContain(path.relative(dir, target) + NEW);
    expect(fs.existsSync(target + NEW)).toBe(false);
  });

  it('--yes with several stacks says that none were chosen', () => {
    const r = runInit(dir, ['--yes']);
    expect(r.stdout).toMatch(/stacks detected .*none chosen/);
  });
});

describe('copyDirSync policies', () => {
  const mk = () => [fs.mkdtempSync(path.join(os.tmpdir(), 'cd-src-')), fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dest-'))];

  it('overwrites harness-owned files and removes a stale .new', () => {
    const [src, dest] = mk();
    try {
      fs.writeFileSync(path.join(src, 'a.md'), 'new\n');
      fs.writeFileSync(path.join(dest, 'a.md'), 'old\n');
      fs.writeFileSync(path.join(dest, 'a.md' + NEW_SUFFIX), 'x');
      copyDirSync(src, dest, {});
      expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('new\n');
      expect(fs.existsSync(path.join(dest, 'a.md' + NEW_SUFFIX))).toBe(false);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('protect: keeps unrecorded edits, ignores CRLF/BOM-only differences', () => {
    const [src, dest] = mk();
    try {
      fs.writeFileSync(path.join(src, 'a.md'), 'new\nline\n');
      fs.writeFileSync(path.join(dest, 'a.md'), 'old\n');
      const kept = [];
      copyDirSync(src, dest, { protect: true, kept, records: {} });
      expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('old\n');
      expect(kept).toEqual([path.join(dest, 'a.md')]);

      fs.writeFileSync(path.join(dest, 'a.md'), '﻿new\r\nline\r\n');
      const kept2 = [];
      copyDirSync(src, dest, { protect: true, kept: kept2, records: {} });
      expect(kept2).toEqual([]);
      expect(fs.existsSync(path.join(dest, 'a.md' + NEW_SUFFIX))).toBe(false);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
