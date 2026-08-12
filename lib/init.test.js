const fs = require('fs');
const path = require('path');
const os = require('os');
const { PACKAGE_ROOT, SKILL_SCOPE, copyDirSync, linkOrCopy } = require('./utils');
const { writeVersionManifest, ensureGitignoreEntries } = require('./init');

describe('init integration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Claude Code setup', () => {
    it('creates .claude directory structure', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(path.join(claudeDir, 'rules'), { recursive: true });

      expect(fs.existsSync(path.join(claudeDir, 'rules'))).toBe(true);
    });

    it('copies settings.json from template', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'settings.json.template');
      const settingsDest = path.join(claudeDir, 'settings.json');

      fs.copyFileSync(templatePath, settingsDest);

      expect(fs.existsSync(settingsDest)).toBe(true);
      const content = JSON.parse(fs.readFileSync(settingsDest, 'utf8'));
      expect(content).toBeDefined();
    });

    it('copies CLAUDE.md from template', () => {
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template');
      const dest = path.join(tmpDir, 'CLAUDE.md');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      const content = fs.readFileSync(dest, 'utf8');
      expect(content).toContain('{{PROJECT_NAME}}');
    });

    it('does not overwrite existing CLAUDE.md', () => {
      const dest = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(dest, 'existing content');

      // Simulate the check
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(
          path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template'),
          dest
        );
      }

      expect(fs.readFileSync(dest, 'utf8')).toBe('existing content');
    });
  });

  describe('ensureGitignoreEntries', () => {
    it('creates .gitignore with workflow artifact entries when absent', () => {
      ensureGitignoreEntries(tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
      expect(content).toContain('.superpowers/');
      expect(content).toContain('docs/superpowers/plans/');
      expect(content).toContain('.worktrees/');
      expect(content).toContain('.quality-check-report.json');
      expect(content).toContain('.quality-check-passed');
    });

    it('appends only missing entries to an existing .gitignore', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.superpowers/\n');

      ensureGitignoreEntries(tmpDir);

      const content = fs.readFileSync(gitignorePath, 'utf8');
      expect(content).toContain('node_modules/');
      expect(content.match(/^\.superpowers\/$/gm)).toHaveLength(1);
      expect(content).toContain('.quality-check-passed');
    });

    it('is idempotent across repeated runs', () => {
      ensureGitignoreEntries(tmpDir);
      const first = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');

      ensureGitignoreEntries(tmpDir);
      const second = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');

      expect(second).toBe(first);
    });

    it('does not write in dry-run mode', () => {
      ensureGitignoreEntries(tmpDir, { dryRun: true });

      expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
    });
  });

  describe('quality-gate hook', () => {
    const { execFileSync } = require('child_process');
    const hookScript = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');
    const FLAG = '.quality-check-passed';

    const runHook = (payload) =>
      execFileSync('node', [hookScript], {
        cwd: tmpDir,
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
      });

    // Turn tmpDir into a git repo with an origin/main tracking ref.
    const initRepo = () => {
      const g = (...args) =>
        execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8' }).trim();
      g('init', '-b', 'main');
      g('config', 'user.email', 'test@example.com');
      g('config', 'user.name', 'Test');
      g('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log(1);\n');
      g('add', '.');
      g('commit', '-m', 'init');
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return g;
    };

    const writeFlag = (commit, branch = 'feat/x') =>
      fs.writeFileSync(
        path.join(tmpDir, FLAG),
        JSON.stringify({ branch, commit }) + '\n'
      );

    // `g('add', file)` on purpose: `git add .` would sweep the untracked
    // .quality-check-passed written by writeFlag into the commit and break
    // the harness-only diff assertions.
    const commitFile = (g, file, content, msg) => {
      const abs = path.join(tmpDir, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      g('add', file);
      g('commit', '-m', msg);
      return g('rev-parse', 'HEAD');
    };

    it('always allows push to a feature branch without a flag', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');

      expect(runHook({ tool_input: { command: 'git push origin feat/x' } })).toBe('');
      expect(runHook({ tool_input: { command: 'git push -u origin feat/x' } })).toBe('');
    });

    it('detects gated commands in chained and -C forms', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');

      for (const command of [
        'cd sub && git push origin main',
        'git -C . push origin main',
        'echo done; gh pr merge 12',
      ]) {
        const out = JSON.parse(runHook({ tool_input: { command } }));
        expect(out.decision).toBe('block');
      }
    });

    it('gates force refspecs like +main', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');

      const out = JSON.parse(runHook({ tool_input: { command: 'git push origin +main' } }));
      expect(out.decision).toBe('block');
    });

    it('does not gate merge-control flags on main', () => {
      initRepo(); // on main
      expect(runHook({ tool_input: { command: 'git merge --abort' } })).toBe('');
      expect(runHook({ tool_input: { command: 'git merge --continue' } })).toBe('');
    });

    it('does not gate pushes whose refspec merely contains "main" as substring', () => {
      const g = initRepo();
      g('checkout', '-b', 'feature/main-menu');
      commitFile(g, 'code.js', 'x\n', 'code');

      expect(
        runHook({ tool_input: { command: 'git push origin feature/main-menu' } })
      ).toBe('');
    });

    it('blocks gh pr merge without a flag when the branch has code changes', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');

      const out = JSON.parse(runHook({ tool_input: { command: 'gh pr merge 12 --squash' } }));
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('Quality check not passed');
    });

    it('blocks push targeting main without a flag', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');

      const out = JSON.parse(runHook({ tool_input: { command: 'git push origin main' } }));
      expect(out.decision).toBe('block');
    });

    it('blocks git merge on main without a flag, allows it on a feature branch', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');

      // Merges on a feature branch (e.g. pulling in origin/main) are not gated.
      expect(runHook({ tool_input: { command: 'git merge origin/main' } })).toBe('');

      g('checkout', 'main');
      const out = JSON.parse(runHook({ tool_input: { command: 'git merge feat/x' } }));
      expect(out.decision).toBe('block');
    });

    it('allows a gated command with a valid flag and does NOT delete the flag', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      const head = commitFile(g, 'code.js', 'x\n', 'code');
      writeFlag(head);

      expect(runHook({ tool_input: { command: 'gh pr merge 12' } })).toBe('');
      expect(fs.existsSync(path.join(tmpDir, FLAG))).toBe(true);
    });

    it('keeps the flag valid across harness-only follow-up commits', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      const head = commitFile(g, 'code.js', 'x\n', 'code');
      writeFlag(head);
      commitFile(g, 'CLAUDE.md', '# rules\n', 'harness');
      commitFile(g, 'skills/project/quality-check/SKILL.md', '# skill\n', 'skill');

      expect(runHook({ tool_input: { command: 'gh pr merge 12' } })).toBe('');
    });

    it('blocks when non-harness code changed after the flag commit', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      const head = commitFile(g, 'code.js', 'x\n', 'code');
      writeFlag(head);
      commitFile(g, 'code2.js', 'y\n', 'more code');

      const out = JSON.parse(runHook({ tool_input: { command: 'gh pr merge 12' } }));
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('Code changed');
    });

    it('blocks reuse of a stale flag from another branch', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/y');
      const staleTip = commitFile(g, 'lib-y.js', 'y\n', 'y code');
      writeFlag(staleTip, 'feat/y');
      g('checkout', 'main');
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'lib-x.js', 'x\n', 'x code');

      const out = JSON.parse(runHook({ tool_input: { command: 'gh pr merge 13' } }));
      expect(out.decision).toBe('block');
    });

    it('exempts a harness-only branch without any flag', () => {
      const g = initRepo();
      g('checkout', '-b', 'chore/harness');
      commitFile(g, 'CLAUDE.md', '# rules\n', 'harness');
      commitFile(g, '.claude/settings.json', '{}\n', 'settings');

      expect(runHook({ tool_input: { command: 'gh pr merge 14' } })).toBe('');
    });

    it('does not exempt an empty diff', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/empty');

      const out = JSON.parse(runHook({ tool_input: { command: 'gh pr merge 15' } }));
      expect(out.decision).toBe('block');
    });

    it('treats a legacy empty flag file as invalid', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      commitFile(g, 'code.js', 'x\n', 'code');
      fs.writeFileSync(path.join(tmpDir, FLAG), '');

      const out = JSON.parse(runHook({ tool_input: { command: 'gh pr merge 12' } }));
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('Quality check not passed');
    });

    it('allows pushing main after a gated local merge (ancestor rule)', () => {
      const g = initRepo();
      g('checkout', '-b', 'feat/x');
      const checked = commitFile(g, 'code.js', 'x\n', 'code');
      writeFlag(checked);
      g('checkout', 'main');
      g('merge', '--no-ff', 'feat/x', '-m', 'merge feat/x');

      expect(runHook({ tool_input: { command: 'git push origin main' } })).toBe('');
    });

    it('blocks gh pr merge on main when the PR head cannot be resolved', () => {
      initRepo(); // on main with no remote — gh pr view always fails here
      const out = JSON.parse(runHook({ tool_input: { command: 'gh pr merge 12' } }));
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('Cannot verify');
    });

    it('ignores unrelated commands', () => {
      for (const command of ['git status', 'npm test', 'echo "git pushover"', 'git pull']) {
        expect(runHook({ tool_input: { command } })).toBe('');
      }
    });

    it('fails open outside a git repo for git commands', () => {
      // tmpDir is intentionally NOT a git repo here
      expect(runHook({ tool_input: { command: 'git push' } })).toBe('');
      expect(runHook({ tool_input: { command: 'git merge feat/x' } })).toBe('');
    });

    it('does not block on malformed payloads', () => {
      expect(runHook('not json')).toBe('');
      expect(runHook({})).toBe('');
    });
  });

  describe('Cursor setup', () => {
    it('creates .cursor directory structure', () => {
      const cursorDir = path.join(tmpDir, '.cursor');
      fs.mkdirSync(path.join(cursorDir, 'rules'), { recursive: true });

      expect(fs.existsSync(path.join(cursorDir, 'rules'))).toBe(true);
    });
  });

  describe('Codex setup', () => {
    it('creates .codex directory structure', () => {
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(path.join(codexDir, 'rules'), { recursive: true });

      expect(fs.existsSync(path.join(codexDir, 'rules'))).toBe(true);
    });

    it('copies AGENTS.md from template', () => {
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template');
      const dest = path.join(tmpDir, 'AGENTS.md');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      const content = fs.readFileSync(dest, 'utf8');
      expect(content).toContain('{{PROJECT_NAME}}');
    });

    it('copies codex config.toml from template', () => {
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'codex-config.toml.template');
      const dest = path.join(codexDir, 'config.toml');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf8')).toContain('approval_policy');
    });

    it('copies codex hooks.json from template', () => {
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const templatePath = path.join(PACKAGE_ROOT, 'templates', 'codex-hooks.json.template');
      const dest = path.join(codexDir, 'hooks.json');

      fs.copyFileSync(templatePath, dest);

      expect(fs.existsSync(dest)).toBe(true);
      const content = JSON.parse(fs.readFileSync(dest, 'utf8'));
      expect(content.PreToolUse).toBeDefined();
    });

    it('does not overwrite existing AGENTS.md', () => {
      const dest = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(dest, 'existing content');

      if (!fs.existsSync(dest)) {
        fs.copyFileSync(
          path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template'),
          dest
        );
      }

      expect(fs.readFileSync(dest, 'utf8')).toBe('existing content');
    });
  });

  describe('skill copying', () => {
    it('copies superpowers skills', () => {
      const skillsDest = path.join(tmpDir, 'skills', 'superpowers');
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'superpowers'),
        skillsDest
      );

      expect(fs.existsSync(skillsDest)).toBe(true);
      // Should contain at least one SKILL.md
      const brainstormSkill = path.join(skillsDest, 'brainstorming', 'SKILL.md');
      expect(fs.existsSync(brainstormSkill)).toBe(true);
    });

    it('copies project skills', () => {
      const skillsDest = path.join(tmpDir, 'skills', 'project');
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'project'),
        skillsDest
      );

      expect(fs.existsSync(skillsDest)).toBe(true);
      const qualitySkill = path.join(skillsDest, 'quality-check', 'SKILL.md');
      expect(fs.existsSync(qualitySkill)).toBe(true);
    });
  });

  describe('template replacement', () => {
    it('replaces {{PROJECT_NAME}} placeholder', () => {
      const dest = path.join(tmpDir, 'CLAUDE.md');
      fs.copyFileSync(
        path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template'),
        dest
      );

      let content = fs.readFileSync(dest, 'utf8');
      const projectName = 'TestProject';
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
      fs.writeFileSync(dest, content, 'utf8');

      const result = fs.readFileSync(dest, 'utf8');
      expect(result).toContain('TestProject');
      expect(result).not.toContain('{{PROJECT_NAME}}');
    });

    it('replaces {{PROJECT_NAME}} placeholder in AGENTS.md', () => {
      const dest = path.join(tmpDir, 'AGENTS.md');
      fs.copyFileSync(
        path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template'),
        dest
      );

      let content = fs.readFileSync(dest, 'utf8');
      const projectName = 'CodexTestProject';
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
      fs.writeFileSync(dest, content, 'utf8');

      const result = fs.readFileSync(dest, 'utf8');
      expect(result).toContain('CodexTestProject');
      expect(result).not.toContain('{{PROJECT_NAME}}');
    });

    it('handles $ characters in project name safely', () => {
      const dest = path.join(tmpDir, 'test.md');
      fs.writeFileSync(dest, 'Hello {{PROJECT_NAME}}!');

      let content = fs.readFileSync(dest, 'utf8');
      const projectName = 'Test$&Project';
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
      fs.writeFileSync(dest, content, 'utf8');

      const result = fs.readFileSync(dest, 'utf8');
      expect(result).toBe('Hello Test$&Project!');
    });
  });

  describe('dry-run mode', () => {
    it('copyDirSync does not create files in dry-run', () => {
      const src = path.join(tmpDir, 'src');
      const dest = path.join(tmpDir, 'dest');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'file.txt'), 'content');

      copyDirSync(src, dest, { dryRun: true });

      expect(fs.existsSync(dest)).toBe(false);
    });

    it('linkOrCopy does not create link in dry-run', () => {
      const target = path.join(tmpDir, 'target');
      const link = path.join(tmpDir, 'link');
      fs.mkdirSync(target);

      linkOrCopy(target, link, { dryRun: true });

      expect(fs.existsSync(link)).toBe(false);
    });
  });

  describe('version manifest', () => {
    it('writes .ai-dev-helm.json with version, tools, stacks and scope', () => {
      writeVersionManifest(tmpDir, {
        tools: ['claude-code', 'cursor'],
        stacks: ['nextjs-react'],
        skillScope: SKILL_SCOPE.ALL,
      });

      const manifestPath = path.join(tmpDir, '.ai-dev-helm.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const { version } = JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
      );
      expect(manifest.version).toBe(version);
      expect(manifest.tools).toEqual(['claude-code', 'cursor']);
      expect(manifest.stacks).toEqual(['nextjs-react']);
      expect(manifest.skillScope).toBe('all');
      expect(new Date(manifest.appliedAt).toString()).not.toBe('Invalid Date');
    });

    it('overwrites an existing manifest on re-run', () => {
      const manifestPath = path.join(tmpDir, '.ai-dev-helm.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ version: '0.0.1' }));

      writeVersionManifest(tmpDir, {
        tools: ['codex'],
        stacks: [],
        skillScope: SKILL_SCOPE.CUSTOM,
      });

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.version).not.toBe('0.0.1');
      expect(manifest.tools).toEqual(['codex']);
      expect(manifest.skillScope).toBe('custom');
    });

    it('does not write the manifest in dry-run mode', () => {
      writeVersionManifest(
        tmpDir,
        { tools: ['cursor'], stacks: [], skillScope: SKILL_SCOPE.ALL },
        { dryRun: true }
      );

      expect(fs.existsSync(path.join(tmpDir, '.ai-dev-helm.json'))).toBe(false);
    });
  });

  describe('skills link creation', () => {
    it('creates link or copy from skills to .claude/skills', () => {
      const skillsDir = path.join(tmpDir, 'skills');
      fs.mkdirSync(skillsDir);
      fs.writeFileSync(path.join(skillsDir, 'test.md'), 'skill content');

      const linkPath = path.join(tmpDir, '.claude', 'skills');
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });

      linkOrCopy(skillsDir, linkPath);

      expect(fs.existsSync(path.join(linkPath, 'test.md'))).toBe(true);
    });
  });
});
