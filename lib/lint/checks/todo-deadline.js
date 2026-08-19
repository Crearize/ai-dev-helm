'use strict';

/**
 * Lint check: TODO/FIXME without deadline or issue reference (Catalog C8).
 *
 * For every line whose comment text contains a `TODO` or `FIXME` marker
 * (case-insensitive, word boundary):
 *   - neither a `(YYYY-MM-DD)` deadline nor a `(#123)` issue reference
 *     present -> violation;
 *   - a valid deadline strictly before "today" -> expired violation;
 *   - a valid today-or-future deadline, or an issue reference -> ok;
 *   - an invalid date (e.g. `(2026-13-45)`) is treated as missing.
 *
 * The marker must appear in comment context: the line is a comment line
 * (same detection as the commented-code check, including `/* ... *\/`
 * blocks), or the marker follows a comment token (`//`, `#`, `--`, `/*`)
 * later in the line. A marker inside a string literal on a plain code line
 * is not reported.
 *
 * Testability: `run(ctx)` accepts an optional `ctx.now` (Date) used as
 * "today" (local date); it defaults to `new Date()`. Tests must pass a
 * fixed `now` so they do not rot as real time passes.
 */

const { scanCommentLines } = require('./commented-code');

/** TODO / FIXME as whole words, case-insensitive */
const MARKER_RE = /\b(?:TODO|FIXME)\b/i;

/** Deadline shape: (YYYY-MM-DD) */
const DEADLINE_RE = /\((\d{4})-(\d{2})-(\d{2})\)/;

/** Issue reference shape: (#123) */
const ISSUE_REF_RE = /\(#\d+\)/;

/** Comment tokens that can start a trailing comment mid-line */
const INLINE_TOKENS = ['//', '#', '--', '/*'];

const MISSING_MESSAGE =
  'TODO/FIXME without deadline or issue reference (Catalog: C8)';

/**
 * Comment text after the earliest comment token on the line, or null when
 * the line carries no comment token.
 */
function inlineCommentText(line) {
  let bestPos = -1;
  let bestLen = 0;
  for (const token of INLINE_TOKENS) {
    const pos = line.indexOf(token);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
      bestLen = token.length;
    }
  }
  return bestPos === -1 ? null : line.slice(bestPos + bestLen);
}

/**
 * Parse a DEADLINE_RE match into a local Date, or null when the components
 * do not form a real calendar date (e.g. month 13, day 45).
 */
function parseDeadline(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
  return valid ? date : null;
}

module.exports = {
  name: 'todo-deadline',
  defaultEnabled: true,
  scope: 'file',

  /**
   * @param {{relPath: string, content: string, lines: string[],
   *          eol: 'crlf'|'lf', options?: object, now?: Date}} ctx
   * @returns {Array<{file: string, line: number, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, lines } = ctx;
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const scanned = scanCommentLines(lines);
    const violations = [];

    lines.forEach((line, idx) => {
      const commentText = scanned[idx].isComment
        ? scanned[idx].text
        : inlineCommentText(line);
      if (commentText === null || !MARKER_RE.test(commentText)) {
        return;
      }

      const deadlineMatch = commentText.match(DEADLINE_RE);
      const deadline = deadlineMatch ? parseDeadline(deadlineMatch) : null;
      if (deadline) {
        if (deadline < today) {
          const shown = `${deadlineMatch[1]}-${deadlineMatch[2]}-${deadlineMatch[3]}`;
          violations.push({
            file: relPath,
            line: idx + 1,
            check: 'todo-deadline',
            message: `TODO/FIXME deadline expired: ${shown} (Catalog: C8)`,
          });
        }
        return; // valid today-or-future deadline: ok
      }
      if (ISSUE_REF_RE.test(commentText)) {
        return; // issue reference present: ok
      }
      violations.push({
        file: relPath,
        line: idx + 1,
        check: 'todo-deadline',
        message: MISSING_MESSAGE,
      });
    });

    return violations;
  },
};
