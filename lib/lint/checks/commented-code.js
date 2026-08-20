'use strict';

/**
 * Lint check: commented-out code blocks (Catalog C8).
 *
 * Scans for runs of >= options.minLines (default 3) consecutive comment
 * lines whose content is predominantly code-like, and reports ONE violation
 * per block anchored to its first line.
 *
 * Applies only to code files (see comments.isCodeExtension): markup and prose
 * files (`.md`, `.html`, `.css`, `.txt`, ...) return [] — a `/* *\/` in CSS or
 * a `#` heading in markdown is not commented-out code.
 *
 * Comment-line detection is language-agnostic (text-level) and lives in
 * comments.scanCommentLines: a trimmed line starting with `//`, `#`, or `--`,
 * or any line inside a `/* ... *\/` block. A `#!` shebang on line 1 is not a
 * comment.
 *
 * A comment line (marker stripped, trimmed) is "code-like" when it:
 *   - ends with `;`, `{`, or `}`;
 *   - is only brackets/parens/braces (e.g. `});`);
 *   - contains a simple assignment (`x = 1`, not `==`);
 *   - starts with a code keyword followed by a space or `(`;
 *   - has a call shape: an identifier directly followed by `(...)` and does
 *     not end like a sentence.
 * Doc tags (`@param`, `@ts-...`) and `eslint-disable` / `prettier-ignore`
 * directives are never code-like.
 *
 * A block is reported when more than half of its lines are code-like AND the
 * block is not predominantly natural-language prose (>= 3 consecutive
 * lowercase words, or Japanese particles, on a majority of lines). Blocks
 * whose first line opens with `/**` (doc comments) and blocks whose first
 * lines mention Copyright/License (license headers) are skipped entirely.
 */

const { scanCommentLines, isCodeExtension } = require('../comments');

const DEFAULT_MIN_LINES = 3;

/** Code keywords that mark a comment line as code-like when leading */
const KEYWORD_RE =
  /^(?:function|def|if|for|while|return|import|export|const|let|var|class|try|catch|else|switch|case|public|private|protected|void|int|string|new)[\s(]/;

/** Simple assignment: identifier-ish char, `=`, then not another `=` */
const ASSIGNMENT_RE = /[A-Za-z0-9_$\])]\s*=\s*[^=]/;

/** Call shape: identifier immediately followed by a parenthesized group */
const CALL_RE = /[A-Za-z_$][\w$]*\([^)]*\)/;

/** >= 3 consecutive lowercase words (natural-language prose signal) */
const PROSE_WORDS_RE = /[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}/;

/** Japanese particles / punctuation (natural-language prose signal) */
const JAPANESE_PROSE_RE = /[はをにがのでとへやもね、。「」]/;

/** Heuristic: does this comment text read as natural-language prose? */
function isProse(text) {
  return PROSE_WORDS_RE.test(text) || JAPANESE_PROSE_RE.test(text);
}

/** Heuristic: does this comment text look like a line of code? */
function isCodeLike(text) {
  if (text === '') {
    return false;
  }
  // Doc tags (@param, @returns, @ts-ignore, ...) are never code-like
  if (/^@\w/.test(text)) {
    return false;
  }
  // Tooling directives are never code-like
  if (text.includes('eslint-disable') || text.includes('prettier-ignore')) {
    return false;
  }
  if (/[;{}]$/.test(text)) {
    return true;
  }
  if (/^[[\](){};]+$/.test(text)) {
    return true;
  }
  if (ASSIGNMENT_RE.test(text)) {
    return true;
  }
  if (KEYWORD_RE.test(text)) {
    return true;
  }
  // Call shape: identifier(...) and does not end like a sentence.
  if (CALL_RE.test(text) && !/[.。:、]$/.test(text)) {
    return true;
  }
  return false;
}

module.exports = {
  name: 'commented-code',
  defaultEnabled: true,
  scope: 'file',

  /**
   * @param {{relPath: string, content: string, lines: string[],
   *          eol: 'crlf'|'lf', options?: {minLines?: number}}} ctx
   * @returns {Array<{file: string, line: number, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, lines, options } = ctx;
    if (!isCodeExtension(relPath)) {
      return []; // markup / prose files are out of scope
    }
    const minLines =
      options && Number.isInteger(options.minLines) && options.minLines >= 1
        ? options.minLines
        : DEFAULT_MIN_LINES;

    const scanned = scanCommentLines(lines);
    const violations = [];
    let i = 0;
    while (i < scanned.length) {
      if (!scanned[i].isComment) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < scanned.length && scanned[j].isComment) {
        j += 1;
      }
      const block = scanned.slice(i, j);
      const startLine = i + 1;
      i = j;

      if (block.length < minLines) {
        continue;
      }
      if (block[0].raw.startsWith('/**')) {
        continue; // doc comment block
      }
      // License headers: only trust the marker near the top of the block, so
      // a stray `// Copyright` inside a real commented-out block cannot exempt
      // it.
      if (block.slice(0, 3).some((l) => /copyright|license/i.test(l.raw))) {
        continue;
      }
      const codeLike = block.filter((l) => isCodeLike(l.text)).length;
      if (codeLike * 2 <= block.length) {
        continue;
      }
      // Predominantly natural-language prose: not commented-out code.
      const prose = block.filter((l) => l.text !== '' && isProse(l.text)).length;
      if (prose * 2 >= block.length) {
        continue;
      }
      violations.push({
        file: relPath,
        line: startLine,
        check: 'commented-code',
        message: `commented-out code block (${block.length} lines) (Catalog: C8)`,
      });
    }
    return violations;
  },
};
