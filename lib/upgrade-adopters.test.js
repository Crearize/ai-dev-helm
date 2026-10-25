'use strict';

// 3.7.0 (acceptance, 4g): the published 3.6.0 (npm pack) installs a product, the product is shaped like an adopter
// (test/fixtures/adopters/shapes.js), and this package's `upgrade` takes it to 3.7.0: no conflict, --verify exit 0,
// a second run changes nothing, hook-selftest passes. Needs the npm registry (the 3.6.0 tarball, cached per run).
// Until the release PR this package still says 3.6.0, so the upgrade runs from a copy of it that says 3.7.0 (the
// release it becomes); the copy reaches this package's dependencies through a node_modules junction.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SHAPES, NOTICE_JA } = require('../test/fixtures/adopters/shapes');

const ROOT = path.resolve(__dirname, '..');
const OLD = '3.6.0';
let workspace;
let oldRoot;
let runUpgrade;
let runHookSelftest;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function product(name) {
  const shape = SHAPES[name];
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const r = spawnSync(process.execPath, [path.join(oldRoot, 'bin', 'cli.js'), 'init', '--project-name', 'Demo', '--tools', shape.tools, '--stacks', shape.stacks, '--skills', 'all'], {
    cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
  });
  if (r.status !== 0) throw new Error(r.stderr + r.stdout);
  for (const f of fs.readdirSync(dir)) if (/\.backup\.\d+$/.test(f)) fs.rmSync(path.join(dir, f));
  for (const f of walk(dir)) if (/\.backup\.\d+$/.test(f)) fs.rmSync(f);
  shape.shape(dir);
  const manifestFile = path.join(dir, '.ai-dev-helm.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), ...(shape.manifest || {}) }, null, 2)}\n`);
  if (shape.crlf) {
    for (const f of walk(dir)) {
      const buf = fs.readFileSync(f);
      if (!buf.includes(0)) fs.writeFileSync(f, buf.toString('utf8').replace(/\r?\n/g, '\r\n'));
    }
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `install ${OLD} shaped like ${shape.models}`);
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const json = (dir, rel) => JSON.parse(read(dir, rel));
const gateHooks = (dir) => json(dir, '.claude/settings.json').hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => /quality-gate\.cjs/.test(h.command));

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-adopters-'));
  process.env.AI_DEV_HELM_CACHE_DIR = path.join(workspace, 'cache');
  const render = require('./render');
  oldRoot = render.fetchPackage(OLD);
  const newRoot = path.join(workspace, 'new', 'package');
  for (const entry of ['bin', 'lib', 'skills', 'stacks', 'shared', 'templates', 'configs', 'package.json', '.superpowers-version']) {
    if (fs.existsSync(path.join(ROOT, entry))) fs.cpSync(path.join(ROOT, entry), path.join(newRoot, entry), { recursive: true, filter: (src) => !/\.test\.js$/.test(src) });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!render.versionAtLeast(pkg.version, '3.7.0')) fs.writeFileSync(path.join(newRoot, 'package.json'), JSON.stringify({ ...pkg, version: '3.7.0' }, null, 2));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(newRoot, 'node_modules'), 'junction');
  ({ runUpgrade } = require(path.join(newRoot, 'lib', 'upgrade')));
  ({ runHookSelftest } = require('./hook-selftest'));
}, 300000);

afterAll(() => {
  delete process.env.AI_DEV_HELM_CACHE_DIR;
  fs.rmSync(workspace, { recursive: true, force: true });
});

