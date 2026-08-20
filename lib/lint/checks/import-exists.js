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
 * `ctx.rootDir` (the scan root). An optional `ctx.cache`
 * ({ kind: Map, manifest: Map }) memoizes filesystem probes across files in a
 * run; when absent, fresh per-call Maps are used.
 *
 * Extraction (regex, string literals only — template literals and dynamic
 * expressions are never checked; full comment lines are skipped; a `from`,
 * `require` or `import(` that itself sits inside a string literal is ignored):
 *   - `import ... from '<spec>'` / side-effect `import '<spec>'`
 *   - `export ... from '<spec>'`
 *   - `require('<spec>')` and dynamic `import('<spec>')`
 *
 * Resolution:
 *   1. Relative specifiers resolve against the importing file's directory.
 *   2. `node:`-prefixed or builtin names are always ok.
 *   3. `options.aliases` rewrite by longest prefix, then resolve against
 *      `ctx.rootDir`. `tsconfig.json`/`jsconfig.json` `compilerOptions.paths`
 *      (honoring `baseUrl`) supply fallback aliases UNDER explicit aliases.
 *   4. Bare specifiers reduce to a package name and must appear in a nearby
 *      package.json dependency field or `node_modules`.
 *   5. `#`-prefixed specifiers are ok when the nearest package.json has an
 *      `imports` key at all (lenient).
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { scanCommentLines, isIndexInString } = require('../comments');

/** builtin module names as a Set for O(1) membership (perf) */
const BUILTIN_MODULES = new Set(builtinModules);

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

/**
 * Collect unique string-literal specifiers from one code line. Each keyword
 * (`from` / `require` / `import(`) must sit outside any string literal, so a
 * quoted example like `"copied from 'legacy/foo'"` is not mistaken for an
 * import.
 */
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
      if (!isIndexInString(line, m.index)) {
        specs.add(m[2]);
      }
    }
  }
  return [...specs];
}

/** Ensure a usable cache object even when the runner did not supply one */
function ensureCache(cache) {
  if (cache && cache.kind instanceof Map && cache.manifest instanceof Map) {
    return cache;
  }
  return { kind: new Map(), manifest: new Map() };
}

/** Memoized stat kind of absPath: 'file' | 'dir' | 'none' */
function statKind(absPath, cache) {
  const hit = cache.kind.get(absPath);
  if (hit !== undefined) {
    return hit;
  }
  let kind = 'none';
  try {
    const s = fs.statSync(absPath);
    kind = s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
  } catch {
    kind = 'none';
  }
  cache.kind.set(absPath, kind);
  return kind;
}

const isFile = (absPath, cache) => statKind(absPath, cache) === 'file';
const isDir = (absPath, cache) => statKind(absPath, cache) === 'dir';

/**
 * Resolve a relative/aliased target (already joined to an absolute base
 * path, extension possibly missing) using the probe order.
 */
