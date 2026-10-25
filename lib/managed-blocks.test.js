'use strict';

// 3.7.0 (C3d): the managed blocks of the root rule files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const blocks = require('./managed-blocks');

const m = (name, edge) => `<!-- ai-dev-helm:${name}:${edge} -->`;

describe('findBlocks', () => {
  test('counts a marker only as a line of its own outside code fences', () => {
    const text = `# x\n${m('harness', 'start')}\n## A\ntext\n${m('harness', 'end')}\n\n## P\n\`\`\`\n${m('harness', 'start')}\n\`\`\`\nsee ${m('harness', 'end')} inline\n`;
    const found = blocks.findBlocks(text);
    expect(found.malformed).toEqual([]);
    expect(found.blocks.harness.body).toBe('## A\ntext\n');
  });

  test('a missing, repeated or reversed marker is malformed', () => {
    expect(blocks.findBlocks(`${m('refs', 'start')}\nx\n`).malformed).toEqual(['refs']);
    expect(blocks.findBlocks(`${m('refs', 'start')}\n${m('refs', 'start')}\n${m('refs', 'end')}\n`).malformed).toEqual(['refs']);
    expect(blocks.findBlocks(`${m('refs', 'end')}\nx\n${m('refs', 'start')}\n`).malformed).toEqual(['refs']);
  });

  test('replaceBlock rewrites only the inside and keeps the text around it', () => {
    const text = `before\n${m('harness', 'start')}\nold\n${m('harness', 'end')}\nafter\n`;
    const at = { ...blocks.findBlocks(text).blocks.harness, marked: true };
    expect(blocks.replaceBlock(text, 'harness', at, 'new\n')).toBe(`before\n${m('harness', 'start')}\nnew\n${m('harness', 'end')}\nafter\n`);
  });
});

describe('locateRun (wrapping a file written before the markers)', () => {
  test('finds the template headings as one run and stops at a product section', () => {
    const text = '# T\n\n## Language Setting\na\n\n## Critical Rules\nb\n\n## Project Overview\nmine\n';
    const run = blocks.locateRun(text, new Set(['Language Setting', 'Critical Rules']));
    expect(run.headings).toEqual(['Language Setting', 'Critical Rules']);
    expect(text.slice(run.end)).toMatch(/^## Project Overview/);
    expect(run.split).toBe(false);
  });

  test('a product section between template sections splits the run', () => {
    const text = '## Language Setting\na\n## Ours\nx\n## Critical Rules\nb\n';
    expect(blocks.locateRun(text, new Set(['Language Setting', 'Critical Rules'])).split).toBe(true);
  });

  test('a heading inside a code fence is not a section', () => {
    const text = '## Language Setting\n```\n## Critical Rules\n```\nz\n';
    expect(blocks.locateRun(text, new Set(['Language Setting', 'Critical Rules'])).headings).toEqual(['Language Setting']);
  });
});

describe('render cache (3.7.0 cycle 1)', () => {
  test('a cache directory that is a file or another user\'s is not used', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cache-'));
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const saved = process.env.AI_DEV_HELM_CACHE_DIR;
    process.env.AI_DEV_HELM_CACHE_DIR = file;
    try {
      expect(() => require('./render').fetchPackage('3.6.0', { retries: 1, delayMs: 0 })).toThrow();
    } finally {
      if (saved === undefined) delete process.env.AI_DEV_HELM_CACHE_DIR; else process.env.AI_DEV_HELM_CACHE_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the default cache is in the user\'s own cache directory, not the shared temp directory', () => {
    const saved = process.env.AI_DEV_HELM_CACHE_DIR;
    delete process.env.AI_DEV_HELM_CACHE_DIR;
    try {
      const src = fs.readFileSync(path.join(__dirname, 'render.js'), 'utf8');
      expect(src).toMatch(/LOCALAPPDATA/);
      expect(src).toMatch(/XDG_CACHE_HOME/);
      expect(src).not.toMatch(/os\.tmpdir\(\), 'ai-dev-helm', 'render-cache'/);
    } finally {
      if (saved !== undefined) process.env.AI_DEV_HELM_CACHE_DIR = saved;
    }
  });
});
