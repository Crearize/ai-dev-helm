'use strict';

// 3.7.2 (#234, design S3 / S4): the hardening of the GitHub workflows, kept from coming back undone.
// - every action is pinned to a full commit SHA (the version in a trailing comment)
// - no ${{ }} expression inside a run: script (expressions reach scripts through env:)
// - no permission at the top level beyond contents: read; id-token: write only in publish.yml's publish job
// - every checkout is a `- uses:` step that leaves no credential behind (one `persist-credentials: false` line, in the
//   step's own with:)
// - the top-level keys, the jobs and the permissions of every job are fixed per file (WORKFLOW_SHAPES)
// - publish.yml: the publish job (the only one with id-token: write) is fixed line by line, indentation included
//   (PUBLISH_JOB); in its other jobs and in sync-superpowers.yml (which holds write permissions) every line that names
//   npm, npx, ignore-scripts or provenance is one of a fixed list per job (NPM_LINES). The npm commands install
//   without scripts, publish only with provenance, take only the arguments of NPM_ARGS, and the publish job runs no
//   package code
//
// The workflows are read line by line (no YAML dependency). The test does not try to follow every YAML or shell
// form: it accepts a narrow, canonical subset of YAML and refuses the rest (canonicalFormProblems, unreadableForms),
// so the reader never has to guess:
// - lines end in LF or CRLF only: no lone CR, no NEL / U+2028 / U+2029 (YAML breaks lines there too), no BOM, no tab
//   or other control character
// - every YAML line is `key: value`, `key:` or a `- ` list item, with a plain key followed directly by `:` (no quoted
//   key, no space before the colon, no `? ` key, no merge key `<<:`), and no key twice in one mapping; a list item is
//   `- key: value` or a plain word or quoted string (no nested list, no flow collection as an item)
// - no anchor, alias or tag (`&a`, `*a`, `!tag`); a flow value is `{}` or a list of plain words and quoted strings
// - every value on one line: a quoted value closes on its line, and no line after `key: value` (or a `- ` scalar item)
//   is deeper, so no scalar runs over several lines; a block scalar header is `|` or `>` with an optional chomping
//   sign only, and a run: value is one plain line or a `|` block
// - steps and permissions in block form only
// With that, a job is a two-space key under `jobs:` (a comment line, at any indentation, ends nothing), a step starts
// at `- `, and a run: script is its one-line value or
// its `|` block. The shell inside a run: script is not parsed at all: the publish job is compared whole and the npm
// lines of the other jobs one by one, so no shell form (continuations, quotes, comments, joined commands, flag values)
// has to be read right. In the jobs other than publish, a line that keeps npm out of its words (a variable, a quoted
// fragment) is out of reach of this test; those jobs hold no id-token, and review covers them.

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
// `key: >` and every following line deeper than the key) are not YAML and are only checked for the characters.
const FLOW_ITEM = String.raw`(?:[\w.-]+|'[^']*'|"[^"\\]*")`;
const FLAT_LIST = new RegExp(String.raw`^\[\s*(?:${FLOW_ITEM}(?:\s*,\s*${FLOW_ITEM})*)?\s*\](?:\s+#.*)?$`);
function canonicalFormProblems(lines) {
  const out = [];
  const nextNonEmpty = (i) => lines.slice(i + 1).find((l) => l.trim() !== '');
  const mappings = []; // [{ col, keys }] from the outermost to the current mapping
  let blockAbove = -1; // the key column of the block scalar being skipped, or -1
  lines.forEach((line, i) => {
    const at = `${i + 1}: `;
    // (read() splits at LF and CRLF only, so a lone CR stays in the line.)
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b-\x1f\x7f\u0085\u2028\u2029\ufeff\t]/.test(line)) out.push(`${at}a tab, a lone CR, a Unicode line break, a BOM or another control character`);
    if (blockAbove >= 0) {
      if (line.trim() === '' || indentOf(line) > blockAbove) return;
      blockAbove = -1;
    }
    if (isBlank(line)) return;
    const m = line.match(/^( *)(- +)?(.*)$/s);
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
    if (/^[&*!]/.test(value)) out.push(`${at}an anchor, alias or tag`);
    if (/^\{/.test(value) && !/^\{\}(\s+#.*)?$/.test(value)) out.push(`${at}a flow mapping other than {}`);
    if (/^\[/.test(value) && !FLAT_LIST.test(value)) out.push(`${at}a flow list other than plain words and quoted strings`);
    if (/^"/.test(value) && !/^"(?:[^"\\]|\\.)*"(\s+#.*)?$/.test(value)) out.push(`${at}a double-quoted value not closed on its line`);
    if (/^'/.test(value) && !/^'(?:[^']|'')*'(\s+#.*)?$/.test(value)) out.push(`${at}a single-quoted value not closed on its line`);
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

// The job of each line ('' before `jobs:` and for top-level keys). A comment line belongs to the job around it, as in
// YAML: a comment at column 0 after the last job does not end it.
function jobsOf(lines) {
  let inJobs = false;
  let job = '';
  return lines.map((line) => {
    if (/^\s*#/.test(line)) return job;
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

// The checkout steps of a file (any case: GitHub matches owner/repo without it). A checkout is a step of its own line
// `- uses: actions/checkout@...` (so the step starts at that line, not at a `- ` inside a block above it), and it
// leaves no credential: the step names persist-credentials on exactly one line, and that line is
// `persist-credentials: false` directly under the step's own `with:` (not under env:, not twice).
const CHECKOUT = /^\s*(-\s+)?uses:\s*["']?actions\/checkout[@/]/i;
const CHECKOUT_STEP = /^\s*- uses: actions\/checkout@/;
function credentialProblem(lines, i) {
  if (!CHECKOUT_STEP.test(lines[i])) return `a checkout other than a "- uses: actions/checkout@" line: ${lines[i].trim()}`;
  const step = stepOf(lines, i);
  const col = indentOf(step[0]) + 2;
  const named = step.filter((l) => /persist-credentials/i.test(l));
  if (named.length !== 1) return `persist-credentials named on ${named.length} lines`;
  const w = step.findIndex((l) => l === `${' '.repeat(col)}with:`);
  const at = step.indexOf(named[0]);
  if (w < 0 || at < w || step.slice(w + 1, at).some((l) => !isBlank(l) && indentOf(l) <= col)) return 'persist-credentials outside the step\'s with:';
  if (named[0] !== `${' '.repeat(col + 2)}persist-credentials: false`) return `not "persist-credentials: false" directly under with: ${named[0].trim()}`;
  return null;
}

// The shape of each workflow: its top-level keys in order, its jobs in order, and the permissions of the top level
// ('') and of each job, as the trimmed lines of the block ('{}' for `permissions: {}`, [] for none). Change a workflow
// and this together, on purpose.
const WORKFLOW_SHAPES = {
  'publish.yml': {
    top: ['name', 'on', 'permissions', 'jobs'],
    permissions: { '': '{}', 'release-please': ['contents: write', 'pull-requests: write'], verify: ['contents: read'], publish: ['contents: read', 'id-token: write'] },
  },
  'sync-superpowers.yml': {
    top: ['name', 'on', 'permissions', 'jobs'],
    permissions: { '': '{}', sync: ['contents: write', 'pull-requests: write', 'issues: write'] },
  },
  'test.yml': {
    top: ['name', 'on', 'permissions', 'concurrency', 'jobs'],
    permissions: { '': ['contents: read'], test: [], gradle: [] },
  },
};
function shapeOf(lines) {
  const jobs = jobsOf(lines);
  const top = lines.filter((l) => /^\S/.test(l) && !/^#/.test(l)).map((l) => l.replace(/:.*$/, ''));
  const permissions = { '': [] };
  lines.forEach((l, i) => { if (jobs[i] !== '' && /^ {2}\S/.test(l)) permissions[jobs[i]] = []; });
  lines.forEach((l, i) => {
    const p = l.match(/^(\s*)permissions:\s*(.*?)\s*$/);
    if (!p) return;
    const job = jobs[i];
    if (p[2] !== '') { permissions[job] = p[2]; return; }
    const granted = [];
    for (let j = i + 1; j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) > p[1].length); j++) if (!isBlank(lines[j])) granted.push(lines[j].trim());
    permissions[job] = granted;
  });
  return { top, permissions };
}

// publish.yml's publish job, line by line (it holds id-token: write: nothing but these lines runs there). Change
// publish.yml and this together, on purpose (the npm version too: it is not taken from @latest).
const PUBLISH_JOB = [
  '  publish:',
  '    needs: verify',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '      id-token: write',
  '    steps:',
  '      - name: Check the tag',
  '        env:',
  '          TAG: ${{ needs.verify.outputs.tag }}',
  '        run: |',
  "          SEMVER_TAG='^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'",
  '          if ! [[ "$TAG" =~ $SEMVER_TAG ]]; then',
  '            echo "::error::The tag is not v<semver>"',
  '            exit 1',
  '          fi',
  '',
  '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
  '        with:',
  '          ref: refs/tags/${{ needs.verify.outputs.tag }}',
  '          persist-credentials: false',
  '',
  '      - name: Check the commit is the one verify tested',
  '        env:',
  '          TESTED: ${{ needs.verify.outputs.sha }}',
  '        run: |',
  '          HEAD_SHA=$(git rev-parse HEAD)',
  '          if [ "$HEAD_SHA" != "$TESTED" ]; then',
  '            echo "::error::The tag moved after verify ($TESTED -> $HEAD_SHA)"',
  '            exit 1',
  '          fi',
  '',
  '      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0',
  '        with:',
  "          node-version: '26'",
  '          check-latest: true',
  "          registry-url: 'https://registry.npmjs.org'",
  '',
  '      # Trusted Publishing needs npm 11.5.1+. 12.2.1 is the version that',
  '      # published 3.7.1; change it on purpose, not through @latest.',
  '      - name: Install a fixed npm for Trusted Publishing',
  '        run: |',
  '          npm install -g npm@12.2.1 --ignore-scripts',
  '          npm --version',
  '',
  '      - name: Publish to npm (Trusted Publishing / OIDC, with provenance)',
  '        run: |',
  '          set +e',
  '          npm publish --access public --provenance --ignore-scripts 2>&1 | tee publish.log',
  '          status=${PIPESTATUS[0]}',
  '          set -e',
  '',
  '          if [ "$status" -eq 0 ]; then',
  '            exit 0',
  '          fi',
  '',
  '          # npm can create the Sigstore tlog entry before the registry publish',
  '          # fails, and a retry with --provenance then hits the immutable tlog',
  '          # entry. A version without provenance is never published: if the',
  '          # version is already on npm the publish is complete; otherwise stop.',
  "          if ! grep -q 'TLOG_CREATE_ENTRY_ERROR' publish.log; then",
  '            exit "$status"',
  '          fi',
  '',
  "          VERSION=$(node -p \"require('./package.json').version\")",
  '          if npm view "@crearize/ai-dev-helm@$VERSION" version >/dev/null 2>&1; then',
  '            echo "Version $VERSION is already published on npm; treating publish as complete."',
  '            exit 0',
  '          fi',
  '',
  '          echo "::error::The provenance tlog entry for $VERSION exists but $VERSION is not on npm. Do not publish it without provenance: release the next patch version instead."',
  '          exit "$status"',
];
function publishJobProblems(lines) {
  const jobs = jobsOf(lines);
  const job = lines.filter((l, i) => jobs[i] === 'publish');
  while (job.length && job[job.length - 1].trim() === '') job.pop();
  if (job.length === PUBLISH_JOB.length && job.every((l, k) => l === PUBLISH_JOB[k])) return [];
  const k = job.findIndex((l, n) => l !== PUBLISH_JOB[n]);
  return [`the publish job differs from PUBLISH_JOB at its line ${k < 0 ? job.length + 1 : k + 1}: ${k < 0 ? '(end)' : job[k].trim()}`];
}

// publish.yml (jobs other than publish) and sync-superpowers.yml (it holds contents, pull-requests and issues write):
// every line that names npm, npx, ignore-scripts or provenance (any case, so NPM_CONFIG_* too; comment lines included)
// is one of these, exactly. At the top level only comments and the name may name them. test.yml holds only
// contents: read and no secret, and one of its legs runs install scripts on purpose; it is not listed.
const NPM_WORDS = /np[mx]|ignore-scripts|provenance/i;
const NPM_LINES = {
  'publish.yml': {
    'release-please': [],
    verify: [
      "# --ignore-scripts: no dependency's install script runs. The only one in",
      "# npm's strict resolver refuses regardless). Kept as an explicit flag so",
      '# recovery publishes of tags cut before the repo .npmrc landed still',
      'run: npm ci --ignore-scripts --legacy-peer-deps',
      'run: npm test',
    ],
  },
  'sync-superpowers.yml': {
    sync: [
      '# No token in .git/config while npm ci runs (3.7.2, #234). create-pull-request',
      'cache: npm',
      "# --ignore-scripts: no dependency's install script runs (legacy-peer-deps",
      "# comes from the repository's .npmrc).",
      'npm ci --ignore-scripts',
      'npx vitest run lib/skill-transform.test.js',
    ],
  },
};
function npmLineProblems(lines, name) {
  const jobs = jobsOf(lines);
  const problems = [];
  lines.forEach((line, i) => {
    if (!NPM_WORDS.test(line) || (name === 'publish.yml' && jobs[i] === 'publish')) return;
    const text = line.trim();
    if (jobs[i] === '') {
      if (!/^(#|name: )/.test(line)) problems.push(`${i + 1}: npm / npx at the top level: ${text}`);
      return;
    }
    const allowed = NPM_LINES[name][jobs[i]];
    if (!allowed || !allowed.includes(text)) problems.push(`${i + 1}: ${jobs[i]}: ${text}`);
  });
  return problems;
}

// Everything the checks below refuse in a workflow: the canonical form, the forms the reader cannot follow, the shape,
// the checkouts, and in publish.yml the publish job, in the files of NPM_LINES their npm lines.
const workflowProblems = (name, lines) => {
  const shape = shapeOf(lines);
  const shapeProblems = JSON.stringify(shape) === JSON.stringify(WORKFLOW_SHAPES[name]) ? [] : [`the shape differs: ${JSON.stringify(shape)}`];
  const checkouts = lines.map((l, i) => (CHECKOUT.test(l) ? credentialProblem(lines, i) : null)).filter(Boolean);
  return [
    ...canonicalFormProblems(lines), ...unreadableForms(lines), ...shapeProblems, ...checkouts,
    ...(name === 'publish.yml' ? publishJobProblems(lines) : []),
    ...(NPM_LINES[name] ? npmLineProblems(lines, name) : []),
  ];
};
const publishProblems = (lines) => workflowProblems('publish.yml', lines);

// What is wrong with one listed npm ci / install / publish command (a fixed line, not shell to be read): an argument
// other than those of NPM_ARGS (so no flag is turned off, given a value or followed by `false`), --ignore-scripts
// missing, or a publish without --provenance. Only the publish line goes on, with exactly ` 2>&1 | tee publish.log`.
const NPM_ARGS = new Set(['ci', 'install', '-g', 'publish', '--access', 'public', '--provenance', '--ignore-scripts', '--legacy-peer-deps']);
function npmFlagProblems(command) {
  const problems = [];
  const [own, rest] = command.split(' 2>&1');
  if (rest !== undefined && (rest !== ' | tee publish.log' || !/^npm publish /.test(own))) problems.push(`more than the npm command: 2>&1${rest}`);
  const args = own.split(' ');
  if (args[0] !== 'npm') problems.push('not an npm command');
  const other = args.slice(1).filter((a) => !NPM_ARGS.has(a) && !/^npm@\d+\.\d+\.\d+$/.test(a));
  if (other.length) problems.push(`an argument other than those of NPM_ARGS: ${other.join(' ')}`);
  if (!args.includes('--ignore-scripts')) problems.push('no --ignore-scripts');
  if (args[1] === 'publish' && !args.includes('--provenance')) problems.push('a publish without --provenance');
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

  it.each(FILES)('%s passes every check together (canonical form, shape, checkouts, the publish job, the npm lines)', (name) => {
    expect(workflowProblems(name, read(name))).toEqual([]);
  });

  it.each(Object.keys(NPM_LINES))('%s names npm / npx only on the lines listed for each job', (name) => {
    expect(npmLineProblems(read(name), name)).toEqual([]);
    // Each listed line is in the file (the list does not outlive the workflow).
    const text = read(name).map((l) => l.trim());
    for (const [job, allowed] of Object.entries(NPM_LINES[name])) {
      for (const a of allowed) expect(text.includes(a), `${job}: ${a}`).toBe(true);
    }
  });

  it('sync-superpowers.yml refuses any other line naming npm / npx', () => {
    const base = read('sync-superpowers.yml');
    const at = base.findIndex((l) => l.trim() === 'npm ci --ignore-scripts');
    const changed = {
      'without --ignore-scripts': (l) => { l[at] = l[at].replace(' --ignore-scripts', ''); },
      'another npm line': (l) => l.splice(at + 1, 0, l[at].replace(/\S.*/, 'npm install x')),
      'an env: turning scripts on': (l) => l.splice(base.indexOf('    steps:'), 0, '    env:', '      NPM_CONFIG_IGNORE_SCRIPTS: false'),
    };
    for (const [what, change] of Object.entries(changed)) {
      const lines = [...base];
      change(lines);
      expect(workflowProblems('sync-superpowers.yml', lines), what).not.toEqual([]);
    }
  });

  it('a comment at column 0 does not end the last job', () => {
    const base = read('publish.yml');
    expect(base.findIndex((l, i) => i > base.indexOf('jobs:') && /^#/.test(l))).toBe(-1);
    // A step after a column-0 comment at the end is still a step of the publish job in YAML.
    for (const step of ['      - run: ./x.sh', '      - name: Publish again', '  extra:']) {
      const lines = [...base, '', '# trailing note', step];
      expect(jobsOf(lines)[lines.length - 1], step).toBe(step === '  extra:' ? 'extra' : 'publish');
      expect(publishProblems(lines), step).not.toEqual([]);
    }
    expect(jobsOf(['jobs:', '  a:', '# c', '    steps:', 'name: x'])).toEqual(['', 'a', 'a', 'a', '']);
  });

  it('publish.yml has the publish job of PUBLISH_JOB, line for line, and refuses any change to it', () => {
    const base = read('publish.yml');
    expect(publishJobProblems(base)).toEqual([]);
    const start = base.indexOf('  publish:');
    const end = start + PUBLISH_JOB.length;
    const changed = {
      'a step added without npm in its words': (l) => l.splice(end, 0, '', '      - run: ./x.sh'),
      'a variable that runs npm': (l) => l.splice(end, 0, '', '      - run: N=n; ${N}pm ci'),
      'an env: added to the job': (l) => l.splice(start + 1, 0, '    env:', '      NPM_CONFIG_PROVENANCE: false'),
      'one line indented otherwise': (l) => { l[start + 1] = ` ${l[start + 1]}`; },
      'a line removed': (l) => l.splice(start + 7, 1),
      'a trailing space': (l) => { l[start + 2] += ' '; },
    };
    for (const [what, change] of Object.entries(changed)) {
      const lines = [...base];
      change(lines);
      expect(publishJobProblems(lines), what).not.toEqual([]);
      expect(publishProblems(lines), what).not.toEqual([]);
    }
  });

  it.each(FILES)('%s has the top-level keys, jobs and permissions of WORKFLOW_SHAPES', (name) => {
    expect(Object.keys(WORKFLOW_SHAPES)).toEqual(FILES);
    expect(shapeOf(read(name))).toEqual(WORKFLOW_SHAPES[name]);
  });

  it('the shape check refuses another top-level key, job or permission', () => {
    const base = read('publish.yml');
    const jobsAt = base.indexOf('jobs:');
    const verifyAt = base.indexOf('  verify:');
    const changed = {
      'a top-level env:': (l) => l.splice(jobsAt, 0, 'env:', '  X: y', ''),
      'a top-level defaults:': (l) => l.splice(jobsAt, 0, 'defaults:', '  run:', '    shell: bash', ''),
      'a job added': (l) => l.push('', '  extra:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo'),
      'a permission added to a job': (l) => l.splice(l.indexOf('      contents: read', verifyAt) + 1, 0, '      actions: write'),
      'a second permissions in a job (also a key twice)': (l) => l.splice(verifyAt + 1, 0, '    permissions:', '      id-token: write'),
    };
    for (const [what, change] of Object.entries(changed)) {
      const lines = [...base];
      change(lines);
      if (!/key twice/.test(what)) expect(shapeOf(lines), what).not.toEqual(WORKFLOW_SHAPES['publish.yml']);
      expect(publishProblems(lines), what).not.toEqual([]);
    }
  });

  it('the canonical form refuses line breaks other than LF / CRLF, control characters and multi-line quoted or flow values', () => {
    const refused = {
      'a lone CR': ['run: npm test\rnpm publish'],
      'a NEL': ['run: npm test\u0085npm publish'],
      'a line separator': ['run: npm test\u2028npm publish'],
      'a paragraph separator': ['run: npm test\u2029npm publish'],
      'a BOM': ['\ufeffname: x'],
      'a control character in a block': ['run: |', '  npm test\u000bnpm publish'],
      'a flow mapping': ['with: { a: b }'],
      'a nested flow list': ['k: [a, [b]]'],
      'a flow list with a mapping': ['k: [a, { b: c }]'],
      'a double-quoted value left open': ['title: "a'],
      'a double-quoted value closed by an escaped quote': ['title: "a\\"'],
      'a single-quoted value left open': ["title: 'a"],
    };
    for (const [what, lines] of Object.entries(refused)) expect(canonicalFormProblems(lines), what).not.toEqual([]);
    expect(canonicalFormProblems(['with: {}', "k: [a, 'b c', \"d\"]", 'title: "a \\" b" # c', "t: 'it''s'"])).toEqual([]);
  });

  it('a checkout is a "- uses: actions/checkout@" step of its own', () => {
    const refused = {
      'uses after another key': ['    steps:', '      - name: n', '        uses: actions/checkout@abc # v1', '        with:', '          persist-credentials: false'],
      'quoted': ['    steps:', "      - uses: 'actions/checkout@abc' # v1", '        with:', '          persist-credentials: false'],
      'other case': ['    steps:', '      - uses: Actions/Checkout@abc # v1', '        with:', '          persist-credentials: false'],
    };
    for (const [what, lines] of Object.entries(refused)) {
      const i = lines.findIndex((l) => CHECKOUT.test(l));
      expect(i, what).toBeGreaterThan(0);
      expect(credentialProblem(lines, i), what).not.toBeNull();
    }
  });

  it('the listed npm commands install without scripts, publish only with provenance and run no package code in publish', () => {
    const listed = (job) => {
      if (job === 'publish') return PUBLISH_JOB.map((l) => l.trim()).filter((l) => NPM_WORDS.test(l));
      return job === 'sync' ? NPM_LINES['sync-superpowers.yml'].sync : NPM_LINES['publish.yml'][job];
    };
    const commands = (job) => listed(job).filter((l) => !/^(#|- name: |registry-url: |cache: |echo )/.test(l)).map((l) => l.replace(/^run: /, ''));
    const installs = [...commands('verify'), ...commands('publish'), ...commands('sync')].filter((c) => /\bnpm\s+(ci|install|i|publish)\b/.test(c));
    expect(installs.length).toBe(4);
    for (const c of installs) expect(npmFlagProblems(c), c).toEqual([]);
    // sync installs without scripts and runs only the skill-transform test.
    expect(commands('sync')).toEqual(['npm ci --ignore-scripts', 'npx vitest run lib/skill-transform.test.js']);
    // publish installs only a fixed npm, publishes and looks the version up: no npm ci / test / run / exec, no npx.
    expect(commands('publish').map((c) => c.match(/\bnp[mx]\s+(\S+)/)[0])).toEqual(['npm install', 'npm --version', 'npm publish', 'npm view']);
    expect(commands('publish')[0]).toMatch(/^npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts$/);
    // The flag check itself.
    for (const c of [
      'npm ci', 'npm publish --ignore-scripts', 'npm ci --no-ignore-scripts', 'npm ci --ignore-scripts --ignore-scripts=false',
      'npm publish --provenance --ignore-scripts --no-provenance',
      // a flag followed by a value that turns it off (npm reads `false` after a boolean flag as its value)
      'npm publish --access public --provenance false --ignore-scripts', 'npm ci --ignore-scripts false',
      'npm ci --ignore-scripts "false"', 'npm ci --ignore-scripts FALSE', 'npm publish --access public --provenance=true --ignore-scripts',
      // other arguments, other commands, more shell after the command
      'npm ci --ignore-scripts --foreground-scripts', 'npm exec --ignore-scripts x', 'npx --ignore-scripts x',
      'npm ci --ignore-scripts 2>&1 | tee x.log', 'npm publish --access public --provenance --ignore-scripts 2>&1 | tee publish.log; npm ci',
      'npm  ci --ignore-scripts',
    ]) {
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
