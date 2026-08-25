const fs = require('fs');
const path = require('path');
const os = require('os');
const { PACKAGE_ROOT, SKILL_SCOPE, copyDirSync, linkOrCopy } = require('./utils');
const {
  writeVersionManifest,
  ensureGitignoreEntries,
  copyLintAssets,
  raiseQualityGateTimeout,
} = require('./init');

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

    // The old template registered the gate hook with timeout 10, shorter
    // than the hook's own 20s deadline — the harness killed it mid-decision
    // and silence reads as "allowed". Re-running init must repair that.
    it('raises a stale quality-gate timeout in an existing hooks.json', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(
        dest,
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [
                { type: 'command', command: 'node .codex/hooks/quality-gate.cjs', timeout: 10 },
                { type: 'command', command: 'node my-custom-hook.js', timeout: 5 },
              ],
            },
          ],
        }) + '\n'
      );

      raiseQualityGateTimeout(dest);

      const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
      const [gate, custom] = parsed.PreToolUse[0].hooks;
      expect(gate.timeout).toBe(30);
      expect(custom.timeout).toBe(5); // user hooks untouched
    });

    it('leaves an unparsable hooks.json unchanged', () => {
      const dest = path.join(tmpDir, 'hooks.json');
      fs.writeFileSync(dest, '{ not json\n');

      raiseQualityGateTimeout(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe('{ not json\n');
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

  describe('lint asset distribution', () => {
    const GENERIC_CATEGORIES = [
      'async',
      'error-handling',
      'hardcode',
      'security',
      'test-quality',
    ];

    it('copies generic categories, stack ast-grep, eslint and README for nextjs-react', () => {
      copyLintAssets(tmpDir, ['nextjs-react']);

      // Generic ast-grep category (stack-independent)
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'ast-grep', 'error-handling'))
      ).toBe(true);
      // Stack-specific ast-grep rules land under lint/ast-grep/<stack>/
      expect(
        fs.existsSync(
          path.join(tmpDir, 'lint', 'ast-grep', 'nextjs-react', 'no-loop-query-prisma.yml')
        )
      ).toBe(true);
      // ESLint preset and its custom rules
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'eslint', 'harness.config.mjs'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'eslint', 'rules', 'no-forwardref.js'))
      ).toBe(true);
      // Top-level lint README from shared/lint/README.md
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'README.md'))).toBe(true);
      // Stack wiring guide
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'README-nextjs-react.md'))
      ).toBe(true);
      // java-springboot assets must not appear
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'checkstyle'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'archunit'))).toBe(false);
    });

    it('copies checkstyle and archunit for java-springboot, without eslint', () => {
      copyLintAssets(tmpDir, ['java-springboot']);

      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'checkstyle', 'checkstyle.xml'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'archunit', 'ArchitectureRulesTest.java'))
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'eslint'))).toBe(false);
      expect(
        fs.existsSync(path.join(tmpDir, 'lint', 'ast-grep', 'nextjs-react'))
      ).toBe(false);
    });

    it('copies all generic categories regardless of stack selection', () => {
      copyLintAssets(tmpDir, []);

      for (const category of GENERIC_CATEGORIES) {
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'ast-grep', category, 'README.md'))
        ).toBe(true);
      }
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'README.md'))).toBe(true);
    });

    it('does not create lint/ in dry-run mode', () => {
      copyLintAssets(tmpDir, ['nextjs-react', 'java-springboot'], { dryRun: true });

      expect(fs.existsSync(path.join(tmpDir, 'lint'))).toBe(false);
    });

    it('preserves unrelated content under lint/ (merges, does not wipe)', () => {
      // Product-owned generated rule (lint/product/ is never touched by init)
      // and an unrelated top-level note. A re-run must not delete either.
      const productRule = path.join(tmpDir, 'lint', 'product', 'ast-grep', 'my-rule.yml');
      const topLevelNote = path.join(tmpDir, 'lint', 'CUSTOM-NOTES.md');
      fs.mkdirSync(path.dirname(productRule), { recursive: true });
      fs.writeFileSync(productRule, 'id: my-rule\n', 'utf8');
      fs.writeFileSync(topLevelNote, 'my product notes\n', 'utf8');

      copyLintAssets(tmpDir, ['nextjs-react']);

      expect(fs.existsSync(productRule)).toBe(true);
      expect(fs.readFileSync(productRule, 'utf8')).toBe('id: my-rule\n');
      expect(fs.existsSync(topLevelNote)).toBe(true);
      expect(fs.readFileSync(topLevelNote, 'utf8')).toBe('my product notes\n');
      // Package-managed assets still land alongside the preserved files.
      expect(fs.existsSync(path.join(tmpDir, 'lint', 'README.md'))).toBe(true);
    });

    it('copies a lint asset with byte-identical content, not just presence', () => {
      copyLintAssets(tmpDir, ['nextjs-react']);

      const copiedReadme = fs.readFileSync(path.join(tmpDir, 'lint', 'README.md'), 'utf8');
      const sourceReadme = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'shared', 'lint', 'README.md'),
        'utf8'
      );
      expect(copiedReadme).toBe(sourceReadme);

      const copiedRule = fs.readFileSync(
        path.join(tmpDir, 'lint', 'ast-grep', 'nextjs-react', 'no-loop-query-prisma.yml'),
        'utf8'
      );
      const sourceRule = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'stacks', 'nextjs-react', 'lint', 'ast-grep', 'no-loop-query-prisma.yml'),
        'utf8'
      );
      expect(copiedRule).toBe(sourceRule);
    });

    describe('mutation assets', () => {
      it('distributes stryker config to lint/mutation/ for nextjs-react', () => {
        copyLintAssets(tmpDir, ['nextjs-react']);

        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'stryker.config.mjs'))
        ).toBe(true);
      });

      it('distributes the diff-scope config and its range helper next to the stryker config', () => {
        copyLintAssets(tmpDir, ['nextjs-react']);

        // stryker.diff.config.mjs imports ./stryker.config.mjs and
        // ./changed-ranges.mjs by relative path, so all three must land in
        // the same lint/mutation/ directory.
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'stryker.diff.config.mjs'))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'changed-ranges.mjs'))
        ).toBe(true);
      });

      it('distributes pitest gradle to lint/mutation/ for java-springboot', () => {
        copyLintAssets(tmpDir, ['java-springboot']);

        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'pitest.gradle'))
        ).toBe(true);
      });

      it('does not distribute a non-selected stack mutation asset', () => {
        copyLintAssets(tmpDir, ['nextjs-react']);

        // java-springboot's mutation asset must not appear when only
        // nextjs-react is selected.
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'pitest.gradle'))
        ).toBe(false);
      });

      it('merges both stacks mutation assets without collision (multi-stack)', () => {
        copyLintAssets(tmpDir, ['nextjs-react', 'java-springboot']);

        // Both distinct filenames coexist in the shared lint/mutation/ dir;
        // neither clobbers the other (collision regression guard).
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'stryker.config.mjs'))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(tmpDir, 'lint', 'mutation', 'pitest.gradle'))
        ).toBe(true);
      });

      it('does not create lint/mutation/ in dry-run mode', () => {
        copyLintAssets(tmpDir, ['nextjs-react', 'java-springboot'], { dryRun: true });

        expect(fs.existsSync(path.join(tmpDir, 'lint', 'mutation'))).toBe(false);
      });
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
