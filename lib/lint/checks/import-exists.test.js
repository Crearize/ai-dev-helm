const fs = require('fs');
const os = require('os');
const path = require('path');
const importExists = require('./import-exists');
const { checks } = require('./index');

describe('import-exists check', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-import-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a file under tmpDir, creating parent directories */
  function write(relPath, content = '') {
    const abs = path.join(tmpDir, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  /** Create a directory under tmpDir */
  function mkdir(relPath) {
    fs.mkdirSync(path.join(tmpDir, ...relPath.split('/')), {
      recursive: true,
    });
  }

  /** Build a file-scope ctx the way the runner will (absPath + rootDir) */
  function makeCtx(relPath, content, options = {}) {
    return {
      relPath,
      content,
      lines: content.split(/\r?\n/),
      eol: content.includes('\r\n') ? 'crlf' : 'lf',
      options,
      absPath: path.join(tmpDir, ...relPath.split('/')),
      rootDir: tmpDir,
    };
  }

  /** Write the importing file, then run the check on it */
  function runOn(relPath, content, options = {}) {
    write(relPath, content);
    return importExists.run(makeCtx(relPath, content, options));
  }

  describe('module shape and registry', () => {
    it('exposes the check module contract', () => {
      expect(importExists.name).toBe('import-exists');
      expect(importExists.defaultEnabled).toBe(true);
      expect(importExists.scope).toBe('file');
      expect(typeof importExists.run).toBe('function');
    });

    it('registry exposes the real module', () => {
      const entry = checks.find((c) => c.name === 'import-exists');
      expect(entry).toBe(importExists);
    });
  });

  describe('file extension gate', () => {
    it('returns [] for non-JS/TS files even with import-like text', () => {
      const violations = runOn('notes.md', "import x from './missing'\n");
      expect(violations).toEqual([]);
    });

    it('applies to each JS/TS extension', () => {
      for (const ext of ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']) {
        const violations = runOn(
          `src/app${ext}`,
          "import x from './missing';\n"
        );
        expect(violations).toHaveLength(1);
      }
    });
  });

  describe('relative specifier resolution', () => {
    it('resolves an exact relative path', () => {
      write('src/util.js');
      const violations = runOn('src/app.js', "import u from './util.js';\n");
      expect(violations).toEqual([]);
    });

    it('resolves via each extension probe', () => {
      const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];
      exts.forEach((ext, i) => {
        write(`src/m${i}/util${ext}`);
        const violations = runOn(
          `src/m${i}/app.ts`,
          "import u from './util';\n"
        );
        expect(violations).toEqual([]);
      });
    });

    it('resolves a directory via index files', () => {
      write('src/lib/index.ts');
      const violations = runOn('src/app.ts', "import lib from './lib';\n");
      expect(violations).toEqual([]);
    });

    it('resolves a .js specifier via its .ts twin (NodeNext style)', () => {
      write('src/util.ts');
      const violations = runOn('src/app.ts', "import u from './util.js';\n");
      expect(violations).toEqual([]);
    });

    it('resolves parent-relative specifiers', () => {
      write('src/util.js');
      const violations = runOn(
        'src/sub/app.js',
        "import u from '../util';\n"
      );
      expect(violations).toEqual([]);
    });

    it('reports an unresolvable relative import with its line number', () => {
      const violations = runOn(
        'src/app.js',
        "const a = 1;\nimport x from './missing';\n"
      );
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 2,
          check: 'import-exists',
          message: "unresolved relative import './missing' (Catalog: B3)",
        },
      ]);
    });
  });

  describe('builtin modules', () => {
    it('accepts node:-prefixed and bare builtin specifiers', () => {
      const violations = runOn(
        'src/app.js',
        "import fs from 'node:fs';\nconst p = require('fs');\n"
      );
      expect(violations).toEqual([]);
    });
  });

  describe('bare package specifiers', () => {
    it('accepts a package declared in dependencies without node_modules', () => {
      write('package.json', JSON.stringify({ dependencies: { lodash: '^4' } }));
      const violations = runOn('src/app.js', "import _ from 'lodash';\n");
      expect(violations).toEqual([]);
    });

    it('accepts a package present only in node_modules', () => {
      write('package.json', JSON.stringify({ name: 'fixture' }));
      mkdir('node_modules/leftover-pkg');
      const violations = runOn(
        'src/app.js',
        "import x from 'leftover-pkg';\n"
      );
      expect(violations).toEqual([]);
    });

    it('checks devDependencies, peerDependencies and optionalDependencies', () => {
      write(
        'package.json',
        JSON.stringify({
          devDependencies: { vitest: '^4' },
          peerDependencies: { react: '^18' },
          optionalDependencies: { fsevents: '^2' },
        })
      );
      const violations = runOn(
        'src/app.js',
        [
          "import v from 'vitest';",
          "import r from 'react';",
          "import f from 'fsevents';",
          '',
        ].join('\n')
      );
      expect(violations).toEqual([]);
    });

    it('reports an unknown package', () => {
      write('package.json', JSON.stringify({ dependencies: {} }));
      const violations = runOn(
        'src/app.js',
        "import g from 'ghost-pkg';\n"
      );
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'import-exists',
          message: "import of unknown package 'ghost-pkg' (Catalog: B3)",
        },
      ]);
    });

    it('reduces a scoped subpath to @scope/name', () => {
      write(
        'package.json',
        JSON.stringify({ dependencies: { '@scope/pkg': '^1' } })
      );
      const ok = runOn('src/a.js', "import s from '@scope/pkg/sub';\n");
      expect(ok).toEqual([]);

      const bad = runOn('src/b.js', "import s from '@ghost/pkg/sub';\n");
      expect(bad).toHaveLength(1);
      expect(bad[0].message).toBe(
        "import of unknown package '@ghost/pkg' (Catalog: B3)"
      );
    });
  });

  describe('aliases', () => {
    const options = { aliases: { '@/': 'src/' } };

    it('resolves an aliased specifier against rootDir', () => {
      write('src/util.ts');
      const violations = runOn(
        'src/deep/app.ts',
        "import u from '@/util';\n",
        options
      );
      expect(violations).toEqual([]);
    });

    it('reports an aliased specifier that resolves to nothing', () => {
      const violations = runOn(
        'src/app.ts',
        "import u from '@/missing';\n",
        options
      );
      expect(violations).toEqual([
        {
          file: 'src/app.ts',
          line: 1,
          check: 'import-exists',
          message: "unresolved aliased import '@/missing' (Catalog: B3)",
        },
      ]);
    });
  });

  describe('# subpath imports', () => {
    it('accepts #-specifiers when the nearest package.json has imports', () => {
      write(
        'package.json',
        JSON.stringify({ imports: { '#internal/*': './src/*' } })
      );
      const violations = runOn(
        'src/app.js',
        "import i from '#internal/util';\n"
      );
      expect(violations).toEqual([]);
    });

    it('reports #-specifiers when no imports key exists', () => {
      write('package.json', JSON.stringify({ name: 'fixture' }));
      const violations = runOn(
        'src/app.js',
        "import i from '#internal/util';\n"
      );
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 1,
          check: 'import-exists',
          message: "unresolved '#' import '#internal/util' (Catalog: B3)",
        },
      ]);
    });
  });

  describe('specifier extraction', () => {
    it('ignores specifiers on comment lines', () => {
      const violations = runOn(
        'src/app.js',
        [
          "// import x from './nope'",
          '/*',
          " import y from './nope2'",
          " require('./nope3')",
          '*/',
          '',
        ].join('\n')
      );
      expect(violations).toEqual([]);
    });

    it('extracts require, dynamic import and export-from', () => {
      const violations = runOn(
        'src/app.js',
        [
          "const a = require('./missing-a');",
          "const b = import('./missing-b');",
          "export { x } from './missing-c';",
          '',
        ].join('\n')
      );
      expect(violations).toHaveLength(3);
      expect(violations.map((v) => v.line)).toEqual([1, 2, 3]);
      expect(violations[0].message).toContain("'./missing-a'");
      expect(violations[1].message).toContain("'./missing-b'");
      expect(violations[2].message).toContain("'./missing-c'");
    });

    it('extracts side-effect imports and both quote styles', () => {
      const violations = runOn(
        'src/app.js',
        "import './missing-side';\nimport x from \"./missing-dq\";\n"
      );
      expect(violations).toHaveLength(2);
      expect(violations[0].message).toContain("'./missing-side'");
      expect(violations[1].message).toContain("'./missing-dq'");
    });

    it('treats import type like a normal import', () => {
      write('src/types.ts');
      const ok = runOn('src/a.ts', "import type { T } from './types';\n");
      expect(ok).toEqual([]);
      const bad = runOn('src/b.ts', "import type { T } from './nope';\n");
      expect(bad).toHaveLength(1);
    });

    it('ignores template literals and dynamic expressions', () => {
      const violations = runOn(
        'src/app.js',
        'const m = import(`./dyn-${name}`);\nconst n = require(base + suffix);\n'
      );
      expect(violations).toEqual([]);
    });

    it('reports correct line numbers in CRLF files', () => {
      const violations = runOn(
        'src/app.js',
        "const a = 1;\r\n\r\nimport x from './missing';\r\n"
      );
      expect(violations).toEqual([
        {
          file: 'src/app.js',
          line: 3,
          check: 'import-exists',
          message: "unresolved relative import './missing' (Catalog: B3)",
        },
      ]);
    });
  });
});
