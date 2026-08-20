const {
  isCodeExtension,
  isMarkdown,
  commentStart,
  inlineCommentText,
  scanCommentLines,
  isIndexInString,
} = require('./comments');

describe('lint comments helper', () => {
  describe('extension gating', () => {
    it('recognizes code extensions', () => {
      for (const p of ['a.js', 'b.ts', 'c.java', 'd.py', 'e.sql', 'f.go']) {
        expect(isCodeExtension(p)).toBe(true);
      }
    });
    it('rejects markup / prose extensions', () => {
      for (const p of ['a.md', 'b.markdown', 'c.txt', 'd.html', 'e.css', 'f.json']) {
        expect(isCodeExtension(p)).toBe(false);
      }
    });
    it('detects markdown', () => {
      expect(isMarkdown('README.md')).toBe(true);
      expect(isMarkdown('a.mdx')).toBe(true);
      expect(isMarkdown('a.js')).toBe(false);
    });
  });

  describe('commentStart (string-aware)', () => {
    it('finds a real // comment token', () => {
      expect(commentStart('const x = 1; // hi')).toEqual({ index: 13, token: '//' });
    });
    it('ignores // inside a string literal', () => {
      expect(commentStart('const u = "https://x/TODO-123";')).toBeNull();
    });
    it('ignores # inside a string literal', () => {
      expect(commentStart('const t = "#todo";')).toBeNull();
    });
    it('ignores -- inside a string literal', () => {
      expect(commentStart('const s = "a--todo-b";')).toBeNull();
    });
    it('drops # as a token in markdown mode', () => {
      expect(commentStart('# heading', { markdown: true })).toBeNull();
    });
  });

  describe('inlineCommentText', () => {
    it('returns text after a real token', () => {
      expect(inlineCommentText('code(); // TODO x')).toBe(' TODO x');
    });
    it('returns null when the only token is inside a string', () => {
      expect(inlineCommentText('const u = "https://x/TODO";')).toBeNull();
    });
  });

  describe('scanCommentLines markdown mode', () => {
    it('skips fenced regions and headings', () => {
      const lines = [
        '# TODO heading',
        'prose line',
        '```',
        '// TODO: fenced example',
        '```',
      ];
      const scanned = scanCommentLines(lines, { markdown: true });
      expect(scanned.every((l) => l.isComment === false)).toBe(true);
    });

    it('memoizes on the lines array', () => {
      const lines = ['// a', '// b'];
      expect(scanCommentLines(lines)).toBe(scanCommentLines(lines));
    });
  });

  describe('isIndexInString', () => {
    it('is true inside a string, false in code', () => {
      const line = 'x = "abc" + y';
      expect(isIndexInString(line, line.indexOf('abc'))).toBe(true);
      expect(isIndexInString(line, line.indexOf('y'))).toBe(false);
    });
  });
});
