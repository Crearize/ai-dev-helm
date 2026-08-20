const fileNaming = require('./file-naming');
const { checks } = require('./index');

describe('file-naming check', () => {
  /** Build a file-scope ctx for the check */
  function makeCtx(relPath, options = {}) {
    const content = '';
    return {
      relPath,
      content,
      lines: [''],
      eol: 'lf',
      options,
    };
  }

  function runOn(relPath, options) {
    return fileNaming.run(makeCtx(relPath, options));
  }

  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(fileNaming.name).toBe('file-naming');
      expect(fileNaming.defaultEnabled).toBe(false);
      expect(fileNaming.scope).toBe('file');
      expect(typeof fileNaming.run).toBe('function');
    });

    it('registry exposes the real module', () => {
      const entry = checks.find((c) => c.name === 'file-naming');
      expect(entry).toBe(fileNaming);
      expect(typeof entry.run).toBe('function');
    });
  });

  it('reports nothing when no rules are configured', () => {
    expect(runOn('src/FooBar.js', {})).toEqual([]);
    expect(runOn('src/FooBar.js', { rules: [] })).toEqual([]);
  });

  it('reports nothing when the file matches a rule and conforms', () => {
    const options = {
      rules: [{ glob: 'src/**', pattern: '^[a-z][a-z0-9-]*$' }],
    };
    expect(runOn('src/foo-bar.js', options)).toEqual([]);
  });

  it('reports a violation when the file matches a rule and violates it', () => {
    const options = {
      rules: [{ glob: 'src/**', pattern: '^[a-z][a-z0-9-]*$' }],
    };
    const violations = runOn('src/FooBar.js', options);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: 'src/FooBar.js',
      line: null,
      check: 'file-naming',
      message:
        "file name does not match pattern '^[a-z][a-z0-9-]*$' (Catalog: C7)",
    });
  });

  it('ignores files outside the rule glob', () => {
    const options = {
      rules: [{ glob: 'src/**', pattern: '^[a-z][a-z0-9-]*$' }],
    };
    expect(runOn('docs/FooBar.js', options)).toEqual([]);
  });

  it('applies multiple rules independently', () => {
    const options = {
      rules: [
        { glob: 'src/**', pattern: '^[a-z]' },
        { glob: '**/*.js', pattern: '^[a-z.]+$' },
      ],
    };
    // matches both rules, violates both
    const both = runOn('src/FOO.js', options);
    expect(both).toHaveLength(2);
    // matches both rules, conforms to both
    expect(runOn('src/foo.js', options)).toEqual([]);
    // matches only the second rule and violates it
    const second = runOn('docs/Bar.js', options);
    expect(second).toHaveLength(1);
    expect(second[0].message).toContain("'^[a-z.]+$'");
  });

  it('strips only the last extension before matching', () => {
    const options = { rules: [{ glob: '**/*', pattern: '^[a-z]' }] };
    // `Foo.test.js` -> stem `Foo.test` -> violates ^[a-z]
    expect(runOn('src/Foo.test.js', options)).toHaveLength(1);
    // `foo.test.js` -> stem `foo.test` -> conforms
    expect(runOn('src/foo.test.js', options)).toEqual([]);
    // stem keeps the inner dot: `foo.test` matches ^[a-z.]+$
    const dotted = { rules: [{ glob: '**/*', pattern: '^[a-z.]+$' }] };
    expect(runOn('src/foo.test.js', dotted)).toEqual([]);
  });

  it('reports invalid regex as a config violation instead of throwing', () => {
    const options = { rules: [{ glob: '**/*', pattern: '[' }] };
    let violations;
    expect(() => {
      violations = runOn('src/foo.js', options);
    }).not.toThrow();
    expect(violations).toHaveLength(1);
    expect(violations[0].check).toBe('file-naming');
    expect(violations[0].line).toBe(null);
    expect(violations[0].message).toContain("invalid file-naming pattern '['");
  });
});
