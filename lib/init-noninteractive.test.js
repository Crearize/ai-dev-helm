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
    expect(c.tools).toEqual(['claude-code', 'cursor', 'codex']); // 3.7.1 (D8): all three
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

  it('the tool prompt takes nothing as all three tools (3.7.1 D8)', () => {
    const { toolsFromAnswer } = require('./init');
    expect(toolsFromAnswer([]).selected).toEqual(['claude-code', 'cursor', 'codex']);
    expect(toolsFromAnswer(['1', '3']).selected).toEqual(['claude-code', 'codex']);
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

  it('--yes completes with defaults (project name = directory name, all three tools)', () => {
    const r = runInit(dir, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(path.basename(dir));
    for (const rel of ['AGENTS.md', '.cursorrules', '.codex/hooks.json']) expect(fs.existsSync(path.join(dir, rel)), rel).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.ai-dev-helm.json'), 'utf8')).tools).toEqual(['claude-code', 'cursor', 'codex']);
  });

  // --force: these tests re-run init over an installed product on purpose (3.7.0: plain init then stops and names upgrade).
  // Claude Code only: they are about the adopter-editable files (and Codex's trust notice says ACTION REQUIRED).
  const ARGS = ['--yes', '--force', '--stacks', 'nextjs-react', '--tools', 'claude-code'];
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
    // review-prompt.md is adopter-editable since 3.7.0 (design C3c: kept like the other review guides, not overwritten).
    const owned = [skill, upgrade].map((f) => [f, fs.readFileSync(f, 'utf8')]);
    const ruleSrc = fs.readFileSync(rule, 'utf8');
    const promptSrc = fs.readFileSync(prompt, 'utf8');
    for (const [f] of owned) fs.writeFileSync(f, 'stale 3.2.1\n');
    fs.writeFileSync(prompt, 'stale 3.2.1\n');
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
    expect(fs.readFileSync(prompt, 'utf8')).toBe('stale 3.2.1\n');
    expect(fs.readFileSync(prompt + NEW, 'utf8')).toBe(promptSrc);
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

  it('a recorded reviewBudgetScript is read into the distributed calls of the review-budget hook (3.7.1 D6)', () => {
    expect(runInit(dir, ARGS).status).toBe(0);
    const own = path.join(dir, 'documents', 'development', 'project', 'quality-check.md');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'node .claude/hooks/review-budget.cjs status\n');
    // The product's own files (a document and a skill of its own, an edited seed) are not the harness's to rewrite.
    const ownFiles = ['documents/development/product-runbook.md', 'skills/project/own-skill/SKILL.md', 'documents/development/error-codes.md']
      .map((rel) => path.join(dir, ...rel.split('/')));
    for (const file of ownFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'Do not run node .claude/hooks/review-budget.cjs here.\n');
    }
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ ...manifest(), reviewBudgetScript: 'scripts/rb.cjs' }));
    const r = runInit(dir, ARGS);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const runtime = fs.readFileSync(path.join(dir, 'documents', 'development', 'harness-runtime.md'), 'utf8');
    expect(runtime).toContain('node scripts/rb.cjs status');
    expect(runtime).not.toMatch(/node \.(claude|codex)\/hooks\/review-budget\.cjs/);
    expect(fs.readFileSync(path.join(dir, 'skills', 'project', 'quality-check', 'references', 'step4-review.md'), 'utf8')).toContain('node scripts/rb.cjs begin');
    expect(fs.readFileSync(own, 'utf8')).toBe('node .claude/hooks/review-budget.cjs status\n'); // the product's own file
    for (const file of ownFiles) expect(fs.readFileSync(file, 'utf8'), file).toBe('Do not run node .claude/hooks/review-budget.cjs here.\n');
    expect(manifest().reviewBudgetScript).toBe('scripts/rb.cjs');
  });

  // Cycle 3 (C2-M1): where the skills link fails, init copies skills/ - the product's own skills too.
  it('a skills copy made where the link fails reads the review-budget calls of the distributed skills only', () => {
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-links-'));
    const preload = path.join(preloadDir, 'no-links.cjs');
    fs.writeFileSync(preload, "const fs = require('fs'); fs.symlinkSync = () => { const e = new Error('EPERM: no links'); e.code = 'EPERM'; throw e; };\n");
    const runNoLinks = (args) => spawnSync(process.execPath, ['-r', preload, CLI, 'init', ...args], { cwd: dir, input: '', encoding: 'utf8', timeout: 120000 });
    try {
      expect(runNoLinks(ARGS).status).toBe(0);
      const copy = path.join(dir, '.claude', 'skills');
      expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false);
      const own = path.join(dir, 'skills', 'project', 'own-skill', 'SKILL.md');
      fs.mkdirSync(path.dirname(own), { recursive: true });
      fs.writeFileSync(own, 'Do not run node .claude/hooks/review-budget.cjs here.\n');
      fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ ...manifest(), reviewBudgetScript: 'scripts/rb.cjs' }));
      fs.rmSync(copy, { recursive: true, force: true }); // copied again by the next run
      const r = runNoLinks(ARGS);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/could not link/);
      expect(fs.readFileSync(path.join(copy, 'project', 'own-skill', 'SKILL.md'), 'utf8')).toBe('Do not run node .claude/hooks/review-budget.cjs here.\n');
      expect(fs.readFileSync(path.join(copy, 'project', 'quality-check', 'references', 'step4-review.md'), 'utf8')).toContain('node scripts/rb.cjs begin');
      expect(fs.readFileSync(own, 'utf8')).toBe('Do not run node .claude/hooks/review-budget.cjs here.\n');
    } finally {
      fs.rmSync(preloadDir, { recursive: true, force: true });
    }
  });

  it('--yes with several stacks says that none were chosen', () => {
    const r = runInit(dir, ['--yes']);
    expect(r.stdout).toMatch(/stacks detected .*none chosen/);
  });

  // 3.7.2 (U2): a harness file written where git ignores it (untracked) is not in a fresh checkout.
  it('warns of the files it wrote that git ignores and does not track; nothing without git', () => {
    const outside = runInit(dir, ['--yes', '--stacks', 'nextjs-react']);
    expect(outside.status, outside.stdout + outside.stderr).toBe(0);
    expect(outside.stdout).not.toMatch(/ignored by git/); // not a repository: no warning, nothing stops
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-ignored-'));
    const git = (...args) => spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q');
      fs.writeFileSync(path.join(repo, '.gitignore'), '.cursor/\n.codex/config.toml\n');
      const r = runInit(repo, ['--yes', '--stacks', 'nextjs-react']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const listed = (out) => {
        const at = out.indexOf('ignored by git and not tracked');
        if (at < 0) return [];
        const after = out.slice(at).split(/\r?\n/).slice(1);
        return after.slice(0, after.findIndex((l) => !/^ {4}\S/.test(l))).map((l) => l.trim()); // up to the blank line
      };
      const first = listed(r.stdout);
      expect(r.stdout).toMatch(/WARNING: \d+ file\(s\) init wrote are ignored by git and not tracked - a fresh checkout will not have them/);
      expect(first).toEqual(expect.arrayContaining(['.codex/config.toml', '.cursor/hooks.json']));
      expect(first.some((rel) => rel.startsWith('.cursor/rules/'))).toBe(true);
      for (const rel of first) expect(rel, rel).toMatch(/^\.cursor\/|^\.codex\/config\.toml$/); // only what the ignore rules take
      // Tracked (git add -f): no longer listed on a re-run.
      git('add', '-f', '.cursor/hooks.json', '.codex/config.toml');
      const again = runInit(repo, ['--yes', '--force', '--stacks', 'nextjs-react']);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(listed(again.stdout)).not.toContain('.cursor/hooks.json');
      expect(listed(again.stdout)).not.toContain('.codex/config.toml');
      expect(listed(again.stdout).length).toBe(first.length - 2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // Where the skills link fails, init copies skills/ to <tool>/skills, which .gitignore ignores on purpose (it stands
  // in for the link): not warned of. The tools' own hook files are.
  it('does not warn of the copies that stand in for a skills link', () => {
    const { ignoredInitFiles } = require('./init');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '/.cursor/skills\n/.codex/hooks/\n*.ai-dev-helm-new\n*.backup.*\n');
    const copy = path.join(dir, '.cursor', 'skills', 'project', 'qc', 'SKILL.md');
    const hook = path.join(dir, '.codex', 'hooks', 'quality-gate.cjs');
    // The harness's own leftovers, ignored on purpose (cycle 10 of the 3.7.2 quality-check), even if given.
    const leftovers = [path.join(dir, '.codex', 'hooks', 'x.cjs.ai-dev-helm-new'), path.join(dir, '.codex', 'hooks', 'y.json.backup.20261109123456789')];
    for (const file of [copy, hook, ...leftovers]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x\n');
    }
    expect(ignoredInitFiles(dir, [copy, hook, ...leftovers])).toEqual(['.codex/hooks/quality-gate.cjs']);
  });
});

// Cycle 9 of the 3.7.2 quality-check: files of the product's own that git ignores on purpose, in the places init writes
// (hooks, rules), are not "files init wrote": init left them as they were, and git add -f would commit them.
describe('init U2 warning: only files this init wrote', () => {
  test('a local file of the product, ignored on purpose and left as it was, is not named', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-u2-own-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir });
      fs.writeFileSync(path.join(dir, '.gitignore'), '/.claude/rules/local-notes.md\n/.claude/hooks/my-local.cjs\n/.claude/hooks/quality-gate.cjs\n');
      for (const rel of ['.claude/rules/local-notes.md', '.claude/hooks/my-local.cjs']) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), 'the product\'s own\n');
      }
      const res = runInit(dir, ['--yes', '--tools', 'claude-code', '--stacks', 'nextjs-react']);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).not.toMatch(/local-notes\.md|my-local\.cjs/);
      expect(res.stdout).toMatch(/init wrote are ignored by git[\s\S]*\.claude\/hooks\/quality-gate\.cjs/); // the harness's own still is
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);

  // Cycles 9 and 10 of the 3.7.2 quality-check: the warning was guessed from the directories init writes into, which
  // named the product's own files there (cycle 9) and, after that was narrowed by times, missed the hooks a re-run
  // overwrote (cycle 10: Windows copyFileSync keeps the template's times). Now every place init writes records its
  // file. With everything ignored, the warning names exactly the files init made or set up - every one of them, so a
  // new place init writes that does not record its file fails here - and none of the product's own it left as they
  // were, nor a *.ai-dev-helm-new or *.backup.<time> it made.
  test('every file init creates is recorded; a re-run names the hooks it overwrites again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-u2-all-'));
    const walk = (base, rel = '') => fs.readdirSync(path.join(base, rel), { withFileTypes: true }).flatMap((entry) => {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || child === '.git') return []; // a skills link is not a file init wrote
      return entry.isDirectory() ? walk(base, child) : [child];
    });
    const listed = (out) => {
      const at = out.indexOf('ignored by git and not tracked');
      if (at < 0) return [];
      const after = out.slice(at).split(/\r?\n/).slice(1);
      return after.slice(0, after.findIndex((l) => !/^ {4}\S/.test(l))).map((l) => l.trim());
    };
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir });
      fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!.gitignore\n');
      // The product's own: a local hook (left as it is), an edited review guide (kept; init writes a .ai-dev-helm-new),
      // and settings.json (merged: init writes it, and backs it up first).
      const own = { '.claude/hooks/my-local.cjs': 'local\n', '.github/review-prompt.md': 'the product\'s own prompt\n', '.claude/settings.json': '{}\n' };
      for (const [rel, text] of Object.entries(own)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      }
      const first = runInit(dir, ['--yes', '--stacks', 'nextjs-react']);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const files = walk(dir);
      expect(files).toEqual(expect.arrayContaining(['.github/review-prompt.md.ai-dev-helm-new']));
      expect(files.some((rel) => /^\.claude\/settings\.json\.backup\.[0-9]+$/.test(rel))).toBe(true);
      const leftOrOnPurpose = (rel) => rel === '.gitignore' || rel === '.claude/hooks/my-local.cjs' || rel === '.github/review-prompt.md'
        || /\.ai-dev-helm-new$|\.backup\.[0-9]+$/.test(rel) || /^\.(?:claude|codex|cursor)\/skills\//.test(rel);
      const expected = files.filter((rel) => !leftOrOnPurpose(rel)).sort();
      expect(expected).toEqual(expect.arrayContaining(['.claude/settings.json', '.claude/hooks/quality-gate.cjs', '.codex/agents/helm-reviewer.toml', 'CLAUDE.md', '.ai-dev-helm.json']));
      expect(listed(first.stdout).sort()).toEqual(expected);
      // A re-run overwrites the hooks (on Windows with the template's times) and sets up the registrations again: all
      // named again. Root rule files and seeds it leaves as they are are not.
      const again = runInit(dir, ['--yes', '--force', '--stacks', 'nextjs-react']);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      const second = listed(again.stdout);
      const setUp = expected.filter((rel) => /^\.(?:claude|codex|cursor)\/(?:hooks\/|agents\/|settings\.json$|hooks\.json$|config\.toml$)/.test(rel));
      expect(setUp).toEqual(expect.arrayContaining(['.claude/hooks/quality-gate.cjs', '.claude/hooks/review-budget.cjs', '.claude/hooks/context-handoff.cjs',
        '.codex/hooks/quality-gate.cjs', '.codex/hooks.json', '.cursor/hooks.json']));
      expect(second).toEqual(expect.arrayContaining(setUp));
      for (const rel of second) expect(expected, rel).toContain(rel);
      expect(second).not.toContain('CLAUDE.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
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

// 3.7.2 (rule 3 of the design "git location"): with only one of GIT_DIR / GIT_WORK_TREE (a git hook gets GIT_DIR
// alone), init cannot tell which files git tracks and ignores there, so it writes nothing; --dry-run warns.
describe('init with only one of GIT_DIR / GIT_WORK_TREE (3.7.2 rule 3)', () => {
  test('writes nothing and says why; --dry-run warns; with both set it runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-rule3-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir });
      const run = (env, args) => spawnSync(process.execPath, [CLI, 'init', '--yes', '--tools', 'claude-code', ...args], {
        cwd: dir, input: '', encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
      });
      for (const env of [{ GIT_DIR: path.join(dir, '.git') }, { GIT_WORK_TREE: dir }, { GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: '' }]) {
        const res = run(env, []);
        expect(res.status, JSON.stringify(env)).toBe(1); // as init's other errors (upgrade: 2)
        expect(res.stderr + res.stdout).toMatch(/only one of them is set, or one is empty[\s\S]*so init cannot tell which repository it writes for[\s\S]*Nothing was written/);
        expect(fs.readdirSync(dir)).toEqual(['.git']);
        const dry = run(env, ['--dry-run']);
        expect(dry.status).toBe(0);
        expect(dry.stdout).toMatch(/WARNING: GIT_DIR \/ GIT_WORK_TREE: only one of them is set[\s\S]*write nothing in this environment/);
        expect(fs.readdirSync(dir)).toEqual(['.git']);
      }
      const both = run({ GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: dir }, []);
      expect(both.status, both.stderr).toBe(0);
      expect(fs.existsSync(path.join(dir, '.ai-dev-helm.json'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
});
