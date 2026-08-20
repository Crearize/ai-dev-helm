const fs = require('fs');
const path = require('path');
const os = require('os');
const { copyDirSync, copyFilesSync, linkOrCopy, detectStacks, detectProjectSkills, copySelectedSkills, parseNumberSelection, SKILL_SCOPE, TOOL_IDS, ALL_TOOL_IDS, PACKAGE_ROOT } = require('./utils');

describe('copyDirSync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recursively copies directory contents', () => {
    const src = path.join(tmpDir, 'src');
    const dest = path.join(tmpDir, 'dest');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'world');

    copyDirSync(src, dest);

    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf8')).toBe('world');
  });

  it('logs dry-run message without copying files', () => {
    const src = path.join(tmpDir, 'src');
    const dest = path.join(tmpDir, 'dest');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    copyDirSync(src, dest, { dryRun: true });

    console.log = origLog;
    expect(fs.existsSync(dest)).toBe(false);
    expect(logs.some((l) => l.includes('[dry-run]'))).toBe(true);
  });

  it('propagates options to recursive calls (dry-run nested dirs)', () => {
    const src = path.join(tmpDir, 'src');
    fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'deep', 'file.txt'), 'nested');

    const dest = path.join(tmpDir, 'dest');
    copyDirSync(src, dest, { dryRun: true });

    expect(fs.existsSync(dest)).toBe(false);
  });

  // Regression: destinations are shared, user-owned trees. A mid-copy
  // failure used to rmSync the destination ROOT, wiping pre-existing user
  // content the copy never touched.
  it('preserves a pre-existing destination (and its content) when the copy fails', () => {
    const src = path.join(tmpDir, 'src');
    const dest = path.join(tmpDir, 'dest');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'incoming');
    // Pre-existing user content in dest, plus a directory where the copy
    // wants to write a file — copyFileSync onto a directory fails on every
    // platform, triggering the cleanup path.
    fs.mkdirSync(path.join(dest, 'a.txt'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'user-owned.txt'), 'precious');

    expect(() => copyDirSync(src, dest)).toThrow(/Failed to copy/);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'user-owned.txt'), 'utf8')).toBe('precious');
  });

  // The inner recursion hits the same rule: a pre-existing SUBdirectory of
  // the destination is not deleted when copying into it fails.
  it('preserves a pre-existing destination subdirectory when a nested copy fails', () => {
    const src = path.join(tmpDir, 'src');
    const dest = path.join(tmpDir, 'dest');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'incoming');
    fs.mkdirSync(path.join(dest, 'sub', 'b.txt'), { recursive: true }); // collision
    fs.writeFileSync(path.join(dest, 'sub', 'user-owned.txt'), 'precious');

    expect(() => copyDirSync(src, dest)).toThrow(/Failed to copy/);
    expect(fs.readFileSync(path.join(dest, 'sub', 'user-owned.txt'), 'utf8')).toBe('precious');
  });
});

describe('copyFilesSync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies only files (not subdirectories)', () => {
    const src = path.join(tmpDir, 'src');
    const dest = path.join(tmpDir, 'dest');
    fs.mkdirSync(path.join(src, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(src, 'file.txt'), 'content');
    fs.writeFileSync(path.join(src, 'subdir', 'nested.txt'), 'nested');

    copyFilesSync(src, dest);

    expect(fs.existsSync(path.join(dest, 'file.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'subdir'))).toBe(false);
  });

  it('does nothing when src does not exist', () => {
    const dest = path.join(tmpDir, 'dest');
    copyFilesSync(path.join(tmpDir, 'nonexistent'), dest);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('logs dry-run message without copying', () => {
    const src = path.join(tmpDir, 'src');
    const dest = path.join(tmpDir, 'dest');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    copyFilesSync(src, dest, { dryRun: true });

    console.log = origLog;
    expect(fs.existsSync(dest)).toBe(false);
    expect(logs.some((l) => l.includes('[dry-run]'))).toBe(true);
  });
});

describe('linkOrCopy', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a link or copy of the target directory', () => {
    const target = path.join(tmpDir, 'target');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'test.txt'), 'content');

    linkOrCopy(target, link);

    expect(fs.existsSync(path.join(link, 'test.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(link, 'test.txt'), 'utf8')).toBe('content');
  });

  it('removes existing link before creating new one', () => {
    const target = path.join(tmpDir, 'target');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'test.txt'), 'content');
    fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'old.txt'), 'old');

    linkOrCopy(target, link);

    expect(fs.existsSync(path.join(link, 'old.txt'))).toBe(false);
    expect(fs.existsSync(path.join(link, 'test.txt'))).toBe(true);
  });

  it('logs dry-run message without creating link', () => {
    const target = path.join(tmpDir, 'target');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    linkOrCopy(target, link, { dryRun: true });

    console.log = origLog;
    expect(fs.existsSync(link)).toBe(false);
    expect(logs.some((l) => l.includes('[dry-run]'))).toBe(true);
  });
});

describe('detectStacks', () => {
  it('returns available stack names excluding _template (default path)', () => {
    const stacks = detectStacks();
    expect(stacks).toContain('java-springboot');
    expect(stacks).toContain('nextjs-react');
    expect(stacks).not.toContain('_template');
  });

  it('accepts explicit directory parameter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-test-'));
    fs.mkdirSync(path.join(tmpDir, 'stack-a'));
    fs.mkdirSync(path.join(tmpDir, 'stack-b'));
    fs.mkdirSync(path.join(tmpDir, '_template'));

    const stacks = detectStacks(tmpDir);

    expect(stacks).toEqual(expect.arrayContaining(['stack-a', 'stack-b']));
    expect(stacks).not.toContain('_template');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent directory', () => {
    expect(detectStacks('/non/existent/path')).toEqual([]);
  });
});

