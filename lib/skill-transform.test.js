'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const shipped = path.join(root, 'skills/superpowers');
const overlays = path.join(root, 'scripts/skill-overlays');
const SKILLS = [
  'brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development',
  'systematic-debugging', 'dispatching-parallel-agents', 'subagent-driven-development',
  'verification-before-completion', 'finishing-a-development-branch', 'requesting-code-review',
  'receiving-code-review', 'using-git-worktrees', 'using-superpowers', 'writing-skills',
];
let workspace;
let upstream;
let overlayCopy;

const lf = (text) => text.replaceAll('\r\n', '\n');
const read = (file) => lf(fs.readFileSync(file, 'utf8'));
const posix = (file) => file.replaceAll(path.sep, '/');

function overlayFiles(directory = overlays) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? overlayFiles(file) : [file];
  }).filter((file) => !/(manifest\.json|README\.md)$/.test(file));
}

function run(args, env = {}) {
  return spawnSync('bash', args, { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });
}

function transform(source, destination, env = { HELM_SKILL_OVERLAY_DIR: overlayCopy }) {
  return run(['scripts/transform-skills.sh', posix(source), posix(destination)], env);
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-skill-transform-'));
  // Synthetic upstream: every skill has a SKILL.md, and every file an overlay
  // owns exists upstream (except files the harness adds), so the test needs
  // neither the network nor the real upstream release.
  upstream = path.join(workspace, 'upstream');
  for (const skill of SKILLS) {
    fs.mkdirSync(path.join(upstream, skill), { recursive: true });
    fs.writeFileSync(path.join(upstream, skill, 'SKILL.md'), `# ${skill}\nupstream text for skills/${skill}/ only\n`);
  }
  fs.mkdirSync(path.join(upstream, 'executing-plans/scripts'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'executing-plans/scripts/task-start'), 'upstream-only\n');
  fs.mkdirSync(path.join(upstream, 'using-superpowers/references'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'using-superpowers/references/muse-tools.md'), 'muse\n');
  fs.writeFileSync(path.join(upstream, 'writing-skills/anthropic-best-practices.md'), 'Haiku example\n');
  fs.writeFileSync(path.join(upstream, 'writing-skills/render-graphs.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(upstream, 'test-driven-development/extra.md'), 'unowned upstream file\n');
  for (const file of overlayFiles()) {
    const key = posix(path.relative(overlays, file)).replace(/\.prepend$/, '');
    const target = path.join(upstream, key);
    const manifest = JSON.parse(fs.readFileSync(path.join(overlays, 'manifest.json'), 'utf8'));
    if (manifest.files[key] !== null && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `upstream ${key}\n`);
    }
  }
  overlayCopy = path.join(workspace, 'overlays');
  fs.cpSync(overlays, overlayCopy, { recursive: true });
  const update = run(['-c', 'node scripts/apply-skill-overlays.js update "$1" 9.9.9', '--', posix(upstream)], { HELM_SKILL_OVERLAY_DIR: overlayCopy });
  expect(update.status, update.stdout + update.stderr).toBe(0);
}, 120000);

afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

test('sync applies the harness overlays, is repeatable, and keeps unowned upstream files', () => {
  const destination = path.join(workspace, 'reproduced');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = transform(upstream, destination);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Done. Transformed 14 skills.');
    for (const file of overlayFiles()) {
      const relative = posix(path.relative(overlays, file));
      if (relative.endsWith('.prepend')) {
        expect(read(path.join(destination, relative.replace(/\.prepend$/, '')))).toBe(read(file) + 'Haiku example\n');
      } else {
        expect(read(path.join(destination, relative)), relative).toBe(read(file));
      }
    }
    expect(read(path.join(destination, 'test-driven-development/extra.md'))).toBe('unowned upstream file\n');
    // Not shipped: upstream's native-execution scripts and the Muse mapping.
    expect(fs.existsSync(path.join(destination, 'executing-plans/scripts'))).toBe(false);
    expect(fs.existsSync(path.join(destination, 'using-superpowers/references/muse-tools.md'))).toBe(false);
    expect(fs.readdirSync(path.join(destination, 'using-superpowers')).some((name) => name.endsWith('.helm-sed-bak'))).toBe(false);
  }
}, 120000);

