'use strict';

/**
 * Lint check: file naming conventions (Catalog C7). Disabled by default.
 *
 * `options.rules` is an array of `{ glob, pattern }`. For every rule whose
 * glob matches the file's relative path, the file's basename WITHOUT its
 * last extension (`foo.test.js` -> `foo.test`; dotfiles keep their name)
 * must match `new RegExp(pattern)`.
 *
 * Fail-closed: an invalid `pattern` regex yields a config violation for the
 * matched file instead of throwing. No rules configured -> no violations.
 */

const { globToRegExp } = require('../scan');

/** Basename of relPath with only the last extension stripped */
function stemOf(relPath) {
  const base = relPath.split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Memoized compiled rules, keyed on the options object (perf: P4) */
const compiledCache = new WeakMap();

/**
 * Compile each valid `{glob, pattern}` rule once (per options object) into
 * `{ globRe, pattern, re }`, where `re` is null when the pattern regex is
 * invalid (reported per matched file at run time, not compile time).
 */
function compileRules(options) {
  if (options && typeof options === 'object') {
    const cached = compiledCache.get(options);
    if (cached) {
      return cached;
    }
  }
  const rules = options && Array.isArray(options.rules) ? options.rules : [];
  const compiled = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object') {
      continue;
    }
    const { glob, pattern } = rule;
    if (typeof glob !== 'string' || typeof pattern !== 'string') {
      continue;
    }
    let re = null;
    try {
      re = new RegExp(pattern);
    } catch {
      re = null; // invalid: flagged when a file matches the glob
    }
    compiled.push({ globRe: globToRegExp(glob), pattern, re });
  }
  if (options && typeof options === 'object') {
    compiledCache.set(options, compiled);
  }
  return compiled;
}

module.exports = {
  name: 'file-naming',
  defaultEnabled: false,
  scope: 'file',

  /**
   * @param {{relPath: string, content: string, lines: string[],
   *          eol: 'crlf'|'lf',
   *          options?: {rules?: Array<{glob: string, pattern: string}>}}} ctx
   * @returns {Array<{file: string, line: null, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, options } = ctx;
    const rules = compileRules(options);
    if (rules.length === 0) {
      return [];
    }

    const stem = stemOf(relPath);
    const violations = [];
    const report = (message) => {
      violations.push({
        file: relPath,
        line: null,
        check: 'file-naming',
        message: `${message} (Catalog: C7)`,
      });
    };

    for (const rule of rules) {
      if (!rule.globRe.test(relPath)) {
        continue;
      }
      if (rule.re === null) {
        report(`invalid file-naming pattern '${rule.pattern}'`);
        continue;
      }
      if (!rule.re.test(stem)) {
        report(`file name does not match pattern '${rule.pattern}'`);
      }
    }

    return violations;
  },
};