describe('detectProjectSkills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects directories containing SKILL.md', () => {
    const skill1 = path.join(tmpDir, 'skill-one');
    const skill2 = path.join(tmpDir, 'skill-two');
    fs.mkdirSync(skill1);
    fs.mkdirSync(skill2);
    fs.writeFileSync(path.join(skill1, 'SKILL.md'), '---\nname: skill-one\n---');
    fs.writeFileSync(path.join(skill2, 'SKILL.md'), '---\nname: skill-two\n---');

    const result = detectProjectSkills(tmpDir);

    expect(result).toEqual(['skill-one', 'skill-two']);
  });

  it('excludes directories without SKILL.md', () => {
    const skill = path.join(tmpDir, 'real-skill');
    const notSkill = path.join(tmpDir, '_schemas');
    fs.mkdirSync(skill);
    fs.mkdirSync(notSkill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: real-skill\n---');
    fs.writeFileSync(path.join(notSkill, 'schema.md'), 'not a skill');

    const result = detectProjectSkills(tmpDir);

    expect(result).toEqual(['real-skill']);
  });

  it('returns empty array for empty directory', () => {
    const result = detectProjectSkills(tmpDir);

    expect(result).toEqual([]);
  });

  it('returns empty array for non-existent directory', () => {
    const result = detectProjectSkills('/non/existent/path');

    expect(result).toEqual([]);
  });
});

describe('copySelectedSkills', () => {
  let tmpDir;
  let srcDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-test-'));
    srcDir = path.join(tmpDir, 'src');
    for (const name of ['skill-a', 'skill-b', 'skill-c', '_schemas']) {
      const dir = path.join(srcDir, name);
      fs.mkdirSync(dir, { recursive: true });
      if (name !== '_schemas') {
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---`);
      } else {
        fs.writeFileSync(path.join(dir, 'schema.md'), 'schema');
      }
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies only selected skills', () => {
    const destDir = path.join(tmpDir, 'dest');
    copySelectedSkills(srcDir, destDir, ['skill-a', 'skill-c']);

    expect(fs.existsSync(path.join(destDir, 'skill-a', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'skill-c', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'skill-b'))).toBe(false);
  });

  it('always copies _schemas directory', () => {
    const destDir = path.join(tmpDir, 'dest');
    copySelectedSkills(srcDir, destDir, ['skill-a']);

    expect(fs.existsSync(path.join(destDir, '_schemas', 'schema.md'))).toBe(true);
  });

  it('handles empty selection', () => {
    const destDir = path.join(tmpDir, 'dest');
    copySelectedSkills(srcDir, destDir, []);

    expect(fs.existsSync(path.join(destDir, '_schemas', 'schema.md'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'skill-a'))).toBe(false);
  });

  it('does nothing when srcDir does not exist', () => {
    const destDir = path.join(tmpDir, 'dest');
    copySelectedSkills('/non/existent/path', destDir, ['skill-a']);

    expect(fs.existsSync(destDir)).toBe(false);
  });

  it('does not create dest directory in dry-run mode', () => {
    const destDir = path.join(tmpDir, 'dest');
    copySelectedSkills(srcDir, destDir, ['skill-a'], { dryRun: true });

    expect(fs.existsSync(destDir)).toBe(false);
  });
});

describe('detectProjectSkills - sort order', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sort-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns skills in sorted order regardless of creation order', () => {
    for (const name of ['zeta-skill', 'alpha-skill', 'middle-skill']) {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---');
    }

    const result = detectProjectSkills(tmpDir);

    expect(result).toEqual(['alpha-skill', 'middle-skill', 'zeta-skill']);
  });
});

describe('parseNumberSelection', () => {
  const options = ['alpha', 'beta', 'gamma'];

  it('selects valid numbers from tokens', () => {
    const { selected, warnings } = parseNumberSelection(['1', '3'], options);

    expect(selected).toEqual(['alpha', 'gamma']);
    expect(warnings).toEqual([]);
  });

  it('warns on invalid numbers', () => {
    const { selected, warnings } = parseNumberSelection(['0', '4', 'abc'], options);

    expect(selected).toEqual([]);
    expect(warnings).toHaveLength(3);
  });

  it('handles mixed valid and invalid tokens', () => {
    const { selected, warnings } = parseNumberSelection(['2', '99', '1'], options);

    expect(selected).toEqual(['beta', 'alpha']);
    expect(warnings).toHaveLength(1);
  });

  it('returns empty for empty tokens', () => {
    const { selected, warnings } = parseNumberSelection([], options);

    expect(selected).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('dedupes repeated selections', () => {
    const { selected, warnings } = parseNumberSelection(['2', '2', '1', '2'], options);

    expect(selected).toEqual(['beta', 'alpha']);
    expect(warnings).toEqual([]);
  });
});

describe('constants', () => {
  it('SKILL_SCOPE has expected values', () => {
    expect(SKILL_SCOPE.ALL).toBe(0);
    expect(SKILL_SCOPE.SUPERPOWERS_ONLY).toBe(1);
    expect(SKILL_SCOPE.PROJECT_ONLY).toBe(2);
    expect(SKILL_SCOPE.CUSTOM).toBe(3);
  });

  it('TOOL_IDS has expected values', () => {
    expect(TOOL_IDS.CLAUDE_CODE).toBe('claude-code');
    expect(TOOL_IDS.CURSOR).toBe('cursor');
    expect(TOOL_IDS.CODEX).toBe('codex');
  });

  it('ALL_TOOL_IDS lists all tools in display order', () => {
    expect(ALL_TOOL_IDS).toEqual(['claude-code', 'cursor', 'codex']);
  });
});
