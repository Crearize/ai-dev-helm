'use strict';

/**
 * Lint check: commented-out code blocks (Catalog C8).
 *
 * Scans for runs of >= options.minLines (default 3) consecutive comment
 * lines whose content is predominantly code-like, and reports ONE violation
 * per block anchored to its first line.
 *
 * Comment-line detection is language-agnostic (text-level): a trimmed line
 * starting with `//`, `#`, or `--`, or any line inside a `/* ... *\/` block
 * (delimiter lines included). A `#!` shebang on line 1 is not a comment.
 *
 * A comment line (marker stripped, trimmed) is "code-like" when it:
 *   - ends with `;`, `{`, or `}`;
 *   - is only brackets/parens/braces (e.g. `});`);
 *   - contains a simple assignment (`x = 1`, not `==`);
 *   - starts with a code keyword followed by a space or `(`;
 *   - looks like a function call: contains `(` and `)` and does not end
 *     with `.`, `。`, or `:`.
 * Doc tags (`@param`, `@ts-...`) and `eslint-disable` / `prettier-ignore`
 * directives are never code-like.
 *
 * A block is reported when more than half of its lines are code-like.
 * Blocks whose first line opens with `/**` (doc comments) and blocks
 * mentioning Copyright/License (license headers) are skipped entirely.
 */

const DEFAULT_MIN_LINES = 3;

/** Code keywords that mark a comment line as code-like when leading */
const KEYWORD_RE =
  /^(?:function|def|if|for|while|return|import|export|const|let|var|class|try|catch|else|switch|case|public|private|protected|void|int|string|new)[\s(]/;

/** Simple assignment: identifier-ish char, `=`, then not another `=` */
const ASSIGNMENT_RE = /[A-Za-z0-9_$\])]\s*=\s*[^=]/;

/** Strip `/*`, `*\/` delimiters and leading `*` decoration from a block line */
function stripBlockDecoration(trimmed) {
  return trimmed
    .replace(/^\/\*+/, '')
    .replace(/\*\/.*$/, '')
    .replace(/^\*+\s*/, '')
    .trim();
}

/**
 * Classify every line as comment / non-comment, tracking `/* ... *\/` state.
 * Shared with the todo-deadline check.
 * @param {string[]} lines
 * @returns {Array<{isComment: boolean, text: string, raw: string}>}
 *   `text` is the comment content with the marker stripped and trimmed;
 *   `raw` is the trimmed original line.
 */
function scanCommentLines(lines) {
  const result = [];
  let inBlock = false;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {
        inBlock = false;
      }
      result.push({
        isComment: true,
        text: stripBlockDecoration(trimmed),
        raw: trimmed,
      });
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.slice(2).includes('*/')) {
        inBlock = true;
      }
      result.push({
        isComment: true,
        text: stripBlockDecoration(trimmed),
        raw: trimmed,
      });
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('--')) {
      result.push({
        isComment: true,
        text: trimmed.slice(2).trim(),
        raw: trimmed,
      });
      return;
    }
    if (trimmed.startsWith('#') && !(idx === 0 && trimmed.startsWith('#!'))) {
      result.push({
        isComment: true,
        text: trimmed.replace(/^#+\s*/, '').trim(),
        raw: trimmed,
      });
      return;
    }
    result.push({ isComment: false, text: '', raw: trimmed });
  });
  return result;
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
  // Function-call-looking: has parens and does not end like a sentence
  if (text.includes('(') && text.includes(')') && !/[.。:]$/.test(text)) {
    return true;
  }
  return false;
}

module.exports = {
  name: 'commented-code',
  defaultEnabled: true,
  scope: 'file',
  scanCommentLines,

  /**
   * @param {{relPath: string, content: string, lines: string[],
   *          eol: 'crlf'|'lf', options?: {minLines?: number}}} ctx
   * @returns {Array<{file: string, line: number, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const { relPath, lines, options } = ctx;
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
      if (block.some((l) => /copyright|license/i.test(l.raw))) {
        continue; // license header
      }
      const codeLike = block.filter((l) => isCodeLike(l.text)).length;
      if (codeLike * 2 > block.length) {
        violations.push({
          file: relPath,
          line: startLine,
          check: 'commented-code',
          message: `commented-out code block (${block.length} lines) (Catalog: C8)`,
        });
      }
    }
    return violations;
  },
};
