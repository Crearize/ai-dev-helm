'use strict';

// 3.7.2 (#234, design S3 / S4): the hardening of the GitHub workflows, kept from coming back undone.
// - every action is pinned to a full commit SHA (the version in a trailing comment)
// - no ${{ }} expression inside a run: script (expressions reach scripts through env:)
// - no permission at the top level beyond contents: read; id-token: write only in publish.yml's publish job
// - every checkout leaves no credential behind (one `persist-credentials: false` line, in the step's own with:)
// - publish.yml: every line that names npm, npx, ignore-scripts or provenance is one of a fixed list per job
//   (PUBLISH_NPM_LINES), and the listed commands install without scripts, publish only with provenance and run no
//   package code in the publish job
//
// The workflows are read line by line (no YAML dependency). The test does not try to follow every YAML or shell
// form: it accepts a narrow, canonical subset of YAML and refuses the rest (canonicalFormProblems, unreadableForms),
// so the reader never has to guess:
// - no tab; every YAML line is `key: value`, `key:` or a `- ` list item, with a plain key followed directly by `:`
//   (no quoted key, no space before the colon, no `? ` key, no merge key `<<:`), and no key twice in one mapping; a
//   list item is `- key: value` or a plain word or quoted string (no nested list, no flow collection as an item)
// - no anchor, alias or tag (`&a`, `*a`, `!tag`)
// - every value on one line: no line after `key: value` (or a `- ` scalar item) is deeper, so no plain or quoted
//   scalar runs over several lines; a block scalar header is `|` or `>` with an optional chomping sign only, and a
//   run: value is one plain line or a `|` block
// - steps and permissions in block form only
// With that, a job is a two-space key under `jobs:`, a step starts at `- `, and a run: script is its one-line value or
// its `|` block. The shell inside a run: script is not parsed at all: publish.yml's npm lines are compared whole with
// the list, so no shell form (continuations, quotes, comments, joined commands, flag values) has to be read right.
// A line that keeps npm out of its words (a variable, a quoted fragment) is out of reach of this test; review covers it.

const fs = require('node:fs');
const path = require('node:path');
// describe / it / expect come from vitest globals (see vitest config).

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const FILES = fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort();
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8').split(/\r?\n/);
const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);
const ID_TOKEN_WRITE = /^\s*["']?id-token["']?\s*:\s*["']?write\b/;

