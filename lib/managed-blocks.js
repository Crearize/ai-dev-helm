'use strict';

// 3.7.0 (C3d): the harness's part of the root rule files (CLAUDE.md, AGENTS.md, .cursorrules) sits between
// `<!-- ai-dev-helm:<name>:start -->` and `<!-- ai-dev-helm:<name>:end -->`; the product's sections stay outside.
// `upgrade` replaces (or three-way merges) only the inside. A file without the markers (written by 3.6.0 or
// earlier) is wrapped once when the template's `##` sections are found there as one contiguous run; otherwise it
// stays as it is and the block is reported pending (wrapped by hand once, at the rollout).

const BLOCK_NAMES = ['harness', 'skills', 'refs', 'runtime'];
const marker = (name, edge) => `<!-- ai-dev-helm:${name}:${edge} -->`;

// The `##` sections of each block in the 3.x templates before the markers existed. Releases that had fewer of them
// still match: the run is whatever contiguous part of this list (plus the new template's headings) is found.
const LEGACY_HEADINGS = {
  'CLAUDE.md': {
    harness: ['Language Setting', 'SuperPowers Operating Rules', 'Quality Check Rules', 'Critical Rules',
      'Shell Command Rules (Windows / PowerShell)', 'Autonomy Principles', 'Compact Instructions'],
    skills: ['Skills'],
    refs: ['Reference Documents'],
  },
  'AGENTS.md': {
    harness: ['Language Setting', 'SuperPowers Operating Rules', 'Quality Check Rules', 'Critical Rules',
      'Shell Command Rules (Windows / PowerShell)', 'Autonomy Principles', 'Compact Instructions'],
    skills: ['Skills (Read on demand)', 'Skills'],
    refs: ['Reference Documents'],
  },
  '.cursorrules': {
    harness: ['Critical Rules', 'Phase Design Workflow'],
    skills: ['Skills (Read on demand)', 'Skills'],
    refs: ['Reference Documents'],
  },
};
const ROOT_RULE_FILES = Object.keys(LEGACY_HEADINGS);

const toLf = (text) => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** Trim blank lines around a block body and end it with one newline (bodies compare equal however they sit). */
function body(text) {
  const trimmed = text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n` : '';
}

/**
 * The marked blocks of `text` (LF). Returns { blocks: { name: { start, end, body } }, malformed: [name] } where
 * start/end delimit the markers themselves. A name with a missing, repeated or reversed marker is malformed.
 */
function findBlocks(text) {
  const blocks = {};
  const malformed = [];
  for (const name of BLOCK_NAMES) {
    const open = marker(name, 'start');
    const close = marker(name, 'end');
    const s = text.indexOf(open);
    const e = text.indexOf(close);
    if (s < 0 && e < 0) continue;
    if (s < 0 || e < 0 || e < s || text.indexOf(open, s + 1) >= 0 || text.indexOf(close, e + 1) >= 0) {
      malformed.push(name);
      continue;
    }
    blocks[name] = { start: s, end: e + close.length, body: body(text.slice(s + open.length, e)) };
  }
  return { blocks, malformed };
}

// Level-2 sections outside code fences: [{ heading, start, end }], end = the next level-1/2 heading, marker or EOF.
function sections(text) {
  const lines = text.split('\n');
  const out = [];
  let offset = 0;
  let fence = false;
  let current = null;
  const close = (at) => { if (current) { current.end = at; out.push(current); current = null; } };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const h2 = /^## (.+?)\s*$/.exec(line);
      if (h2) { close(offset); current = { heading: h2[1], start: offset }; }
      else if (/^# /.test(line) || line.startsWith('<!-- ai-dev-helm:')) close(offset);
    }
    offset += line.length + 1;
  }
  close(Math.min(offset, text.length));
  return out;
}

/**
 * The contiguous run of `##` sections whose headings are in `headings` (first match to the end of the run).
 * Returns { start, end, headings: [...] } or null.
 */
function locateRun(text, headings) {
  const secs = sections(text);
  const first = secs.findIndex((s) => headings.has(s.heading));
  if (first < 0) return null;
  let last = first;
  while (last + 1 < secs.length && headings.has(secs[last + 1].heading) && secs[last + 1].start === secs[last].end) last += 1;
  const later = secs.slice(last + 1).some((s) => headings.has(s.heading));
  return { start: secs[first].start, end: secs[last].end, headings: secs.slice(first, last + 1).map((s) => s.heading), split: later };
}

function headingSet(file, name, newBody) {
  const set = new Set((LEGACY_HEADINGS[file] || {})[name] || []);
  for (const s of sections(newBody || '')) set.add(s.heading);
  return set;
}

/**
 * The body of block `name` in a rendered file: its markers, or (a release without markers) the run of the block's
 * headings. Returns { body, start, end, marked } or null.
 */
function blockOf(file, name, text, newBody) {
  const { blocks } = findBlocks(text);
  if (blocks[name]) return { ...blocks[name], marked: true };
  const run = locateRun(text, headingSet(file, name, newBody));
  if (!run || run.split) return null;
  return { body: body(text.slice(run.start, run.end)), start: run.start, end: run.end, marked: false, headings: run.headings };
}

/** `text` with block `name` (at start..end) replaced by the marked `newBody`. */
function replaceBlock(text, name, at, newBody) {
  const block = `${marker(name, 'start')}\n${newBody}${marker(name, 'end')}`;
  const after = text.slice(at.end);
  // An unmarked run ends where the next section starts; keep one blank line before it.
  const tail = at.marked ? after : `\n\n${after.replace(/^\n+/, '')}`;
  return text.slice(0, at.start) + block + (after === '' && !at.marked ? '\n' : tail);
}

module.exports = { BLOCK_NAMES, ROOT_RULE_FILES, LEGACY_HEADINGS, marker, toLf, body, findBlocks, sections, locateRun, blockOf, replaceBlock };
