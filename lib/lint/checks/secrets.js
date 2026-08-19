'use strict';

/**
 * Lint check: hardcoded secrets / credentials (Catalog B1).
 *
 * Scans each line for well-known credential shapes (AWS access keys, GitHub
 * and Slack tokens, private key blocks, generic `key = 'value'` credential
 * assignments, JWT literals) and reports one violation per matching line per
 * pattern.
 *
 * False-positive control:
 *   - lines referencing `process.env`, `os.environ`, or `${` interpolation
 *     are skipped entirely;
 *   - a value wrapped in `<...>` (a placeholder) is ignored;
 *   - a value containing a suppress word (example, sample, placeholder,
 *     dummy, changeme, your-/your_) is ignored — for every pattern, the
 *     "value" being the matched secret text (the quoted value for the
 *     generic pattern);
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

/** True when the whole line must be skipped (env lookups, interpolation) */
function lineIsSuppressed(line) {
  return (
    line.includes('process.env') ||
    line.includes('os.environ') ||
    line.includes('${')
  );
}

/**
 * True when a single match must be ignored: the value contains a suppress
 * word, or the value sits inside a `<...>` placeholder (either the quoted
 * value itself is `<...>`, or the match is directly wrapped in `<` / `>`
 * on the line).
 */
function matchIsSuppressed(line, match, value) {
  const lower = value.toLowerCase();
  if (SUPPRESS_WORDS.some((w) => lower.includes(w))) {
    return true;
  }
  if (value.startsWith('<') && value.endsWith('>')) {
    return true;
  }
  const start = match.index;
  const end = start + match[0].length;
  return line[start - 1] === '<' && line[end] === '>';
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
    const allow = Array.isArray(options && options.allow) ? options.allow : [];

    const allowGlobs = [];
    const allowSubstrings = [];
    for (const entry of allow) {
      if (typeof entry !== 'string' || entry === '') {
        continue;
      }
      if (entry.includes('/') || entry.includes('*')) {
        allowGlobs.push(globToRegExp(entry));
      } else {
        allowSubstrings.push(entry);
      }
    }
    if (allowGlobs.some((re) => re.test(relPath))) {
      return [];
    }

    const violations = [];
    lines.forEach((line, idx) => {
      if (lineIsSuppressed(line)) {
        return;
      }
      if (allowSubstrings.some((s) => line.includes(s))) {
        return;
      }
      for (const { label, re } of PATTERNS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(line)) !== null) {
          const value = label === 'generic-credential' ? match[1] : match[0];
          if (matchIsSuppressed(line, match, value)) {
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