function resolvesToFile(absTarget, cache) {
  if (isFile(absTarget, cache)) {
    return true;
  }
  for (const ext of PROBE_EXTS) {
    if (isFile(absTarget + ext, cache)) {
      return true;
    }
  }
  for (const ext of PROBE_EXTS) {
    if (isFile(path.join(absTarget, `index${ext}`), cache)) {
      return true;
    }
  }
  // NodeNext style: `./util.js` is fine when util.ts / util.tsx exists
  if (absTarget.endsWith('.js')) {
    const stem = absTarget.slice(0, -3);
    if (isFile(`${stem}.ts`, cache) || isFile(`${stem}.tsx`, cache)) {
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

/** Parse a package.json at dir (memoized), or null when absent/invalid */
function readPackageJson(dir, cache) {
  if (cache.manifest.has(dir)) {
    return cache.manifest.get(dir);
  }
  const file = path.join(dir, 'package.json');
  let manifest = null;
  if (isFile(file, cache)) {
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      manifest = null;
    }
  }
  cache.manifest.set(dir, manifest);
  return manifest;
}

/**
 * True when `pkg` is declared in the nearest package.json's dependency
 * fields (own properties only), or `node_modules/<pkg>` exists at any level.
 */
function packageIsKnown(pkg, fileDir, rootDir, cache) {
  let nearestChecked = false;
  for (const dir of walkUpDirs(fileDir, rootDir)) {
    if (isDir(path.join(dir, 'node_modules', ...pkg.split('/')), cache)) {
      return true;
    }
    if (!nearestChecked) {
      const manifest = readPackageJson(dir, cache);
      if (manifest !== null) {
        nearestChecked = true;
        for (const field of DEP_FIELDS) {
          const deps = manifest[field];
          if (
            deps &&
            typeof deps === 'object' &&
            Object.prototype.hasOwnProperty.call(deps, pkg)
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** True when the nearest package.json (walking up) has an `imports` key */
function hasImportsField(fileDir, rootDir, cache) {
  for (const dir of walkUpDirs(fileDir, rootDir)) {
    const manifest = readPackageJson(dir, cache);
    if (manifest !== null) {
      return Object.prototype.hasOwnProperty.call(manifest, 'imports');
    }
  }
  return false;
}

/**
 * Read `compilerOptions.paths` from tsconfig.json (then jsconfig.json) at
 * rootDir and convert `"@/*": ["./src/*"]`-style entries into prefix aliases
 * (`{ '@/': 'src/' }`) resolved relative to rootDir via `baseUrl`. Malformed
 * config is ignored (returns {}), never thrown. Memoized on cache.
 */
function tsconfigAliases(rootDir, cache) {
  if (!cache.tsAliases) {
    cache.tsAliases = new Map();
  }
  if (cache.tsAliases.has(rootDir)) {
    return cache.tsAliases.get(rootDir);
  }
  const aliases = {};
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(rootDir, name);
    if (!isFile(file, cache)) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // malformed config: ignore, do not crash
    }
    const co =
      parsed && typeof parsed.compilerOptions === 'object'
        ? parsed.compilerOptions
        : null;
    if (!co) {
      continue;
    }
    const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : '.';
    const paths = co.paths && typeof co.paths === 'object' ? co.paths : {};
    for (const key of Object.keys(paths)) {
      if (!key.endsWith('/*')) {
        continue;
      }
      const target = paths[key];
      if (!Array.isArray(target) || typeof target[0] !== 'string') {
        continue;
      }
      const targetPrefix = target[0].endsWith('/*')
        ? target[0].slice(0, -1)
        : target[0];
      const prefixKey = key.slice(0, -1); // drop trailing '*', keep '/'
      // Value relative to rootDir, honoring baseUrl; keep '/'-separated.
      const value = path
        .join(baseUrl, targetPrefix)
        .split(path.sep)
        .join('/');
      const normalized = value === '.' ? '' : `${value}/`.replace(/\/+$/, '/');
      if (!Object.prototype.hasOwnProperty.call(aliases, prefixKey)) {
        aliases[prefixKey] = normalized;
      }
    }
    if (Object.keys(aliases).length > 0) {
      break; // first config that provides paths wins (tsconfig over jsconfig)
    }
  }
  cache.tsAliases.set(rootDir, aliases);
  return aliases;
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
   *          absPath: string, rootDir: string,
   *          cache?: {kind: Map, manifest: Map}}} ctx
   * @returns {Array<{file: string, line: number, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, lines, options } = ctx;
    if (!TARGET_EXTS.has(path.extname(relPath).toLowerCase())) {
      return [];
    }

    const cache = ensureCache(ctx.cache);
    const fileDir = path.dirname(ctx.absPath);
    const explicitAliases =
      options && options.aliases && typeof options.aliases === 'object'
        ? options.aliases
        : {};
    // Explicit aliases win; tsconfig/jsconfig paths are the fallback.
    const aliases = { ...tsconfigAliases(ctx.rootDir, cache), ...explicitAliases };

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
          if (!resolvesToFile(path.resolve(fileDir, spec), cache)) {
            report(idx, `unresolved relative import '${spec}'`);
          }
          continue;
        }
        if (spec.startsWith('node:')) {
          continue;
        }
        if (spec.startsWith('#')) {
          if (!hasImportsField(fileDir, ctx.rootDir, cache)) {
            report(idx, `unresolved '#' import '${spec}'`);
          }
          continue;
        }
        const aliasKey = matchAlias(spec, aliases);
        if (aliasKey !== null) {
          const rewritten = aliases[aliasKey] + spec.slice(aliasKey.length);
          if (!resolvesToFile(path.resolve(ctx.rootDir, rewritten), cache)) {
            report(idx, `unresolved aliased import '${spec}'`);
          }
          continue;
        }
        if (path.isAbsolute(spec)) {
          continue; // out of scope; avoid false positives
        }
        const pkg = packageName(spec);
        if (BUILTIN_MODULES.has(spec) || BUILTIN_MODULES.has(pkg)) {
          continue;
        }
        if (!packageIsKnown(pkg, fileDir, ctx.rootDir, cache)) {
          report(idx, `import of unknown package '${pkg}'`);
        }
      }
    });

    return violations;
  },
};
