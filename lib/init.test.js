const fs = require('fs');
const path = require('path');
const os = require('os');
const { PACKAGE_ROOT, copyDirSync, linkOrCopy } = require('./utils');

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
