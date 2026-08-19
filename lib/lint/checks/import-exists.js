'use strict';

/**
 * Lint check: hallucinated imports (Catalog B3).
 *
 * Verifies, text-level, that every import specifier in a JS/TS file points
 * at something that exists. Applies only to `.js .jsx .ts .tsx .mjs .cjs`
 * files; other files yield no violations.
 *
 * Runner contract: in addition to the standard file-scope ctx, this check
 * requires `ctx.absPath` (absolute path of the file being linted) and
 * `ctx.rootDir` (the scan root) because resolution needs the filesystem.
 * The runner must provide both for this check.
 *
 * Extraction (regex, string literals only — template literals and dynamic
 * expressions are never checked; full comment lines are skipped):
 *   - `import ... from '<spec>'` / side-effect `import '<spec>'`
 *   - `export ... from '<spec>'`
 *   - `require('<spec>')` and dynamic `import('<spec>')`
 *
 * Resolution:
 *   1. Relative specifiers resolve against the importing file's directory:
 *      exact file, appended extensions (.ts .tsx .js .jsx .mjs .cjs .json
 *      .d.ts), directory + /index with those extensions, and NodeNext-style
 *      `.js` -> `.ts`/`.tsx` twins. Unresolvable -> violation.
 *   2. `node:`-prefixed or `module.builtinModules` names are always ok.
 *   3. `options.aliases` (e.g. { "@/": "src/" }) rewrite by longest prefix,
 *      then resolve like a relative path against `ctx.rootDir`.
 *   4. Bare specifiers reduce to a package name (first segment, or two for
 *      @scope/name). Ok when the nearest package.json walking up from the
 *      file (stopping at ctx.rootDir inclusive) lists it in dependencies /
 *      devDependencies / peerDependencies / optionalDependencies, or when
 *      `node_modules/<pkg>` exists at any walked level.
 *   5. `#`-prefixed specifiers are ok when the nearest package.json has an
 *      `imports` key at all (lenient, FP-avoidance).
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { scanCommentLines } = require('./commented-code');

/** File extensions this check applies to */
const TARGET_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/** Extensions probed when resolving relative/aliased specifiers */
const PROBE_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.d.ts',
];

