'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const shipped = path.join(root, 'skills/superpowers');
const patches = path.join(root, 'scripts/skill-patches');
let workspace;
let upstream;

function bash(args, options = {}) {
  return spawnSync('bash', args, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : file.endsWith('.md') ? [file] : [];
  });
}

function transform(source, destination) {
  return bash(['scripts/transform-skills.sh', source.replaceAll('\\', '/'), destination.replaceAll('\\', '/')]);
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-skill-transform-'));
  upstream = path.join(workspace, 'upstream');
  fs.cpSync(shipped, upstream, { recursive: true });
  // Reverse the shipped policy to reconstruct the transformed upstream fixture.
  // This remains independent of the installed user's plugin and network access.
  for (const name of fs.readdirSync(patches).filter((name) => name.endsWith('.patch')).sort().reverse()) {
    const result = bash(['-c', 'patch --batch --fuzz=0 --reverse -p1 -d "$1" < "$2"', '--', upstream.replaceAll('\\', '/'), path.join(patches, name).replaceAll('\\', '/')]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  for (const file of markdownFiles(upstream)) {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('skills/superpowers/', 'skills/').replaceAll('\r\n', '\n'));
  }
}, 120000);

afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

test('sync reproduces the shipped policy and reapplies it on subsequent syncs', () => {
  const destination = path.join(workspace, 'reproduced');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = transform(upstream, destination);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Applied policy patch: 001-proportional-workflow.patch');
    for (const original of markdownFiles(shipped)) {
      const relative = path.relative(shipped, original);
      expect(fs.readFileSync(path.join(destination, relative), 'utf8').replaceAll('\r\n', '\n'), relative)
        .toBe(fs.readFileSync(original, 'utf8').replaceAll('\r\n', '\n'));
    }
    expect(fs.existsSync(path.join(destination, 'subagent-driven-development/scripts/task-brief'))).toBe(true);
  }
}, 120000);

test('conflicting upstream instructions stop sync with the rejected patch name', () => {
  const source = path.join(workspace, 'drift');
  fs.cpSync(upstream, source, { recursive: true });
  const skill = path.join(source, 'using-superpowers/SKILL.md');
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('even a 1% chance', 'any conceivable chance'));
  const result = transform(source, path.join(workspace, 'drift-output'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Harness skill patch failed: 001-proportional-workflow.patch');
  expect(result.stdout).not.toContain('Done. Transformed');
}, 120000);

test('missing required upstream skills stop sync rather than retaining a stale copy', () => {
  const source = path.join(workspace, 'missing');
  fs.cpSync(upstream, source, { recursive: true });
  fs.rmSync(path.join(source, 'brainstorming'), { recursive: true });
  const result = transform(source, path.join(workspace, 'missing-output'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Required upstream skill not found: brainstorming');
});
