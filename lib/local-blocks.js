'use strict';

// 3.7.0 (C3k): a product keeps its own sections inside a distributed document between
// <!-- ai-dev-helm:local:start --> and <!-- ai-dev-helm:local:end -->. `upgrade` takes them out before the three-way
// merge (so they are never "product changes" that conflict with the release) and puts them back afterwards under the
// same place: after the line they followed, inside the same heading's section; at the end of that section when the
// line is gone; at the end of the file (listed in the record) when the heading is gone too. `--verify` compares the
// file without them. Markers count only as lines of their own outside code fences, as the managed blocks do.

const START = '<!-- ai-dev-helm:local:start -->';
const END = '<!-- ai-dev-helm:local:end -->';
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s/;

const mentions = (text) => typeof text === 'string' && text.includes('ai-dev-helm:local:');

/**
 * Split an LF text into the product's local blocks and the text without them:
 * { text, blocks: [{ heading, after, body: string[], blankAfter }] }. null when there are none or the markers are
 * malformed (unclosed, stray end), so the file goes through the normal merge.
 */
function extract(text) {
  if (!mentions(text)) return null;
  const lines = text.split('\n');
  const out = [];
  const found = [];
  let fence = false;
  let heading = null;
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
      const after = [...out].reverse().find((l) => l.trim() !== '');
      current = { heading, after: after === undefined ? null : after, body: [], blankAfter: false, blankBefore: false };
      continue;
    }
    if (!fence && line.trim() === END) return null;
    if (!fence && HEADING_RE.test(line)) heading = line;
    out.push(line);
  }
  if (current || !found.length) return null;
  return { text: out.join('\n'), blocks: found };
}

/** Headings outside code fences: [{ index, level, line }]. */
function headingsOf(lines) {
  const list = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) { fence = !fence; return; }
    const m = !fence && HEADING_RE.exec(line);
    if (m) list.push({ index, level: m[1].length, line });
  });
  return list;
}

/**
 * Put the blocks back into an LF text. Returns { text, moved: [heading or null] } - `moved` lists the blocks that
 * went to the end of the file because their heading is not in the text any more.
 */
function restore(text, blocks) {
  const lines = text.split('\n');
  const moved = [];
  // In reverse, so blocks that followed the same line keep their order.
  for (const block of [...blocks].reverse()) {
    const marked = [START, ...block.body, END];
    const heads = headingsOf(lines);
    let from = 0;
    let to = lines.length;
    if (block.heading !== null) {
      const head = heads.find((h) => h.line === block.heading);
      if (!head) {
        const tail = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        lines.splice(tail, 0, '', ...marked);
        moved.push(block.heading);
        continue;
      }
      from = head.index;
      const next = heads.find((h) => h.index > head.index && h.level <= head.level);
      to = next ? next.index : lines.length;
    }
    let at = -1;
    if (block.after !== null) {
      for (let i = from; i < to; i++) if (lines[i] === block.after) { at = i; break; }
    } else at = -1;
    if (at >= 0) {
      if (block.blankAfter && lines[at + 1] === '') lines.splice(at + 2, 0, ...marked, '');
      else if (block.blankBefore) lines.splice(at + 1, 0, '', ...marked);
      else lines.splice(at + 1, 0, ...marked);
      continue;
    }
    if (block.after === null && block.heading === null) { lines.splice(0, 0, ...marked, ...(block.blankAfter ? [''] : [])); continue; }
    // The line it followed is gone: the end of its section (before the blank lines that close it).
    let end = to;
    while (end > from + 1 && lines[end - 1] === '') end--;
    lines.splice(end, 0, '', ...marked);
  }
  return { text: lines.join('\n'), moved };
}

module.exports = { extract, restore, mentions, START, END };