/** package.json fields consulted for declared packages */
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** `import ... from '<spec>'` / `export ... from '<spec>'` */
const FROM_RE = /\bfrom\s+(['"])([^'"]+)\1/g;

/** Side-effect `import '<spec>'` at line start */
const SIDE_EFFECT_RE = /^\s*import\s+(['"])([^'"]+)\1/;

/** `require('<spec>')` */
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/** Dynamic `import('<spec>')` */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/** Collect unique string-literal specifiers from one code line */
function extractSpecifiers(line) {
  const specs = new Set();
  const side = line.match(SIDE_EFFECT_RE);
  if (side) {
    specs.add(side[2]);
  }
  for (const re of [FROM_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      specs.add(m[2]);
    }
  }
  return [...specs];
}

/** True when absPath exists and is a file */
function isFile(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/** True when absPath exists and is a directory */
function isDir(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a relative/aliased target (already joined to an absolute base
 * path, extension possibly missing) using the probe order:
 * exact file -> appended extensions -> directory index files -> .js twins.
 */
function resolvesToFile(absTarget) {
  if (isFile(absTarget)) {
    return true;
  }
  for (const ext of PROBE_EXTS) {
    if (isFile(absTarget + ext)) {
      return true;
    }
  }
  for (const ext of PROBE_EXTS) {
    if (isFile(path.join(absTarget, `index${ext}`))) {
      return true;
    }
  }
  // NodeNext style: `./util.js` is fine when util.ts / util.tsx exists
  if (absTarget.endsWith('.js')) {
    const stem = absTarget.slice(0, -3);
    if (isFile(`${stem}.ts`) || isFile(`${stem}.tsx`)) {
      return true;
    }
  }
  return false;
}

/** Package name of a bare specifier: first segment, or two for @scope/name */
function packageName(spec) {
  const segments = spec.split('/');
  if (spec.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : spec;
  }
  return segments[0];
}

/**
 * Directories from the importing file's directory up to rootDir inclusive.
 * Stops early if the walk escapes rootDir or reaches the fs root.
 */
function walkUpDirs(fileDir, rootDir) {
  const root = path.resolve(rootDir);
  const dirs = [];
  let dir = path.resolve(fileDir);
  for (;;) {
    dirs.push(dir);
    if (dir === root) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir || path.relative(root, parent).startsWith('..')) {
      break;
    }
    dir = parent;
  }
  return dirs;
}

/** Parse a package.json at dir, or null when absent/unreadable/invalid */
function readPackageJson(dir) {
  const file = path.join(dir, 'package.json');
  if (!isFile(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True when `pkg` is declared in the nearest package.json's dependency
 * fields, or `node_modules/<pkg>` exists at any level between the file and
 * rootDir (inclusive).
 */
function packageIsKnown(pkg, fileDir, rootDir) {
  let nearestChecked = false;
  for (const dir of walkUpDirs(fileDir, rootDir)) {
    if (isDir(path.join(dir, 'node_modules', ...pkg.split('/')))) {
      return true;
    }
    if (!nearestChecked) {
      const manifest = readPackageJson(dir);
      if (manifest !== null) {
        nearestChecked = true;
        for (const field of DEP_FIELDS) {
          const deps = manifest[field];
          if (deps && typeof deps === 'object' && pkg in deps) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** True when the nearest package.json (walking up) has an `imports` key */
function hasImportsField(fileDir, rootDir) {
  for (const dir of walkUpDirs(fileDir, rootDir)) {
    const manifest = readPackageJson(dir);
    if (manifest !== null) {
      return Object.prototype.hasOwnProperty.call(manifest, 'imports');
    }
  }
  return false;
}

/** Longest alias key that prefixes spec, or null */
function matchAlias(spec, aliases) {
  if (!aliases || typeof aliases !== 'object') {
    return null;
  }
  let best = null;
  for (const key of Object.keys(aliases)) {
    if (!key || !spec.startsWith(key)) {
      continue;
    }
    if (best === null || key.length > best.length) {
      best = key;
    }
  }
  return best;
}

module.exports = {
  name: 'import-exists',
  defaultEnabled: true,
  scope: 'file',

  /**
   * @param {{relPath: string, content: string, lines: string[],
   *          eol: 'crlf'|'lf', options?: {aliases?: Object<string,string>},
   *          absPath: string, rootDir: string}} ctx
   * @returns {Array<{file: string, line: number, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, lines, options } = ctx;
    if (!TARGET_EXTS.has(path.extname(relPath).toLowerCase())) {
      return [];
    }

    const fileDir = path.dirname(ctx.absPath);
    const aliases = options && options.aliases;
    const scanned = scanCommentLines(lines);
    const violations = [];
    const report = (idx, message) => {
      violations.push({
        file: relPath,
        line: idx + 1,
        check: 'import-exists',
        message: `${message} (Catalog: B3)`,
      });
    };

    lines.forEach((line, idx) => {
      if (scanned[idx].isComment) {
        return;
      }
      for (const spec of extractSpecifiers(line)) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          if (!resolvesToFile(path.resolve(fileDir, spec))) {
            report(idx, `unresolved relative import '${spec}'`);
          }
          continue;
        }
        if (spec.startsWith('node:')) {
          continue;
        }
        if (spec.startsWith('#')) {
          if (!hasImportsField(fileDir, ctx.rootDir)) {
            report(idx, `unresolved '#' import '${spec}'`);
          }
          continue;
        }
        const aliasKey = matchAlias(spec, aliases);
        if (aliasKey !== null) {
          const rewritten = aliases[aliasKey] + spec.slice(aliasKey.length);
          if (!resolvesToFile(path.resolve(ctx.rootDir, rewritten))) {
            report(idx, `unresolved aliased import '${spec}'`);
          }
          continue;
        }
        if (path.isAbsolute(spec)) {
          continue; // out of scope; avoid false positives
        }
        const pkg = packageName(spec);
        if (builtinModules.includes(spec) || builtinModules.includes(pkg)) {
          continue;
        }
        if (!packageIsKnown(pkg, fileDir, ctx.rootDir)) {
          report(idx, `import of unknown package '${pkg}'`);
        }
      }
    });

    return violations;
  },
};
