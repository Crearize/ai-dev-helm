'use strict';

/**
 * Lint check: hardcoded secrets / credentials (Catalog B1).
 *
 * Scans each line for well-known credential shapes (AWS access keys, GitHub
 * and Slack tokens, private key blocks, generic `key = 'value'` credential
 * assignments, JWT literals) and reports one violation per matching line per
 * pattern.
 *
 * False-positive control is judged PER MATCH (never by dropping a whole line
 * because it mentions `process.env` somewhere):
 *   - a value wrapped in `<...>` (a placeholder) is ignored;
 *   - an interpolation (`${`) touching the value, or an env member access
 *     (`process.env.` / `os.environ.`) immediately preceding it, is ignored;
 *   - a suppress word (example, sample, placeholder, dummy, changeme, your-,
 *     your_) inside the value ignores it — EXCEPT for `generic-credential`,
 *     where a high-entropy value (>= 8 cleaned chars spanning >= 3 character
 *     classes) is reported despite the suppress word;
 *   - `options.allow` entries containing `/` or `*` are path globs matched
 *     against ctx.relPath (whole file suppressed); other entries are literal
 *     substrings matched against the offending line.
 */

const { globToRegExp } = require('../scan');

/** Case-insensitive markers that make a value read as a non-secret */
const SUPPRESS_WORDS = [
  'example',
  'sample',
  'placeholder',
  'dummy',
  'changeme',
  'your-',
  'your_',
];

/**
 * Detection patterns. For 'generic-credential' the suppress-word / wrapped
 * checks use capture group 1 (the quoted value); for all others, the whole
 * match.
 */
const PATTERNS = [
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    label: 'generic-credential',
    re: /(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g },
];

/** Number of characters that still count as "touching" the matched value */
const ADJACENT_WINDOW = 3;

/** Env member access that, right before the value, marks it env-derived */
const ENV_ACCESS_RE = /(?:process\.env|os\.environ)[.[]\s*['"]?$/;

/** Count of distinct character classes (upper/lower/digit/symbol) in value */
function charClasses(value) {
  let n = 0;
  if (/[a-z]/.test(value)) n += 1;
  if (/[A-Z]/.test(value)) n += 1;
  if (/[0-9]/.test(value)) n += 1;
  if (/[^A-Za-z0-9]/.test(value)) n += 1;
  return n;
}

/** Length of the value after removing suppress words and separators */
function cleanedLength(value) {
  let s = value.toLowerCase();
  for (const w of SUPPRESS_WORDS) {
    s = s.split(w).join('');
  }
  return s.replace(/[^a-z0-9]/g, '').length;
}

/** A generic-credential value with real secret entropy despite a suppress word */
function isHighEntropy(value) {
  return cleanedLength(value) >= 8 && charClasses(value) >= 3;
}

/**
 * True when a suppression signal touches THIS match: an interpolation `${`
 * adjacent to the value, or an env member access immediately preceding it.
 */
function signalAdjacent(line, start, end) {
  if (line.slice(end, end + ADJACENT_WINDOW).includes('${')) {
    return true;
  }
  if (line.slice(Math.max(0, start - ADJACENT_WINDOW), start).includes('${')) {
    return true;
  }
  const before = line.slice(Math.max(0, start - 16), start);
  return ENV_ACCESS_RE.test(before);
}

/**
 * True when a single match must be ignored.
 * @param {string} line
 * @param {RegExpExecArray} match
 * @param {string} value the secret text judged (quoted value for generic)
 * @param {string} label pattern label
 */
function matchIsSuppressed(line, match, value, label) {
  const start = match.index;
  const end = start + match[0].length;

  if (value.startsWith('<') && value.endsWith('>')) {
    return true;
  }
  if (line[start - 1] === '<' && line[end] === '>') {
    return true;
  }
  if (signalAdjacent(line, start, end)) {
    return true;
  }

  const lower = value.toLowerCase();
  if (SUPPRESS_WORDS.some((w) => lower.includes(w))) {
    // A high-entropy generic value is a real secret despite the suppress word.
    if (label === 'generic-credential' && isHighEntropy(value)) {
      return false;
    }
    return true;
  }
  return false;
}

/** Memoized compiled allow forms, keyed on the options object */
const allowCache = new WeakMap();

function compiledAllow(options) {
  if (options && typeof options === 'object') {
    const cached = allowCache.get(options);
    if (cached) {
      return cached;
    }
  }
  const allow = Array.isArray(options && options.allow) ? options.allow : [];
  const globs = [];
  const substrings = [];
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry === '') {
      continue;
    }
    if (entry.includes('/') || entry.includes('*')) {
      globs.push(globToRegExp(entry));
    } else {
      substrings.push(entry);
    }
  }
  const compiled = { globs, substrings };
  if (options && typeof options === 'object') {
    allowCache.set(options, compiled);
  }
  return compiled;
}

module.exports = {
  name: 'secrets',
  defaultEnabled: true,
  scope: 'file',

  /**
   * @param {{relPath: string, content: string, lines: string[],
   *          eol: 'crlf'|'lf', options?: {allow?: string[]}}} ctx
   * @returns {Array<{file: string, line: number, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, lines, options } = ctx;
    const { globs, substrings } = compiledAllow(options);

    if (globs.some((re) => re.test(relPath))) {
      return [];
    }

    const violations = [];
    lines.forEach((line, idx) => {
      if (substrings.some((s) => line.includes(s))) {
        return;
      }
      for (const { label, re } of PATTERNS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
          const value = label === 'generic-credential' ? match[1] : match[0];
          if (matchIsSuppressed(line, match, value, label)) {
            continue; // a later occurrence on the line may still be real
          }
          violations.push({
            file: relPath,
            line: idx + 1,
            check: 'secrets',
            message: `hardcoded secret (${label}) (Catalog: B1)`,
          });
          break; // one violation per line per pattern
        }
      }
    });

    return violations;
  },
};
