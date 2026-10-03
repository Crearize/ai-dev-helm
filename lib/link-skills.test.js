const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { linkSkills, inspectSkillLink } = require('./link-skills');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-link-skills-'));
  fs.mkdirSync(path.join(dir, 'skills', 'project', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'project', 'x', 'SKILL.md'), 'skill');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('creates the missing link (junction on Windows, symlink elsewhere) that resolves to skills/', () => {
  const r = linkSkills({ dir, tools: ['claude'] });
  expect(r.results[0].status).toBe('created');
  expect(r.exitCode).toBe(0);
  expect(inspectSkillLink(path.join(dir, '.claude', 'skills'))).toBe('link');
  expect(fs.readFileSync(path.join(dir, '.claude', 'skills', 'project', 'x', 'SKILL.md'), 'utf8')).toBe('skill');
  expect(linkSkills({ dir, tools: ['claude'] }).results[0].status).toBe('link'); // idempotent
});

test('defaults to the runtimes present, else Claude Code', () => {
  fs.mkdirSync(path.join(dir, '.codex'));
  expect(linkSkills({ dir }).results.map(r => r.tool)).toEqual(['codex']);
  fs.rmSync(path.join(dir, '.codex'), { recursive: true });
  expect(linkSkills({ dir }).results.map(r => r.tool)).toEqual(['claude']);
});

test('leaves a real directory (copied install) untouched and reports it', () => {
  fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'local.md'), 'mine');
  const r = linkSkills({ dir, tools: ['claude'] });
  expect(r.results[0].status).toBe('directory');
  expect(r.lines[0]).toContain('real directory');
  expect(fs.readFileSync(path.join(dir, '.claude', 'skills', 'local.md'), 'utf8')).toBe('mine');
});

test('dry-run writes nothing', () => {
  const r = linkSkills({ dir, tools: ['claude', 'cursor'], dryRun: true });
  expect(r.results.map(x => x.status)).toEqual(['would_create', 'would_create']);
  expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false);
});

test('repairs a dangling link without touching its former target', () => {
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(gone);
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.symlinkSync(gone, path.join(dir, '.claude', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.rmSync(gone, { recursive: true });
  expect(inspectSkillLink(path.join(dir, '.claude', 'skills'))).toBe('broken_link');
  expect(linkSkills({ dir, tools: ['claude'] }).results[0].status).toBe('created');
  expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'project', 'x', 'SKILL.md'))).toBe(true);
});

test('reports and fails when skills/ is missing; rejects unknown tools', () => {
  fs.rmSync(path.join(dir, 'skills'), { recursive: true });
  const r = linkSkills({ dir, tools: ['claude'] });
  expect(r.results[0].status).toBe('no_source');
  expect(r.exitCode).toBe(1);
  expect(() => linkSkills({ dir, tools: ['vim'] })).toThrow(/unknown tool/);
});

test('CLI: link-skills works and --version shows the CLI version, not the project package.json', () => {
  const run = spawnSync(process.execPath, [CLI, 'link-skills', '--dir', dir, '--tools', 'claude'], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('created');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","version":"0.1.0"}');
  const v = spawnSync(process.execPath, [CLI, '--version'], { cwd: dir, encoding: 'utf8' });
  expect(v.stdout.trim()).toBe(require('../package.json').version);
});

test('docs: README and worktree-parallel tell users to run link-skills; worktree-parallel has the Windows removal steps (H-30, H-35)', () => {
  const root = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'skills', 'project', 'worktree-parallel', 'SKILL.md'), 'utf8');
  expect(readme).toContain('link-skills');
  expect(skill).toContain('link-skills');
  expect(skill).toContain('core.longpaths true');
  expect(skill).toContain('rmdir /s /q');
  expect(skill).toContain('git worktree prune');
});

test('recreates a link that points at another project (moved/copied install)', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-link-other-'));
  try {
    fs.mkdirSync(path.join(other, 'skills'));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.symlinkSync(path.join(other, 'skills'), path.join(dir, '.claude', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    const source = path.join(dir, 'skills');
    expect(inspectSkillLink(path.join(dir, '.claude', 'skills'), source)).toBe('stale_link');
    expect(linkSkills({ dir, tools: ['claude'], dryRun: true }).results[0].status).toBe('would_create');
    expect(linkSkills({ dir, tools: ['claude'] }).results[0].status).toBe('created');
    expect(fs.realpathSync(path.join(dir, '.claude', 'skills'))).toBe(fs.realpathSync(source));
    expect(fs.existsSync(path.join(other, 'skills'))).toBe(true); // former target untouched
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('a plain file at <runtime>/skills is reported as its own state and kept', () => {
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'skills'), '../skills');
  const r = linkSkills({ dir, tools: ['claude'] });
  expect(r.results[0].status).toBe('not_directory');
  expect(r.lines[0]).toContain('neither a link nor a directory');
  expect(fs.readFileSync(path.join(dir, '.claude', 'skills'), 'utf8')).toBe('../skills');
});
