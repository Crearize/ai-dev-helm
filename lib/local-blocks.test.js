'use strict';

// 3.7.0 (C3k): the product's ai-dev-helm:local blocks are taken out before the merge and put back afterwards.

const { extract, restore, START, END } = require('./local-blocks');

const block = (body) => `${START}\n${body}\n${END}`;

describe('local blocks (C3k)', () => {
  test.each([
    ['between paragraphs', `## H\npara\n\n${block('X')}\n\nnext\n`, '## H\npara\n\nnext\n'],
    ['at the end of the file', `## H\npara\n\n${block('X')}\n`, '## H\npara\n'],
    ['right under the heading, no blank lines', `## H\n${block('X')}\npara\n`, '## H\npara\n'],
    ['two blocks after the same line', `## A\na\n\n${block('X1')}\n\n${block('X2')}\n\n## B\nb\n`, '## A\na\n\n## B\nb\n'],
    ['blocks in two sections', `## A\na\n\n${block('X1')}\n\n## B\nb\n\n${block('X2')}\n`, '## A\na\n\n## B\nb\n'],
    ['before the first line', `${block('top')}\n\n# T\n`, '# T\n'],
  ])('%s: the text without the blocks reads as the release wrote it, and putting them back is exact', (_, text, without) => {
    const local = extract(text);
    expect(local.text).toBe(without);
    expect(restore(local.text, local.blocks)).toEqual({ text, moved: [] });
  });

  test('a release change in the section keeps the block after its line', () => {
    const local = extract(`## A\nintro\na\n\n${block('X')}\n\n## B\nb\n`);
    expect(restore('## A\nnew intro\na\n\n## B\nb changed\n', local.blocks).text).toBe(`## A\nnew intro\na\n\n${block('X')}\n\n## B\nb changed\n`);
  });

  test('the line it followed gone: the end of its section; the heading gone: the end of the file, listed', () => {
    const local = extract(`## A\na\n\n${block('X')}\n\n## B\nb\n`);
    expect(restore('## A\nother\n\n## B\nb\n', local.blocks).text).toBe(`## A\nother\n\n${block('X')}\n\n## B\nb\n`);
    expect(restore('## C\nc\n', local.blocks)).toEqual({ text: `## C\nc\n\n${block('X')}\n`, moved: ['## A'] });
  });

  test('markers inside a code fence, an unclosed block or a stray end are not blocks', () => {
    expect(extract(`\`\`\`\n${START}\n\`\`\`\nplain\n`)).toBeNull();
    expect(extract(`## A\n${START}\nX\n`)).toBeNull();
    expect(extract(`## A\n${END}\n`)).toBeNull();
    expect(extract('## A\nno markers\n')).toBeNull();
  });

  test('a heading-like line inside a code fence is not a section heading', () => {
    const local = extract(`## A\n\`\`\`sh\n# comment\n\`\`\`\nline\n\n${block('X')}\n`);
    expect(local.blocks[0].heading).toBe('## A');
    expect(restore(local.text, local.blocks).text).toBe(`## A\n\`\`\`sh\n# comment\n\`\`\`\nline\n\n${block('X')}\n`);
  });
});

describe('local blocks: the n-th identical line or heading, never inside a code fence (cycle 1)', () => {
  // Break: until cycle 1 the first identical line / heading was taken.
  const fence = '```';
  test.each([
    ['after the second of two bare closing fences', `## A\n${fence}\nnpm i\n${fence}\n\n${fence}\nnpm t\n${fence}\n\n${block('X')}\n\nend\n`],
    ['under the second of two identical headings', `## A\n### Notes\na\n\n## B\n### Notes\nb\n\n${block('X')}\n`],
    ['in the second of two tables', `## A\n| a |\n|---|\n| 1 |\n\n| b |\n|---|\n${block('X')}\n| 2 |\n`],
  ])('%s: putting it back is exact, and the release change elsewhere keeps the place', (_, text) => {
    const local = extract(text);
    expect(restore(local.text, local.blocks)).toEqual({ text, moved: [] });
    const changed = `${local.text}\nappended by the release\n`;
    const back = restore(changed, local.blocks).text;
    expect(extract(back).text).toBe(changed);
    expect(back.indexOf(block('X'))).toBe(text.indexOf(block('X')));
  });

  test('a place that is inside a code fence now goes to the end of the section, listed', () => {
    const local = extract(`## A\nrun:\n\n${block('X')}\n\n## B\nb\n`);
    const fenced = restore(`## A\n${fence}\nrun:\n${fence}\n\n## B\nb\n`, local.blocks);
    expect(fenced.text).toBe(`## A\n${fence}\nrun:\n${fence}\n\n${block('X')}\n\n## B\nb\n`);
    expect(fenced.moved).toEqual(['## A (end of the section: its place is inside a code block now)']);
    expect(extract(fenced.text)).not.toBeNull();
  });

  test('a heading inside a put-back block does not cut the section of an earlier block', () => {
    const text = `## A\na\n\n${block('X1')}\n\nb\n\n${block('## Own heading\nX2')}\n`;
    const local = extract(text);
    expect(restore(local.text, local.blocks)).toEqual({ text, moved: [] });
  });
});
