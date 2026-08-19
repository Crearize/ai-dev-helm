const commentedCode = require('./commented-code');
const { checks } = require('./index');

/** Build a file-scope check ctx the way the runner will */
function makeCtx(content, { relPath = 'src/app.js', options = {} } = {}) {
  return {
    relPath,
    content,
    lines: content.split(/\r?\n/),
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    options,
  };
}

describe('commented-code check', () => {
  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(commentedCode.name).toBe('commented-code');
      expect(commentedCode.defaultEnabled).toBe(true);
      expect(commentedCode.scope).toBe('file');
      expect(typeof commentedCode.run).toBe('function');
    });

    it('registry exposes the real module in the same position', () => {
      const entry = checks.find((c) => c.name === 'commented-code');
      expect(entry).toBe(commentedCode);
      expect(checks.map((c) => c.name)).toEqual([
        'secrets',
        'commented-code',
        'todo-deadline',
        'import-exists',
        'file-naming',
        'branch-naming',
        'commit-message',
      ]);
    });
  });

  describe('reporting code-like comment blocks', () => {
    it('reports a block of exactly minLines (3) code-like // lines', () => {
      const content = [
        '// const total = a + b;',
        '// return total * 2;',
        '// console.log(total);',
      ].join('\n');
      const violations = commentedCode.run(makeCtx(content));
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'commented-code',
          message: 'commented-out code block (3 lines) (Catalog: C8)',
        },
      ]);
    });

    it('reports a /* ... */ block of code (delimiters included in the block)', () => {
      const content = [
        '/*',
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '*/',
      ].join('\n');
      const violations = commentedCode.run(makeCtx(content));
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'commented-code',
          message: 'commented-out code block (5 lines) (Catalog: C8)',
        },
      ]);
    });

    it('reports two separate blocks with correct first-line numbers', () => {
      const content = [
        '// const a = 1;',
        '// const b = 2;',
        '// const c = 3;',
        'doWork();',
        '// return a;',
        '// return b;',
        '// return c;',
      ].join('\n');
      const violations = commentedCode.run(makeCtx(content));
      expect(violations).toHaveLength(2);
      expect(violations[0].line).toBe(1);
      expect(violations[1].line).toBe(5);
      expect(violations[0].message).toBe(
        'commented-out code block (3 lines) (Catalog: C8)'
      );
    });

    it('reports # comment blocks (language-agnostic)', () => {
      const content = ['# x = 1;', '# y = 2;', '# z = 3;'].join('\n');
      const violations = commentedCode.run(makeCtx(content));
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(1);
    });

    it('reports -- comment blocks (SQL style)', () => {
      const content = [
        '-- SELECT * FROM users;',
        '-- WHERE id = 1;',
        '-- ORDER BY name;',
      ].join('\n');
      const violations = commentedCode.run(makeCtx(content));
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(1);
    });

    it('reports correct line numbers with CRLF content', () => {
      const content =
        'doWork();\r\n// const a = 1;\r\n// const b = 2;\r\n// const c = 3;\r\n';
      const violations = commentedCode.run(makeCtx(content));
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(2);
    });
  });

  describe('non-reporting cases', () => {
    it('does not report minLines-1 (2) consecutive code-like comment lines', () => {
      const content = ['// const a = 1;', '// const b = 2;'].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('does not report a block with half-or-less code-like lines', () => {
      const content = [
        '// Reads the cached settings.',
        '// Useful for startup checks.',
        '// const cache = {};',
        '// let hits = 0;',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('does not report English prose comments', () => {
      const content = [
        '// This function fetches the user record.',
        '// It returns null when the user is missing.',
        '// Callers must handle that case explicitly.',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('does not report Japanese prose comments', () => {
      const content = [
        '// この関数はユーザー情報を取得します。',
        '// データベースから読み込みます。',
        '// 失敗した場合は null を返します。',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('does not report a JSDoc block (/** first line) even with tags', () => {
      const content = [
        '/**',
        ' * Formats a display name.',
        ' * @param {string} name - raw input value',
        ' * @returns {string} formatted result',
        ' */',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('treats @tag lines as non-code-like in // blocks', () => {
      const content = [
        '// @deprecated use fetchUser() instead',
        '// @see docs/users.md',
        '// @internal helper only',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('treats eslint/prettier/@ts- directive lines as non-code-like', () => {
      const content = [
        '// eslint-disable-next-line no-console (temporary)',
        '// prettier-ignore (generated table)',
        '// @ts-expect-error legacy call site (cleanup)',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('skips license headers entirely', () => {
      const content = [
        '/*',
        ' * Copyright (c) 2026 Example Corp',
        ' * Licensed under the MIT License',
        ' * All rights reserved',
        ' */',
      ].join('\n');
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });

    it('does not treat a line-1 shebang as a comment line', () => {
      const content = ['#!/usr/bin/env node', '# x = 1;', '# y = 2;'].join('\n');
      // shebang excluded -> the block is only 2 lines < minLines
      expect(commentedCode.run(makeCtx(content))).toEqual([]);
    });
  });

  describe('options', () => {
    it('minLines is configurable (2 reports a shorter block)', () => {
      const content = ['// const a = 1;', '// const b = 2;'].join('\n');
      const violations = commentedCode.run(
        makeCtx(content, { options: { minLines: 2 } })
      );
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'commented-code',
          message: 'commented-out code block (2 lines) (Catalog: C8)',
        },
      ]);
    });

    it('handles missing options gracefully (default minLines 3)', () => {
      const short = makeCtx(['// const a = 1;', '// const b = 2;'].join('\n'));
      delete short.options;
      expect(commentedCode.run(short)).toEqual([]);

      const full = makeCtx(
        ['// const a = 1;', '// const b = 2;', '// const c = 3;'].join('\n')
      );
      delete full.options;
      expect(commentedCode.run(full)).toHaveLength(1);
    });
  });
});
