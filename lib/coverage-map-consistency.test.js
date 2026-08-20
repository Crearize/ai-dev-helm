const fs = require('fs');
const path = require('path');
const { PACKAGE_ROOT } = require('./utils');

/**
 * Drift guard: the coverage-map template's category table must stay in lockstep
 * with the catalog (static-check-standard.md §2). If a category is added,
 * removed, renamed or re-numbered in the catalog but not mirrored in the
 * template (or vice versa), a product's coverage map would silently omit or
 * mislabel a check. This test parses both tables line-based (no extra deps)
 * and asserts the id->name maps are identical.
 */
describe('coverage-map / catalog drift guard', () => {
  const CATALOG = path.join(
    PACKAGE_ROOT,
    'shared',
    'documents',
    'static-check-standard.md'
  );
  const TEMPLATE = path.join(
    PACKAGE_ROOT,
    'skills',
    'project',
    'lint-scaffolding',
    'coverage-map-template.md'
  );

  // A catalog id: a single letter A-F followed by a single digit (A1..F2).
  const ID_RE = /^[A-F][1-9]$/;

  /**
   * Parse markdown table rows whose first cell is a catalog id into an ordered
   * Map<id, name>. The category name has the 🤖 marker and surrounding
   * whitespace stripped (the catalog appends 🤖 to the name; the template keeps
   * it in a separate column), so names compare on their text alone.
   * @param {string} content - Markdown text to scan
   * @returns {Map<string, string>} id -> normalized category name
   */
  function parseCategories(content) {
    const map = new Map();
    for (const line of content.split(/\r?\n/)) {
      if (!line.trimStart().startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      // cells[0] is empty (leading pipe); first real cell is cells[1].
      const id = cells[1];
      if (!ID_RE.test(id)) continue;
      const name = (cells[2] || '')
        .replace(/🤖/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      map.set(id, name);
    }
    return map;
  }

  /**
   * Slice out "## 2. ..." up to the next "## 3." heading so only the catalog
   * table in §2 is parsed (the file has other tables in §1/§3/§4/§5).
   * @param {string} content - Full markdown file
   * @returns {string} The §2 section text
   */
  function section2(content) {
    const start = content.search(/^## 2\. /m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = content.slice(start);
    const end = rest.search(/^## 3\. /m);
    return end >= 0 ? rest.slice(0, end) : rest;
  }

  const catalogMap = parseCategories(
    section2(fs.readFileSync(CATALOG, 'utf8'))
  );
  const templateMap = parseCategories(fs.readFileSync(TEMPLATE, 'utf8'));

  it('parses the full 25-category catalog from §2', () => {
    expect(catalogMap.size).toBe(25);
  });

  it('template lists exactly the catalog ids (no extra, none missing)', () => {
    const catalogIds = [...catalogMap.keys()].sort();
    const templateIds = [...templateMap.keys()].sort();
    expect(templateIds).toEqual(catalogIds);
  });

  it('every catalog category matches the template by number and name', () => {
    for (const [id, name] of catalogMap) {
      expect(templateMap.has(id)).toBe(true);
      expect(templateMap.get(id)).toBe(name);
    }
  });
});
