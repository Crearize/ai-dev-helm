const todoDeadline = require('./todo-deadline');
const { checks } = require('./index');

/** Fixed "today" so tests never rot: 2026-08-20 (local time) */
const FIXED_NOW = new Date(2026, 7, 20);

const MISSING_MSG =
  'TODO/FIXME without deadline or issue reference (Catalog: C8)';

/** Build a file-scope check ctx the way the runner will */
function makeCtx(
  content,
  { relPath = 'src/app.js', options = {}, now = FIXED_NOW } = {}
) {
  return {
    relPath,
    content,
    lines: content.split(/\r?\n/),
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    options,
    now,
  };
}

describe('todo-deadline check', () => {
  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(todoDeadline.name).toBe('todo-deadline');
      expect(todoDeadline.defaultEnabled).toBe(true);
      expect(todoDeadline.scope).toBe('file');
      expect(typeof todoDeadline.run).toBe('function');
    });

    it('registry exposes the real module', () => {
      const entry = checks.find((c) => c.name === 'todo-deadline');
      expect(entry).toBe(todoDeadline);
    });
  });

  describe('missing deadline / issue reference', () => {
    it('reports a TODO without deadline or issue ref', () => {
      const violations = todoDeadline.run(makeCtx('// TODO: refactor this'));
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'todo-deadline',
          message: MISSING_MSG,
        },
      ]);
    });

    it('reports a FIXME in a # comment', () => {
      const violations = todoDeadline.run(makeCtx('# FIXME handle errors'));
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toBe(MISSING_MSG);
    });

    it('detects lowercase todo in a comment', () => {
      const violations = todoDeadline.run(makeCtx('// todo: cleanup'));
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toBe(MISSING_MSG);
    });

    it('treats an invalid date like (2026-13-45) as missing', () => {
      const violations = todoDeadline.run(
        makeCtx('// TODO(2026-13-45): fix parser')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toBe(MISSING_MSG);
    });

    it('detects markers in trailing comments after code', () => {
      const violations = todoDeadline.run(
        makeCtx('const x = 1; // TODO: rename')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(1);
    });

    it('detects markers in SQL-style -- comments', () => {
      const violations = todoDeadline.run(
        makeCtx('SELECT 1 -- TODO add index')
      );
      expect(violations).toHaveLength(1);
    });

    it('detects markers inside /* */ block comment lines', () => {
      const content = ['/*', ' * TODO: revisit this design', ' */'].join('\n');
      const violations = todoDeadline.run(makeCtx(content));
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(2);
    });
  });

  describe('satisfied markers (no violation)', () => {
    it('accepts an issue reference (#123)', () => {
      expect(
        todoDeadline.run(makeCtx('// TODO: refactor this (#123)'))
      ).toEqual([]);
    });

    it('accepts a future deadline (2099-01-01)', () => {
      expect(
        todoDeadline.run(makeCtx('// TODO(2099-01-01): refactor'))
      ).toEqual([]);
    });

    it('accepts a deadline equal to today (not strictly before)', () => {
      expect(todoDeadline.run(makeCtx('// TODO(2026-08-20): ship'))).toEqual(
        []
      );
    });
  });

  describe('expired deadlines', () => {
    it('reports an expired deadline with the date in the message', () => {
      const violations = todoDeadline.run(
        makeCtx('// FIXME(2020-05-01): handle nulls')
      );
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'todo-deadline',
          message: 'TODO/FIXME deadline expired: 2020-05-01 (Catalog: C8)',
        },
      ]);
    });

    it('reports a deadline of yesterday relative to ctx.now', () => {
      const violations = todoDeadline.run(
        makeCtx('// TODO(2026-08-19): finish this')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toBe(
        'TODO/FIXME deadline expired: 2026-08-19 (Catalog: C8)'
      );
    });
  });

  describe('non-comment context', () => {
    it('ignores TODO inside a string literal on a non-comment line', () => {
      expect(todoDeadline.run(makeCtx('const s = "TODO: x";'))).toEqual([]);
    });

    it('does not match TODO/FIXME as part of a longer word', () => {
      expect(
        todoDeadline.run(makeCtx('// update the todoList component'))
      ).toEqual([]);
      expect(todoDeadline.run(makeCtx('// several TODOS remain here'))).toEqual(
        []
      );
    });

    it('ignores lines without any marker', () => {
      expect(todoDeadline.run(makeCtx('// plain comment\ncode();'))).toEqual(
        []
      );
    });
  });

  describe('line numbers and defaults', () => {
    it('reports correct line numbers with CRLF content', () => {
      const content =
        '// TODO: a\r\n// ok line\r\nconst x = 1; // FIXME: b\r\n';
      const violations = todoDeadline.run(makeCtx(content));
      expect(violations).toHaveLength(2);
      expect(violations[0].line).toBe(1);
      expect(violations[1].line).toBe(3);
    });

    it('defaults ctx.now to the current date when absent', () => {
      const ctx = makeCtx('// TODO: no deadline here');
      delete ctx.now;
      const violations = todoDeadline.run(ctx);
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toBe(MISSING_MSG);
    });
  });
});
