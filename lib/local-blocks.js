'use strict';

// 3.7.0 (C3k): a product keeps its own sections inside a distributed document between
// <!-- ai-dev-helm:local:start --> and <!-- ai-dev-helm:local:end -->. `upgrade` takes them out before the three-way
// merge (so they are never "product changes" that conflict with the release) and puts them back afterwards under the
// same place: after the line they followed, inside the same heading's section; at the end of that section when the
// line is gone; at the end of the file (listed in the record) when the heading is gone too. `--verify` compares the
// file without them. Markers count only as lines of their own outside code fences, as the managed blocks do.
// The place is the n-th occurrence of the heading and of the line it followed (cycle 1: the first one sent a block
// after a second closing fence into the first code block, or under the other of two identical headings), and a
// place inside a code fence is never taken (the end of the section instead, listed).

const START = '<!-- ai-dev-helm:local:start -->';
const END = '<!-- ai-dev-helm:local:end -->';
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s/;

const mentions = (text) => typeof text === 'string' && text.includes('ai-dev-helm:local:');

/**
 * Split an LF text into the product's local blocks and the text without them:
 * { text, blocks: [{ heading, headingNth, after, afterNth, body: string[], blankAfter, blankBefore }] }. null when
 * there are none or the markers are malformed (unclosed, stray end), so the file goes through the normal merge.
 */
function extract(text) {
  if (!mentions(text)) return null;
  const lines = text.split('\n');
  const out = [];
  const found = [];
  const seenHeadings = new Map();
  let fence = false;
  let heading = null;
  let headingNth = 0;
  let sectionStart = 0;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (current) {
      if (line.trim() === END) {
        // One blank line around the block goes with it (the one after it, else the one before it - at the end of
        // the file), so the text without it reads as the release wrote it.
        current.blankAfter = lines[i + 1] === '' && i + 1 < lines.length - 1;
        if (current.blankAfter) i++;
        else if (out.length && out[out.length - 1] === '') { out.pop(); current.blankBefore = true; }
        found.push(current);
        current = null;
      } else current.body.push(line);
      continue;
    }
    if (FENCE_RE.test(line)) fence = !fence;
    if (!fence && line.trim() === START) {
      let at = out.length - 1;
      while (at >= sectionStart && out[at].trim() === '') at--;
      const after = at >= sectionStart ? out[at] : null;
      let afterNth = 0;
      if (after !== null) for (let j = sectionStart; j < at; j++) if (out[j] === after) afterNth++;
      current = { heading, headingNth, after, afterNth, body: [], blankAfter: false, blankBefore: false };
      continue;
    }
    if (!fence && line.trim() === END) return null;
    if (!fence && HEADING_RE.test(line)) {
      heading = line;
      headingNth = seenHeadings.get(line) || 0;
      seenHeadings.set(line, headingNth + 1);
      sectionStart = out.length;
    }
    out.push(line);
  }
  if (current || !found.length) return null;
  return { text: out.join('\n'), blocks: found };
}

/** Per line: inside a code fence (the fence lines themselves count as inside), or inside a local block. */
function scan(lines) {
  const fenced = [];
  const closing = []; // A fence line that closes a code block (cycle 2: judged by the state before it).
  const local = [];
  let fence = false;
  let block = false;
  lines.forEach((line, i) => {
    if (!fence && line.trim() === START) block = true;
    local[i] = block;
    if (!fence && line.trim() === END) block = false;
    if (FENCE_RE.test(line)) { fenced[i] = true; closing[i] = fence; fence = !fence; } else fenced[i] = fence;
  });
  return { fenced, closing, local };
}

/** Headings outside code fences and local blocks: [{ index, level, line }]. */
function headingsOf(lines, { fenced, local }) {
  const list = [];
  lines.forEach((line, index) => {
    const m = !fenced[index] && !local[index] && HEADING_RE.exec(line);
    if (m) list.push({ index, level: m[1].length, line });
  });
  return list;
}

/**
 * Put the blocks back into an LF text. Returns { text, moved: [string] } - `moved` lists the blocks that did not go
 * back after their line: to the end of the file (heading gone) or to the end of the section (the place is inside a
 * code fence).
 */
function restore(text, blocks) {
  const lines = text.split('\n');
  const moved = [];
  const endOfFile = (marked, label) => {
    const tail = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, '', ...marked);
    moved.push(label);
  };
  // In reverse, so blocks that followed the same line keep their order.
  for (const block of [...blocks].reverse()) {
    const marked = [START, ...block.body, END];
    const state = scan(lines);
    const heads = headingsOf(lines, state);
    let from = 0;
    let to = lines.length;
    if (block.heading !== null) {
      const same = heads.filter((h) => h.line === block.heading);
      const head = same[block.headingNth || 0];
      if (!head) { endOfFile(marked, block.heading); continue; }
      from = head.index;
      const next = heads.find((h) => h.index > head.index && h.level <= head.level);
      to = next ? next.index : lines.length;
    }
    if (block.after === null && block.heading === null) { lines.splice(0, 0, ...marked, ...(block.blankAfter ? [''] : [])); continue; }
    let at = -1;
    if (block.after !== null) {
      let seen = 0;
      for (let i = from; i < to; i++) {
        if (lines[i] !== block.after || state.local[i]) continue;
        if (seen === (block.afterNth || 0)) { at = i; break; }
        seen++;
      }
    }
    // After `at` - unless that is inside a code fence (a closing fence line itself is not).
    const insideFence = at >= 0 && state.fenced[at] && !state.closing[at];
    if (at >= 0 && !insideFence) {
      if (block.blankAfter && lines[at + 1] === '') lines.splice(at + 2, 0, ...marked, '');
      else if (block.blankBefore) lines.splice(at + 1, 0, '', ...marked);
      else lines.splice(at + 1, 0, ...marked);
      continue;
    }
    // The line it followed is gone, or the place is inside a code fence: the end of its section (before the blank
    // lines that close it).
    let end = to;
    while (end > from + 1 && lines[end - 1] === '') end--;
    lines.splice(end, 0, '', ...marked);
    if (insideFence) moved.push(`${block.heading || '(top)'} (end of the section: its place is inside a code block now)`);
  }
  return { text: lines.join('\n'), moved };
}

module.exports = { extract, restore, mentions, START, END };
