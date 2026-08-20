'use strict';

/**
 * Shared comment/markdown/string text utilities for the lint checks.
 *
 * Three concerns live here so the checks agree on them:
 *   1. Which file extensions count as "code" (for the commented-code check).
 *   2. Markdown awareness (skip fenced ``` regions, treat leading `#` as a
 *      heading rather than a comment) so prose docs are not scanned as code.
 *   3. Quote-aware, string-literal-safe scanning: comment tokens and import
 *      keywords inside a string literal must not be treated as real.
 *
 * `scanCommentLines` is memoized per `lines` array (a WeakMap) so the three
 * file-scope checks that consume it (commented-code, the deadline-marker
 * check, and import-exists) derive it once per file rather than three times.
 */

const path = require('path');

/**
 * Extensions whose `//`, `#`, `--`, `/* *\/` comments can hold commented-out
 * code. HTML/CSS/markdown/JSON/YAML and other markup are deliberately absent:
 * a `/* *\/` in CSS or a `#` heading in markdown is not "commented-out code".
 */
const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.gradle',
  '.py', '.rb', '.go', '.rs', '.php', '.swift', '.dart', '.lua',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.cs',
  '.sql', '.sh', '.bash', '.zsh', '.pl', '.pm', '.r',
]);

/** Markdown extensions (the deadline check still scans these, md-aware) */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

/** True when relPath's extension is one the commented-code check applies to */
function isCodeExtension(relPath) {
  return CODE_EXTENSIONS.has(path.extname(String(relPath)).toLowerCase());
}

/** True when relPath is a markdown document */
function isMarkdown(relPath) {
  return MARKDOWN_EXTENSIONS.has(path.extname(String(relPath)).toLowerCase());
}

/**
 * The earliest comment token that begins OUTSIDE any string literal, or null.
 * Tracks `'`, `"` and backtick string state with `\` escaping so that a token
 * such as `//` inside `"https://..."` or `#` inside `"#tag"` is not treated
 * as a comment start.
 * @param {string} line
 * @param {{markdown?: boolean}} [opts] markdown drops `#` as a comment token
 *   (a leading `#` there is a heading, handled by the caller)
 * @returns {{index: number, token: string}|null}
 */
function commentStart(line, opts = {}) {
  const markdown = opts.markdown === true;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      return { index: i, token: '//' };
    }
    if (ch === '/' && line[i + 1] === '*') {
      return { index: i, token: '/*' };
    }
    if (!markdown && ch === '#') {
      return { index: i, token: '#' };
    }
    if (ch === '-' && line[i + 1] === '-') {
      return { index: i, token: '--' };
    }
  }
  return null;
}

/**
 * Comment text after the earliest string-safe comment token on the line, or
 * null when the line carries no such token.
 */
function inlineCommentText(line, opts = {}) {
  const found = commentStart(line, opts);
  return found === null ? null : line.slice(found.index + found.token.length);
}

/** Strip `/*`, `*\/` delimiters and leading `*` decoration from a block line */
function stripBlockDecoration(trimmed) {
  return trimmed
    .replace(/^\/\*+/, '')
    .replace(/\*\/.*$/, '')
    .replace(/^\*+\s*/, '')
    .trim();
}

/** Fence delimiters (``` or ~~~) that open/close a markdown code block */
const FENCE_RE = /^(?:```|~~~)/;

const scanCache = new WeakMap();

/**
 * Classify every line as comment / non-comment, tracking `/* ... *\/` state.
 * In markdown mode, fenced code regions are skipped (non-comment) and a
 * leading `#` is a heading rather than a comment.
 *
 * Memoized on the `lines` array reference so repeated calls for the same file
 * are free.
 *
 * @param {string[]} lines
 * @param {{markdown?: boolean}} [opts]
 * @returns {Array<{isComment: boolean, text: string, raw: string}>}
 */
function scanCommentLines(lines, opts = {}) {
  const markdown = opts.markdown === true;
  const cached = scanCache.get(lines);
  if (cached && cached.markdown === markdown) {
    return cached.result;
  }

  const result = [];
  let inBlock = false;
  let inFence = false;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    if (markdown) {
      if (FENCE_RE.test(trimmed)) {
        inFence = !inFence;
        result.push({ isComment: false, text: '', raw: trimmed });
        return;
      }
      if (inFence) {
        result.push({ isComment: false, text: '', raw: trimmed });
        return;
      }
    }

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
    // In markdown a leading `#` is a heading, not a comment line.
    if (
      !markdown &&
      trimmed.startsWith('#') &&
      !(idx === 0 && trimmed.startsWith('#!'))
    ) {
      result.push({
        isComment: true,
        text: trimmed.replace(/^#+\s*/, '').trim(),
        raw: trimmed,
      });
      return;
    }
    result.push({ isComment: false, text: '', raw: trimmed });
  });

  scanCache.set(lines, { markdown, result });
  return result;
}

/**
 * True when the character at `index` in `line` sits inside a string literal
 * (single/double/backtick, `\`-escaped). Used to reject import keywords that
 * appear inside a string rather than at a real import position.
 */
function isIndexInString(line, index) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < index && i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    }
  }
  return quote !== null;
}

module.exports = {
  CODE_EXTENSIONS,
  isCodeExtension,
  isMarkdown,
  commentStart,
  inlineCommentText,
  scanCommentLines,
  stripBlockDecoration,
  isIndexInString,
};
