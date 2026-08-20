const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { collectFiles, readFileText, globToRegExp } = require('./scan');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'lint');

describe('lint scan', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-scan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a file under tmpDir, creating parent directories */
  function write(relPath, content) {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  // Turn tmpDir into a git repo (same pattern as quality-gate.test.js).
  // `-c core.autocrlf=false` keeps blob bytes exactly as written.
  const initRepo = () => {
    const g = (...args) =>
      execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
        cwd: tmpDir,
        encoding: 'utf8',
      }).trim();
    g('init', '-b', 'main');
    g('config', 'core.autocrlf', 'false');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    return g;
  };

  describe('collectFiles in a git repo', () => {
    it('collects tracked and untracked files, never node_modules/ or .git/', () => {
      const g = initRepo();
      write('src/a.js', 'a\n');
      g('add', '.');
      g('commit', '-m', 'init');
      write('src/b.js', 'b\n'); // untracked
      write('node_modules/pkg/x.js', 'x\n');
      write(path.join('.git', 'stray.js'), 's\n');

      const { files, skipped } = collectFiles({ dir: tmpDir });

      expect(files).toEqual(['src/a.js', 'src/b.js']);
      expect(skipped).toEqual([]);
    });

    it('applies exclude globs from config', () => {
      const g = initRepo();
      write('src/a.js', 'a\n');
      write('dist/a/b.js', 'b\n');
      g('add', '.');
      g('commit', '-m', 'init');

      const { files } = collectFiles({ dir: tmpDir, exclude: ['dist/**'] });

      expect(files).toEqual(['src/a.js']);
    });

    it('does not sniff binary at collection (deferred to the read path)', () => {
      const g = initRepo();
      write('src/a.js', 'a\n');
      fs.writeFileSync(
        path.join(tmpDir, 'blob.bin'),
        Buffer.from([0x68, 0x69, 0x00, 0x0a])
      );
      g('add', '.');
      g('commit', '-m', 'init');

      // collectFiles keeps only the cheap size cap; NUL is recognized later.
      const { files, skipped } = collectFiles({ dir: tmpDir });

      expect(files).toEqual(['blob.bin', 'src/a.js']);
      expect(skipped).toEqual([]);
    });

    it('skips files over maxBytes with reason too-large', () => {
      const g = initRepo();
      write('src/a.js', 'a\n');
      write('big.js', 'x'.repeat(200));
      g('add', '.');
      g('commit', '-m', 'init');

      const { files, skipped } = collectFiles({ dir: tmpDir, maxBytes: 100 });

      expect(files).toEqual(['src/a.js']);
      expect(skipped).toEqual([{ file: 'big.js', reason: 'too-large' }]);
    });

    it('restricts to paths, accepting Windows separators, returning / paths', () => {
      const g = initRepo();
      write('src/sub/x.js', 'x\n');
      write('src/sub/deep/y.js', 'y\n');
      write('src/other.js', 'o\n');
      write('root.js', 'r\n');
      g('add', '.');
      g('commit', '-m', 'init');

      const { files } = collectFiles({ dir: tmpDir, paths: ['src\\sub'] });

      expect(files).toEqual(['src/sub/deep/y.js', 'src/sub/x.js']);
    });

    it('silently drops deleted-but-still-cached files', () => {
      const g = initRepo();
      write('src/a.js', 'a\n');
      write('gone.js', 'g\n');
      g('add', '.');
      g('commit', '-m', 'init');
      fs.rmSync(path.join(tmpDir, 'gone.js')); // deleted on disk, still cached

      const { files, skipped } = collectFiles({ dir: tmpDir });

      expect(files).toEqual(['src/a.js']);
      expect(skipped).toEqual([]);
    });
  });

  describe('collectFiles outside a git repo', () => {
    it('walks the directory, exclusions still apply', () => {
      write('a.js', 'a\n');
      write('sub/b.js', 'b\n');
      write('node_modules/pkg/x.js', 'x\n');
      write('dist/c.js', 'c\n');

      const { files, skipped } = collectFiles({
        dir: tmpDir,
        exclude: ['dist/**'],
      });

      expect(files).toEqual(['a.js', 'sub/b.js']);
      expect(skipped).toEqual([]);
    });
  });

  describe('readFileText', () => {
    it('strips a UTF-8 BOM', () => {
      const abs = write('bom.js', '\uFEFF' + 'const x = 1;\n');

      const { content, eol } = readFileText(abs);

      expect(content).toBe('const x = 1;\n');
      expect(eol).toBe('lf');
    });

    it('returns null for a binary (NUL-containing) file (P3)', () => {
      const abs = path.join(tmpDir, 'blob.bin');
      fs.writeFileSync(abs, Buffer.from([0x68, 0x69, 0x00, 0x0a]));
      expect(readFileText(abs)).toBeNull();
    });

    it('detects lf in the LF fixture (bytes contain no \\r)', () => {
      const abs = path.join(FIXTURES_DIR, 'newline-lf.js');
      const raw = fs.readFileSync(abs);

      expect(raw.includes(0x0d)).toBe(false); // guards .gitattributes pinning

      const { content, eol } = readFileText(abs);
      expect(eol).toBe('lf');
      expect(content).not.toContain('\r');
    });

    it('detects crlf in the CRLF fixture (bytes contain \\r\\n)', () => {
      const abs = path.join(FIXTURES_DIR, 'newline-crlf.js');
      const raw = fs.readFileSync(abs);

      expect(raw.includes(0x0d)).toBe(true); // guards .gitattributes pinning

      const { content, eol } = readFileText(abs);
      expect(eol).toBe('crlf');
      expect(content).toContain('\r\n');
    });
  });

  describe('globToRegExp', () => {
    it('dist/** matches files under dist but not distx', () => {
      const re = globToRegExp('dist/**');
      expect(re.test('dist/a/b.js')).toBe(true);
      expect(re.test('dist/a.js')).toBe(true);
      expect(re.test('dist')).toBe(true); // bare directory prefix
      expect(re.test('distx/a.js')).toBe(false);
    });

    it('*.md matches only root-level .md files', () => {
      const re = globToRegExp('*.md');
      expect(re.test('README.md')).toBe(true);
      expect(re.test('docs/guide.md')).toBe(false);
      expect(re.test('README.mdx')).toBe(false);
    });

    it('**/*.test.js matches nested test files', () => {
      const re = globToRegExp('**/*.test.js');
      expect(re.test('lib/lint/scan.test.js')).toBe(true);
      expect(re.test('a/b/c/d.test.js')).toBe(true);
      expect(re.test('lib/scan.js')).toBe(false);
    });

    it('? matches a single character within a segment', () => {
      const re = globToRegExp('a?.js');
      expect(re.test('ab.js')).toBe(true);
      expect(re.test('a.js')).toBe(false);
      expect(re.test('a/b.js')).toBe(false);
    });
  });
});