// What is not in the canonical form (see the header), as `<line>: <what>`. The lines of a block scalar (`key: |` /
// `key: >` and every following line deeper than the key) are not YAML and are only checked for tabs.
function canonicalFormProblems(lines) {
  const out = [];
  const nextNonEmpty = (i) => lines.slice(i + 1).find((l) => l.trim() !== '');
  const mappings = []; // [{ col, keys }] from the outermost to the current mapping
  let blockAbove = -1; // the key column of the block scalar being skipped, or -1
  lines.forEach((line, i) => {
    const at = `${i + 1}: `;
    if (/\t/.test(line)) out.push(`${at}a tab`);
    if (blockAbove >= 0) {
      if (line.trim() === '' || indentOf(line) > blockAbove) return;
      blockAbove = -1;
    }
    if (isBlank(line)) return;
    const m = line.match(/^( *)(- +)?(.*)$/);
    const col = m[1].length + (m[2] ? m[2].length : 0);
    const rest = m[3].trimEnd();
    const key = rest.match(/^([A-Za-z0-9_][\w-]*):(\s.*)?$/);
    let value;
    if (key) {
      value = (key[2] || '').trim();
      while (mappings.length && mappings[mappings.length - 1].col > col) mappings.pop();
      if (m[2]) while (mappings.length && mappings[mappings.length - 1].col >= col) mappings.pop();
      if (!mappings.length || mappings[mappings.length - 1].col !== col) mappings.push({ col, keys: new Set() });
      const keys = mappings[mappings.length - 1].keys;
      if (keys.has(key[1])) out.push(`${at}${key[1]}: a key twice in one mapping`);
      keys.add(key[1]);
    } else if (m[2]) {
      value = rest.replace(/\s+#.*$/, '');
      while (mappings.length && mappings[mappings.length - 1].col >= col) mappings.pop();
      if (!/^([\w./-]+|'[^']*'|"[^"\\]*")$/.test(value)) out.push(`${at}a list item other than key: value or a plain word: ${rest}`);
    } else {
      out.push(`${at}a line other than key: value or a list item: ${rest}`);
      return;
    }
    if (/^[&*!]/.test(value) || (/^[[{]/.test(value) && /[[{,]\s*[&*!]/.test(value))) out.push(`${at}an anchor, alias or tag`);
    if (/^[|>]/.test(value)) {
      if (!/^[|>][-+]?$/.test(value)) out.push(`${at}a block scalar header other than | or > with a chomping sign`);
      if (key && key[1] === 'run' && !value.startsWith('|')) out.push(`${at}a run: value other than one plain line or a | block`);
      blockAbove = col;
      return;
    }
    if (key && key[1] === 'run' && !/^[^\s"'#[{]/.test(value)) out.push(`${at}a run: value other than one plain line or a | block`);
    const next = nextNonEmpty(i);
    if (value !== '' && next !== undefined && indentOf(next) > col) out.push(`${at}a value that goes on to the next line`);
  });
  return out;
}

// The job of each line ('' before `jobs:` and for top-level keys).
function jobsOf(lines) {
  let inJobs = false;
  let job = '';
  return lines.map((line) => {
    if (/^\S/.test(line)) { inJobs = /^jobs:\s*$/.test(line); job = ''; return ''; }
    const m = inJobs && line.match(/^ {2}["']?([A-Za-z0-9_-]+)["']?:\s*(#.*)?$/);
    if (m) job = m[1];
    return job;
  });
}

// [{ start, text }] for every run: script: the value on its line, or the lines of its `|` block (every following line
// deeper than the key). The canonical form leaves no other shape.
function runScripts(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*(?:-\s+)?)run:\s*(.*)$/);
    if (!m) return;
    const keyIndent = m[1].length;
    const block = /^\|[-+]?\s*$/.test(m[2]);
    const body = block ? [] : [m[2]];
    for (let j = i + 1; block && j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= keyIndent) break;
      body.push(lines[j]);
    }
    out.push({ start: i + 1, text: body.join('\n') });
  });
  return out;
}

// Forms the reader cannot follow, as `<line>: <what>`: a step list or a step in flow form (only the items of a
// `steps:` list - a flow-form `matrix.include` item is fine), on the key's line or the next, a step whose content
// starts on the line after its `-`, and permissions other than `{}` or a block of `<scope>: read|write|none` lines (a
// value on the key's line or on the next).
function unreadableForms(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const s = line.match(/^(\s*)["']?steps["']?\s*:\s*(.*?)\s*(#.*)?$/);
    if (s) {
      if (s[2] !== '') out.push(`${i + 1}: steps in flow form`);
      const key = s[1].length;
      let item = -1; // the indent of the step items (YAML allows them at the key's own indent)
      for (let j = i + 1; j < lines.length; j++) {
        if (isBlank(lines[j])) continue;
        const ind = indentOf(lines[j]);
        if (item < 0) item = ind;
        if (ind < item || (ind <= key && !(ind === item && /^\s*-/.test(lines[j])))) break;
        if (ind !== item) continue;
        if (!/^\s*-(\s|$)/.test(lines[j])) out.push(`${j + 1}: steps in flow form (not a "- " item)`);
        else if (/^\s*-\s*[{[]/.test(lines[j])) out.push(`${j + 1}: a step in flow form`);
        else if (/^\s*-\s*(#.*)?$/.test(lines[j])) out.push(`${j + 1}: a step starting on the line after its "-"`);
      }
    }
    const p = line.match(/^(\s*)["']?permissions["']?\s*:\s*(.*?)\s*(#.*)?$/);
    if (p && p[2] !== '' && p[2] !== '{}') out.push(`${i + 1}: permissions as one value`);
    if (p && p[2] === '') {
      for (let j = i + 1; j < lines.length; j++) {
        if (isBlank(lines[j])) continue;
        if (indentOf(lines[j]) <= p[1].length) break;
        if (!/^\s*["']?[a-z-]+["']?\s*:\s*["']?(read|write|none)["']?\s*(#.*)?$/.test(lines[j])) out.push(`${j + 1}: a permissions line other than <scope>: read|write|none`);
      }
    }
  });
  return out;
}

// The lines of the step that holds line `i` (from its `- ` to the next step or a shallower key).
function stepOf(lines, i) {
  let start = i;
  while (start > 0 && !/^\s*- /.test(lines[start])) start--;
  const dash = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > dash)) end++;
  return lines.slice(start, end);
}

// The checkout steps of a file (any case: GitHub matches owner/repo without it), and what keeps one from leaving no
// credential: the step names persist-credentials on exactly one line, and that line is `persist-credentials: false`
// directly under the step's own `with:` (not under env:, not twice).
const CHECKOUT = /^\s*(-\s+)?uses:\s*actions\/checkout[@/]/i;
function credentialProblem(lines, i) {
  const step = stepOf(lines, i);
  const col = indentOf(step[0]) + (step[0].match(/^\s*(- +)/) || ['', ''])[1].length;
  const named = step.filter((l) => /persist-credentials/i.test(l));
  if (named.length !== 1) return `persist-credentials named on ${named.length} lines`;
  const w = step.findIndex((l) => l === `${' '.repeat(col)}with:`);
  const at = step.indexOf(named[0]);
  if (w < 0 || at < w || step.slice(w + 1, at).some((l) => !isBlank(l) && indentOf(l) <= col)) return 'persist-credentials outside the step\'s with:';
  if (named[0] !== `${' '.repeat(col + 2)}persist-credentials: false`) return `not "persist-credentials: false" directly under with: ${named[0].trim()}`;
  return null;
}

// publish.yml: every line of a job that names npm, npx, ignore-scripts or provenance (any case, so NPM_CONFIG_* too;
// comment lines included) is one of these, exactly. At the top level only comments and the name may name them.
// Change publish.yml and this list together, on purpose (the npm version too: it is not taken from @latest).
const NPM_WORDS = /np[mx]|ignore-scripts|provenance/i;
const PUBLISH_NPM_LINES = {
  'release-please': [],
  verify: [
    "# --ignore-scripts: no dependency's install script runs. The only one in",
    "# npm's strict resolver refuses regardless). Kept as an explicit flag so",
    '# recovery publishes of tags cut before the repo .npmrc landed still',
    'run: npm ci --ignore-scripts --legacy-peer-deps',
    'run: npm test',
  ],
  publish: [
    "registry-url: 'https://registry.npmjs.org'",
    '# Trusted Publishing needs npm 11.5.1+. 12.2.1 is the version that',
    '- name: Install a fixed npm for Trusted Publishing',
    'npm install -g npm@12.2.1 --ignore-scripts',
    'npm --version',
    '- name: Publish to npm (Trusted Publishing / OIDC, with provenance)',
    'npm publish --access public --provenance --ignore-scripts 2>&1 | tee publish.log',
    '# npm can create the Sigstore tlog entry before the registry publish',
    '# fails, and a retry with --provenance then hits the immutable tlog',
    '# entry. A version without provenance is never published: if the',
    '# version is already on npm the publish is complete; otherwise stop.',
    'if npm view "@crearize/ai-dev-helm@$VERSION" version >/dev/null 2>&1; then',
    'echo "Version $VERSION is already published on npm; treating publish as complete."',
    'echo "::error::The provenance tlog entry for $VERSION exists but $VERSION is not on npm. Do not publish it without provenance: release the next patch version instead."',
  ],
};
function npmLineProblems(lines) {
  const jobs = jobsOf(lines);
  const problems = [];
  lines.forEach((line, i) => {
    if (!NPM_WORDS.test(line)) return;
    const text = line.trim();
    if (jobs[i] === '') {
      if (!/^(#|name: )/.test(line)) problems.push(`${i + 1}: npm / npx at the top level: ${text}`);
      return;
    }
    const allowed = PUBLISH_NPM_LINES[jobs[i]];
    if (!allowed || !allowed.includes(text)) problems.push(`${i + 1}: ${jobs[i]}: ${text}`);
  });
  return problems;
}

// Everything the checks below refuse in publish.yml before reading it.
const publishProblems = (lines) => [...canonicalFormProblems(lines), ...unreadableForms(lines), ...npmLineProblems(lines)];

// What is wrong with the flags of one listed npm ci / install / publish command (a fixed line, not shell to be read):
// --ignore-scripts missing, a publish without --provenance, or a flag turned off or given a value.
function npmFlagProblems(command) {
  const args = command.split(/\s+/);
  const problems = [];
  if (!args.includes('--ignore-scripts')) problems.push('no --ignore-scripts');
  if (/\bnpm\s+publish\b/.test(command) && !args.includes('--provenance')) problems.push('a publish without --provenance');
  if (args.some((a) => /^--(no-)?(ignore-scripts|provenance)=|^--no-(ignore-scripts|provenance)$/.test(a))) problems.push('a flag turned off or given a value');
  return problems;
}

describe('workflow hardening (3.7.2, S3 / S4)', () => {
  it('reads the three workflows', () => {
    expect(FILES).toEqual(expect.arrayContaining(['publish.yml', 'sync-superpowers.yml', 'test.yml']));
  });

  // Self-test of the reader on a made-up workflow, so a check below cannot pass by reading nothing.
  it('the reader finds jobs, run scripts (one line and | blocks) and steps', () => {
    const lines = [
      'permissions: {}', 'jobs:', '  a:', '    steps:', '      - uses: x/y@v1', '        with:', '          k: v',
      '      - run: |', '          echo ${{ inputs.t }}', '          npm ci', '      - name: n', '        run: npm test',
      '  b:', '    permissions:', '      id-token: write',
    ];
    expect(canonicalFormProblems(lines)).toEqual([]);
    expect(jobsOf(lines)).toEqual(['', '', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b']);
    expect(runScripts(lines)).toEqual([
      { start: 8, text: '          echo ${{ inputs.t }}\n          npm ci' },
      { start: 12, text: 'npm test' },
    ]);
    expect(stepOf(lines, 4)).toEqual(['      - uses: x/y@v1', '        with:', '          k: v']);
    expect(["      id-token: 'write'", '      "id-token": write', '      id-token: read'].map((l) => ID_TOKEN_WRITE.test(l))).toEqual([true, true, false]);
  });

  it('the canonical form refuses every other YAML form, and only those', () => {
    const fine = [
      'name: x', 'on:', '  push:', '    branches:', '      - main', "      - 'v*'", 'permissions: {}', 'jobs:', '  a:',
      '    strategy:', '      matrix:', "        os: [ubuntu-latest, 'x']",
      '    steps:', '      # c', '      - uses: x/y@v1 # v1', '        with:', '          body: |', '            **a**: *b &c',
      '            "run": x', '          k: v', '      - name: n', '        if: ${{ !(a) }}', '        run: |-',
      '          echo "x" # c', '      - run: npm test', '      - run: >-', '          echo',
    ];
    // (the last two lines: a > block is fine for a key other than run:, so it is refused only as run:'s value)
    expect(canonicalFormProblems(fine.slice(0, -2))).toEqual([]);
    expect(canonicalFormProblems(['body: >-', '  text', 'k: v'])).toEqual([]);
    const refused = {
      'a tab': ['jobs:', '\ta: x'],
      'a tab in a block': ['run: |', '  \tnpm ci'],
      'a quoted key': ['"run": npm ci'],
      'a quoted key in an item': ['steps:', "  - 'run': npm ci"],
      'a space before the colon': ['run : npm ci'],
      'a space before the colon in an item': ['steps:', '  - run : npm ci'],
      'a complex key': ['? run', ': npm ci'],
      'a merge key': ['a:', '  <<: *b'],
      'an anchor': ['run: &a npm ci'],
      'an alias': ['run: *a'],
      'a tag': ['run: !!str npm ci'],
      'an anchored item': ['steps:', '  - &a', '    run: x'],
      'an anchor in a flow value': ['k: [&a x]'],
      'a nested list': ['a:', '  - - x'],
      'a flow item': ['matrix:', '  include:', '    - { os: x }'],
      'an item with a colon': ['steps:', '  - run:npm ci'],
      'a folded run': ['run: >', '  npm ci'],
      'a folded run, strip': ['run: >-', '  npm ci'],
      'a quoted run': ['run: "npm ci"'],
      'a single-quoted run': ["run: 'npm ci'"],
      'a flow run': ['run: [npm ci]'],
      'an indentation indicator': ['run: |2', '   npm ci'],
      'a block header with a comment': ['run: | # c', '  npm ci'],
      'a plain value continued': ['run: npm ci', '  --no-ignore-scripts'],
      'a plain value continued after a blank line': ['run: npm ci', '', '  --no-ignore-scripts'],
      'a plain value continued by a comment line': ['k: v', '  # c'],
      'a quoted value over two lines': ['title: "a', '  b"'],
      'an item continued': ['a:', '  - main', '    x'],
      'a line that is no key': ['a:', '  just text'],
      'a key twice': ['permissions: {}', 'jobs:', '  a:', '    x: 1', '    x: 2'],
      'a top-level key twice': ['permissions: {}', 'jobs:', 'permissions:', '  contents: write'],
      'a key twice in one step': ['steps:', '  - run: echo', '    run: npm ci'],
    };
    for (const [what, lines] of Object.entries(refused)) expect(canonicalFormProblems(lines), what).not.toEqual([]);
    // The same key in two steps, or in two jobs, is not twice in one mapping.
    expect(canonicalFormProblems(['jobs:', '  a:', '    steps:', '      - run: x', '      - run: y', '  b:', '    steps:', '      - run: z'])).toEqual([]);
  });

  it('the reader refuses step lists, steps and permissions in forms it cannot follow, and only those', () => {
    const fine = [
      'permissions: {}', 'jobs:', '  a:', '    permissions:', '      contents: read', "      'id-token': \"write\" # c",
      '    strategy:', '      matrix:', '        include:', '          - { os: x }', '    steps:', '      - uses: x/y@v1',
      '        with:', '          k: [1, 2]', '      - run: echo', '  b:', '    steps:', '    - run: echo', '    - name: n',
    ];
    expect(unreadableForms(fine)).toEqual([]);
    const refused = {
      'a step in flow form': ['jobs:', '  a:', '    steps:', '      - run: echo', '      - { uses: x/y@v1 }'],
      'a step in flow form at the key indent': ['jobs:', '  a:', '    steps:', '    - [ x ]'],
      'steps in flow form': ['jobs:', '  a:', '    steps: [ { run: echo } ]'],
      'permissions as one value': ['permissions: write-all'],
      'one flow value': ['jobs:', '  a:', '    permissions: { id-token: write }'],
      'a value on the next line': ['permissions:', '  write-all'],
      'a flow value on the next line': ['jobs:', '  a:', '    permissions:', '      { id-token: write }'],
      'a line other than scope: level': ['permissions:', '  contents: read', '  id-token: write-all'],
      'steps in flow form on the next line': ['jobs:', '  a:', '    steps:', '      [ { run: npm publish } ]'],
      'steps in flow form over lines': ['jobs:', '  a:', '    steps:', '      [', '        { run: npm publish }', '      ]'],
      'a step on the line after its dash': ['jobs:', '  a:', '    steps:', '      -', '        { run: npm publish }'],
      'a step on the line after its dash, block form': ['jobs:', '  a:', '    steps:', '      - # c', '        run: npm publish'],
    };
    for (const [what, lines] of Object.entries(refused)) expect(unreadableForms(lines), what).not.toEqual([]);
  });

  it.each(FILES)('%s is in the canonical form and has no step or permissions in a form the reader cannot follow', (name) => {
    expect(canonicalFormProblems(read(name)), name).toEqual([]);
    expect(unreadableForms(read(name)), name).toEqual([]);
  });

  it.each(FILES)('%s pins every action to a full commit SHA with the version in a comment', (name) => {
    const uses = read(name).filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const ref = line.replace(/^\s*(-\s+)?uses:\s*/, '');
      if (ref.startsWith('./')) continue; // a local action
      expect(ref, `${name}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/);
    }
  });

  it.each(FILES)('%s has no ${{ }} expression inside a run: script', (name) => {
    const scripts = runScripts(read(name));
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s.text, `${name}: run: at line ${s.start}`).not.toContain('${{');
  });

  it.each(FILES)('%s grants no top-level write and id-token only to the publish job of publish.yml', (name) => {
    const lines = read(name);
    const jobs = jobsOf(lines);
    const top = lines.findIndex((l) => /^permissions:/.test(l));
    expect(top, `${name}: a top-level permissions`).toBeGreaterThanOrEqual(0);
    const granted = [];
    for (let j = top + 1; j < lines.length && (isBlank(lines[j]) || /^\s/.test(lines[j])); j++) if (!isBlank(lines[j])) granted.push(lines[j].trim());
    if (!/^permissions:\s*\{\}\s*$/.test(lines[top])) expect(granted, `${name}: top-level permissions`).toEqual(['contents: read']);
    const idToken = lines.map((l, i) => (ID_TOKEN_WRITE.test(l) ? jobs[i] : null)).filter((j) => j !== null);
    expect(idToken).toEqual(name === 'publish.yml' ? ['publish'] : []);
  });

  it.each(FILES)('%s leaves no credential behind in any checkout', (name) => {
    const lines = read(name);
    const checkouts = lines.map((l, i) => (CHECKOUT.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const i of checkouts) expect(credentialProblem(lines, i), `${name}: checkout at line ${i + 1}`).toBeNull();
  });

  it('the credential check takes only persist-credentials: false directly under the step\'s with:', () => {
    const step = (...body) => ['    steps:', '      - uses: actions/checkout@abc # v1', ...body, '      - run: echo'];
    expect(credentialProblem(step('        with:', '          ref: x', '          persist-credentials: false'), 1)).toBeNull();
    const refused = {
      'none': step('        with:', '          ref: x'),
      'under env:': step('        env:', '          persist-credentials: false'),
      'under env: beside with:': step('        with:', '          ref: x', '        env:', '          persist-credentials: false'),
      'true': step('        with:', '          persist-credentials: true'),
      'quoted': step('        with:', "          persist-credentials: 'false'"),
      'twice': step('        with:', '          persist-credentials: false', '          persist-credentials: true'),
      'deeper': step('        with:', '          x:', '            persist-credentials: false'),
    };
    for (const [what, lines] of Object.entries(refused)) expect(credentialProblem(lines, 1), what).not.toBeNull();
    expect(CHECKOUT.test('      - uses: Actions/Checkout@abc # v1')).toBe(true);
  });

  it('publish.yml names npm / npx only on the lines listed for each job', () => {
    expect(publishProblems(read('publish.yml'))).toEqual([]);
    // Each listed line is in the file (the list does not outlive the workflow).
    const text = read('publish.yml').map((l) => l.trim());
    for (const [job, allowed] of Object.entries(PUBLISH_NPM_LINES)) {
      for (const a of allowed) expect(text.includes(a), `${job}: ${a}`).toBe(true);
    }
  });

  it('the listed npm commands install without scripts, publish only with provenance and run no package code in publish', () => {
    const commands = (job) => PUBLISH_NPM_LINES[job].filter((l) => !/^(#|- name: |registry-url: |echo )/.test(l)).map((l) => l.replace(/^run: /, ''));
    const installs = [...commands('verify'), ...commands('publish')].filter((c) => /\bnpm\s+(ci|install|i|publish)\b/.test(c));
    expect(installs.length).toBe(3);
    for (const c of installs) expect(npmFlagProblems(c), c).toEqual([]);
    // publish installs only a fixed npm, publishes and looks the version up: no npm ci / test / run / exec, no npx.
    expect(commands('publish').map((c) => c.match(/\bnp[mx]\s+(\S+)/)[0])).toEqual(['npm install', 'npm --version', 'npm publish', 'npm view']);
    expect(commands('publish')[0]).toMatch(/^npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts$/);
    // The flag check itself.
    for (const c of ['npm ci', 'npm publish --ignore-scripts', 'npm ci --no-ignore-scripts', 'npm ci --ignore-scripts --ignore-scripts=false', 'npm publish --provenance --ignore-scripts --no-provenance']) {
      expect(npmFlagProblems(c), c).not.toEqual([]);
    }
  });

  it('publish.yml refuses any other line naming npm / npx and any other YAML form, wherever it is put', () => {
    const base = read('publish.yml');
    const at = base.findIndex((l) => l.trim() === 'npm --version');
    const verifyAt = base.findIndex((l) => l.trim() === 'run: npm test');
    const pad = ' '.repeat(indentOf(base[at]));
    const added = [
      'npm ci', 'npm publish --access public --ignore-scripts --tag "a\\"b" # --provenance',
      'npm publish --access public --provenance $OFF --ignore-scripts', 'npm publish --access public --provenance f\'als\'e --ignore-scripts',
      'npm publish --access public --ignore-scripts --tag x\\\\', 'NPM_CONFIG_PROVENANCE=false npm publish --access public --provenance --ignore-scripts',
      'npx some-package', '# end" && npm ci', '\tnpm ci', '  --no-ignore-scripts', 'echo --provenance', 'n""pm ci --ignore-scripts && npm ci',
      'npm --global install x', 'npm rum x', 'npm init x', 'npm --yes exec x', 'npm --prefix . install',
    ];
    for (const a of added) {
      const lines = [...base];
      lines.splice(at + 1, 0, pad + a);
      expect(publishProblems(lines), a).not.toEqual([]);
    }
    const inVerify = [...base];
    inVerify.splice(verifyAt + 1, 0, '        env:', '          NPM_CONFIG_IGNORE_SCRIPTS: "false"');
    expect(publishProblems(inVerify)).not.toEqual([]);
    for (const form of ['run: >', 'run: >-', 'run: "npm test"', "run: 'npm test'", 'run: !!str |', 'run: &a |', 'run: *a', 'run: |2', 'run: [npm test]', 'run : npm test', '"run": npm test']) {
      const lines = [...base];
      lines[verifyAt] = lines[verifyAt].replace('run: npm test', form);
      expect(publishProblems(lines), form).not.toEqual([]);
    }
    const continued = [...base];
    continued.splice(verifyAt + 1, 0, '          --foo');
    expect(publishProblems(continued)).not.toEqual([]);
    const top = [...base];
    top.splice(top.findIndex((l) => l === 'jobs:'), 0, 'env:', '  npm_config_provenance: false', '');
    expect(publishProblems(top)).not.toEqual([]);
  });
});
