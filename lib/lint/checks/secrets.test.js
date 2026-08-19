const path = require('path');
const { readFileText } = require('../scan');
const secrets = require('./secrets');
const { checks } = require('./index');

const FIXTURES_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'lint',
  'secrets'
);

/** Build a file-scope check ctx the way the runner will */
function makeCtx(content, { relPath = 'src/app.js', options = { allow: [] } } = {}) {
  return {
    relPath,
    content,
    lines: content.split(/\r?\n/),
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    options,
  };
}

function ctxFromFixture(name) {
  const abs = path.join(FIXTURES_DIR, name);
  const { content, eol } = readFileText(abs);
  return {
    relPath: `test/fixtures/lint/secrets/${name}`,
    content,
    lines: content.split(/\r?\n/),
    eol,
    options: { allow: [] },
  };
}

describe('secrets check', () => {
  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(secrets.name).toBe('secrets');
      expect(secrets.defaultEnabled).toBe(true);
      expect(secrets.scope).toBe('file');
      expect(typeof secrets.run).toBe('function');
    });

    it('registry exposes the real module', () => {
      const entry = checks.find((c) => c.name === 'secrets');
      expect(entry).toBe(secrets);
      expect(entry.scope).toBe('file');
    });
  });

  describe('violation fixtures (LF and CRLF)', () => {
    const expected = [
      { line: 2, label: 'aws-access-key' },
      { line: 3, label: 'github-token' },
      { line: 4, label: 'slack-token' },
      { line: 5, label: 'private-key' },
      { line: 6, label: 'generic-credential' },
      { line: 7, label: 'jwt' },
    ];

    it.each(['violation.lf.js', 'violation.crlf.js'])(
      'reports exactly 6 findings with correct lines in %s',
      (name) => {
        const ctx = ctxFromFixture(name);
        const violations = secrets.run(ctx);

        expect(violations).toHaveLength(6);
        expected.forEach(({ line, label }, i) => {
          expect(violations[i]).toEqual({
            file: ctx.relPath,
            line,
            check: 'secrets',
            message: `hardcoded secret (${label}) (Catalog: B1)`,
          });
        });
      }
    );

    it('preserves fixture line endings on disk', () => {
      expect(ctxFromFixture('violation.lf.js').eol).toBe('lf');
      expect(ctxFromFixture('violation.crlf.js').eol).toBe('crlf');
    });
  });

  describe('detection patterns (unit)', () => {
    const cases = [
      ['aws-access-key', "const a = 'AKIA0000000000000001';"],
      ['github-token', "const a = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';"],
      ['slack-token', "const a = 'xoxb-notarealslacktoken0';"],
      ['private-key', "const a = '-----BEGIN RSA PRIVATE KEY-----';"],
      ['generic-credential', "const password = 'hunter2hunter2hunter2';"],
      ['jwt', "const a = 'eyJAAAAAAAAAAAA.eyJBBBBBBBBBBBB.CCCCCCCC';"],
    ];

    it.each(cases)('detects %s', (label, line) => {
      const violations = secrets.run(makeCtx(line));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        file: 'src/app.js',
        line: 1,
        check: 'secrets',
        message: `hardcoded secret (${label}) (Catalog: B1)`,
      });
    });

    it('reports both patterns when one line matches two different patterns', () => {
      // "apiToken" triggers generic-credential; the value triggers aws-access-key
      const violations = secrets.run(
        makeCtx("const apiToken = 'AKIA0000000000000009';")
      );
      const labels = violations.map((v) => v.message).sort();
      expect(violations).toHaveLength(2);
      expect(labels).toEqual([
        'hardcoded secret (aws-access-key) (Catalog: B1)',
        'hardcoded secret (generic-credential) (Catalog: B1)',
      ]);
    });

    it('reports once when the same pattern matches twice on one line', () => {
      const violations = secrets.run(
        makeCtx("check('AKIA0000000000000001', 'AKIA0000000000000002');")
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toBe(
        'hardcoded secret (aws-access-key) (Catalog: B1)'
      );
    });
  });

  describe('suppression (unit)', () => {
    const suppressed = [
      [
        'process.env on the line',
        "const a = process.env.AWS_KEY || 'AKIA0000000000000002';",
      ],
      ['${ interpolation on the line', 'const a = `AKIA0000000000000003-${suffix}`;'],
      ['<...> placeholder around the value', "const a = '<AKIA0000000000000004>';"],
      ['suppress word in the value', "const password = 'changeme-please-now';"],
      [
        'os.environ on the line',
        'aws = os.environ.get("AWS", "AKIA0000000000000005")',
      ],
    ];

    it.each(suppressed)('suppresses: %s', (_desc, line) => {
      expect(secrets.run(makeCtx(line))).toEqual([]);
    });

    it('applies suppress words to all patterns, not only generic-credential', () => {
      expect(secrets.run(makeCtx("const a = 'AKIAIOSFODNN7EXAMPLE';"))).toEqual([]);
    });

    it('applies suppress words to the quoted value of generic-credential', () => {
      expect(
        secrets.run(makeCtx("const secret = 'your_secret_here_1';"))
      ).toEqual([]);
    });

    it('ok fixture produces zero findings', () => {
      expect(secrets.run(ctxFromFixture('ok.js'))).toEqual([]);
    });
  });

  describe('options.allow', () => {
    const line = "const a = 'AKIA0000000000000001';";

    it('suppresses the whole file when a glob entry matches relPath', () => {
      const violations = secrets.run(
        makeCtx(line, {
          relPath: 'test/fixtures/data.js',
          options: { allow: ['test/fixtures/**'] },
        })
      );
      expect(violations).toEqual([]);
    });

    it('does not suppress when the glob entry does not match relPath', () => {
      const violations = secrets.run(
        makeCtx(line, {
          relPath: 'src/app.js',
          options: { allow: ['test/fixtures/**'] },
        })
      );
      expect(violations).toHaveLength(1);
    });

    it('suppresses lines containing a literal substring entry', () => {
      const violations = secrets.run(
        makeCtx(line, { options: { allow: ['AKIA0000000000000001'] } })
      );
      expect(violations).toEqual([]);
    });

    it('substring entries only suppress matching lines', () => {
      const content = [
        "const a = 'AKIA0000000000000001';",
        "const b = 'AKIA0000000000000002';",
      ].join('\n');
      const violations = secrets.run(
        makeCtx(content, { options: { allow: ['AKIA0000000000000001'] } })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(2);
    });

    it('handles missing options gracefully', () => {
      const ctx = makeCtx(line);
      delete ctx.options;
      expect(secrets.run(ctx)).toHaveLength(1);
    });
  });
});