const CHECKS = {
  standard() {},
  flat(dir) {
    expect(read(dir, '.gitignore').split(/\r?\n/)).not.toContain('/.claude/skills');
    expect(fs.existsSync(path.join(dir, 'skills'))).toBe(false);
    expect(read(dir, '.claude/skills/branch-workflow/SKILL.md')).toContain('documents/development/project/branch-workflow.md');
    expect(fs.existsSync(path.join(dir, '.claude/skills/superpowers/brainstorming/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.claude/skills/staging-log-investigation/SKILL.md'))).toBe(true);
    expect(gateHooks(dir).map((h) => h.statusMessage)).toEqual(['品質ゲートを確認中']);
  },
  copies(dir) {
    for (const runtime of ['.claude', '.codex', '.cursor']) {
      expect(read(dir, `${runtime}/skills/project/branch-workflow/SKILL.md`)).toContain('documents/development/project/branch-workflow.md');
      expect(fs.existsSync(path.join(dir, `${runtime}/skills/superpowers/brainstorming/SKILL.md`))).toBe(true);
    }
    expect(json(dir, '.ai-dev-helm.json').stacks).toEqual(['custom-hono-react', 'nextjs-react']);
    expect(json(dir, '.claude/settings.json').enabledPlugins['superpowers@claude-plugins-official']).toBe(true);
  },
  crlf(dir) {
    expect(read(dir, 'CLAUDE.md')).toContain('\r\n');
    expect(read(dir, 'CLAUDE.md').replace(/\r\n/g, '')).not.toContain('\n');
    const front = fs.readdirSync(path.join(dir, '.cursor', 'rules')).find((f) => f.startsWith('frontend-'));
    expect(read(dir, `.cursor/rules/${front}`)).toContain('"apps/web/**/*.tsx"');
  },
  gate(dir) {
    for (const rel of ['.claude/hooks/quality-gate.cjs', '.claude/hooks/review-budget.cjs', '.codex/hooks/quality-gate.cjs']) expect(fs.existsSync(path.join(dir, rel)), rel).toBe(false);
    const { calledHook, declaredHooks } = require('./runtime-hooks');
    const declared = declaredHooks(json(dir, '.ai-dev-helm.json')).declared;
    const gates = json(dir, '.claude/settings.json').hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => (calledHook(h.command, declared) || {}).file === 'quality-gate.cjs');
    expect(gates).toHaveLength(1);
    expect(gates[0].command).toContain('scripts/gate.cjs');
    expect(gates[0].statusMessage).toBe('品質ゲートを確認中');
    expect(json(dir, '.claude/settings.json').permissions.deny).not.toContain('Bash(git push --force origin release)');
    expect(read(dir, '.codex/rules/ai-dev-helm-protected.rules')).toContain('"release"');
    expect(read(dir, '.codex/skills/branch-workflow/SKILL.md')).toContain('documents/development/project/branch-workflow.md');
    expect(fs.existsSync(path.join(dir, '.claude/skills/superpowers'))).toBe(false);
  },
  notice(dir) {
    const gates = gateHooks(dir);
    expect(gates).toHaveLength(1);
    expect(gates[0].command).not.toContain(NOTICE_JA);
    expect(json(dir, '.claude/settings.json').enabledPlugins).toMatchObject({ 'superpowers@superpowers-marketplace': false, 'superpowers@claude-plugins-official': false });
  },
};

describe(`upgrade ${OLD} -> this release on products shaped like the adopters (acceptance)`, () => {
  test.each(Object.keys(SHAPES))('%s', (name) => {
    const dir = product(name);
    const result = runUpgrade({ dir });
    expect(result.record.actions.filter((a) => /conflict/.test(a.action))).toEqual([]);
    expect(result.record.verdict.missing).toEqual([]);
    expect(result.exitCode).toBe(0);
    CHECKS[name](dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'upgrade');
    expect(runUpgrade({ dir, mode: 'verify' }).exitCode).toBe(0);
    const again = runUpgrade({ dir, mode: 'plan' });
    expect(again.record.actions.filter((a) => !/^(up to date|declared-out)/.test(a.action))).toEqual([]);
    const selftest = runHookSelftest({ dir });
    expect(selftest.exitCode, selftest.lines.join('\n')).toBe(0);
  }, 600000);
});