test('a changed upstream file under an overlay stops sync and names the file', () => {
  const source = path.join(workspace, 'drift');
  fs.cpSync(upstream, source, { recursive: true });
  fs.appendFileSync(path.join(source, 'brainstorming/SKILL.md'), 'new upstream rule\n');
  const result = transform(source, path.join(workspace, 'drift-output'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('brainstorming/SKILL.md: changed upstream');
  expect(result.stdout).not.toContain('Done. Transformed');
}, 120000);

test('an upstream file removed under an overlay stops sync', () => {
  const source = path.join(workspace, 'removed');
  fs.cpSync(upstream, source, { recursive: true });
  fs.rmSync(path.join(source, 'using-superpowers/references/claude-code-tools.md'), { force: true });
  fs.rmSync(path.join(source, 'writing-skills/anthropic-best-practices.md'));
  const result = transform(source, path.join(workspace, 'removed-output'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('writing-skills/anthropic-best-practices.md: removed upstream');
}, 120000);

test('missing required upstream skills stop sync rather than retaining a stale copy', () => {
  const source = path.join(workspace, 'missing');
  fs.cpSync(upstream, source, { recursive: true });
  fs.rmSync(path.join(source, 'brainstorming'), { recursive: true });
  const result = transform(source, path.join(workspace, 'missing-output'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Required upstream skill not found: brainstorming');
});

describe('shipped skills', () => {
  test('are the overlays on top of the recorded upstream version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(overlays, 'manifest.json'), 'utf8'));
    // The manifest records the upstream the overlays were written against; it may
    // trail .superpowers-version when a newer release left every owned file unchanged.
    expect(manifest.upstreamVersion).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+$/);
    for (const file of overlayFiles()) {
      const relative = posix(path.relative(overlays, file));
      const key = relative.replace(/\.prepend$/, '');
      expect(key in manifest.files, relative).toBe(true);
      const body = read(path.join(shipped, key));
      expect(relative.endsWith('.prepend') ? body.startsWith(read(file)) : body === read(file), relative).toBe(true);
    }
    expect(SKILLS.every((skill) => fs.existsSync(path.join(shipped, skill, 'SKILL.md')))).toBe(true);
  });

  test('carry the harness policy', () => {
    const text = (file) => read(path.join(shipped, file));
    const brainstorming = text('brainstorming/SKILL.md');
    expect(brainstorming).toContain('## Design Gate');
    expect(brainstorming).toContain('Request the design review');
    expect(brainstorming).toContain('Ask the user to review the design');
    expect(brainstorming).toContain('Create a task branch first');
    expect(brainstorming).toContain('not installed or not trusted');
    expect(brainstorming).not.toContain('such as Cursor only');
    expect(brainstorming).toContain('harness-runtime.md');
    expect(text('using-superpowers/SKILL.md')).toContain('already approved design');
    expect(text('writing-plans/SKILL.md')).toContain('node .claude/hooks/review-budget.cjs begin --phase plan');
    expect(text('writing-plans/SKILL.md')).toContain('Handoff integrity');
    expect(text('writing-plans/plan-document-reviewer-prompt.md')).not.toBe('');
    expect(text('finishing-a-development-branch/SKILL.md')).toContain('git push . HEAD:main');
    expect(text('using-superpowers/references/claude-code-tools.md')).toContain('harness-runtime.md');
    expect(text('writing-skills/anthropic-best-practices.md')).toContain('Read every Haiku example in the text below as Sonnet 5.5');
    expect(JSON.parse(text('writing-skills/package.json'))).toEqual({ type: 'module' });
    for (const file of ['brainstorming/SKILL.md', 'writing-plans/SKILL.md', 'executing-plans/SKILL.md']) {
      const body = text(file);
      expect(body, file).toContain('review-budget');
      expect(body, file).toContain('never ask the user to run commands, inspect state, or reset state');
      expect(body, file).toContain('extend');
    }
    expect(fs.existsSync(path.join(shipped, 'executing-plans/scripts'))).toBe(false);
    expect(fs.existsSync(path.join(shipped, 'using-superpowers/references/muse-tools.md'))).toBe(false);
  });
});
