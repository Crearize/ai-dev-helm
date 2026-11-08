'use strict';

// 3.7.2 (#234, design S3 / S4): the hardening of the GitHub workflows, kept from coming back undone.
// - every action is pinned to a full commit SHA (the version in a trailing comment)
// - no ${{ }} expression inside a run: script (expressions reach scripts through env:)
// - no permission at the top level beyond contents: read; id-token: write only in publish.yml's publish job
// - every checkout leaves no credential behind (persist-credentials: false)
// - publish.yml: every npm ci / install / publish runs with --ignore-scripts, every publish has --provenance (no
//   publish without provenance), the publish job installs and runs no package code and npm is an exact version, not
//   @latest
//
// The workflows are read line by line (no YAML dependency): a job is a two-space key under `jobs:`, a step starts at
// `- `, and a run: script is its value plus every following line indented deeper than its key (a block scalar or a
// plain scalar continued on the next lines). A script's commands are its lines - one line when YAML folds it (a plain
// or `>` value), a `\`-continued line joined to the next - cut at `&&`, `||`, `;`, `|` and `&`. YAML forms this reader
// would misread are refused outright instead (unreadableForms): a step list or a step in flow form (`steps: [...]`,
// `- { ... }` as a step) and permissions other than `{}` or a block of `<scope>: read|write|none` lines (`write-all`,
// `{ id-token: write }`, on the key's line or the next).

const fs = require('node:fs');
const path = require('node:path');
// describe / it / expect come from vitest globals (see vitest config).

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const FILES = fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort();
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8').split(/\r?\n/);
const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);
const ID_TOKEN_WRITE = /^\s*["']?id-token["']?\s*:\s*["']?write\b/;

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

// [{ start, text }] for every run: script: the value on its line (unless a block indicator) and every following line
// indented deeper than the key.
function runScripts(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*(?:-\s+)?)["']?run["']?:\s*(.*)$/);
    if (!m) return;
    const keyIndent = m[1].length;
    const block = /^[|>][-+0-9]*\s*(#.*)?$/.test(m[2]);
    const body = m[2] === '' || block ? [] : [m[2]];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= keyIndent) break;
      body.push(lines[j]);
    }
    out.push({ start: i + 1, text: body.join('\n'), literal: block && m[2].startsWith('|') });
  });
  return out;
}

// Forms the reader cannot follow, as `<line>: <what>`: a step list or a step in flow form (only the items of a
// `steps:` list - a flow-form `matrix.include` item is fine), and permissions other than `{}` or a block of
// `<scope>: read|write|none` lines (a value on the key's line or on the next).
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
        if (ind === item && /^\s*-\s*[{[]/.test(lines[j])) out.push(`${j + 1}: a step in flow form`);
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

// The shell commands of a script (comments dropped), and the arguments of one command. A plain or `>` value is one
// line to the shell (YAML folds it); in a `|` value a line ending in `\` goes on with the next. Commands joined with
// `&&`, `||`, `;`, `|` or `&` (not the `&` of `2>&1` / `&>`) are taken one by one.
function commandsOf({ text, literal }) {
  const lines = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, ''));
  const joined = literal ? lines.join('\n').replace(/\\\n/g, ' ').split('\n') : [lines.join(' ')];
  return joined
    .flatMap((l) => l.split(/&&|\|\||[;|]|(?<![<>])&(?!>)/))
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
const argsOf = (command) => command.split(/\s+/);

// What is wrong with the flags of one npm ci / install / publish command: --ignore-scripts missing, a publish without
// --provenance, or either flag turned off - `--flag=<value>`, `--no-flag`, or a value in the next argument
// (`--ignore-scripts false`; after the flag only another flag, a redirect or nothing may come).
function npmFlagProblems(command) {
  const args = argsOf(command);
  const problems = [];
  if (!args.includes('--ignore-scripts')) problems.push('no --ignore-scripts');
  if (/\bnpm\s+publish\b/.test(command) && !args.includes('--provenance')) problems.push('a publish without --provenance');
  args.forEach((a, k) => {
    if (/^--(no-(ignore-scripts|provenance)(=|$)|(ignore-scripts|provenance)=)/.test(a)) problems.push(`${a} turns the flag off`);
    if (/^--(ignore-scripts|provenance)$/.test(a) && k + 1 < args.length && !/^(-|\d*[<>])/.test(args[k + 1])) problems.push(`${a} ${args[k + 1]}: a value after the flag`);
  });
  return problems;
}

describe('workflow hardening (3.7.2, S3 / S4)', () => {
  it('reads the three workflows', () => {
    expect(FILES).toEqual(expect.arrayContaining(['publish.yml', 'sync-superpowers.yml', 'test.yml']));
  });

  // Self-test of the reader on a made-up workflow, so a check below cannot pass by reading nothing.
  it('the reader finds jobs, run scripts (block, continued and next-line values) and steps', () => {
    const lines = [
      'permissions: {}', 'jobs:', '  a:', '    steps:', '      - uses: x/y@v1', '        with:', '          k: v',
      '      - run: |', '          echo ${{ inputs.t }}', '          npm ci', '      - name: n', '        run: npm test',
      '          --x', '      - run:', '          echo y',
      '  b:', '    permissions:', '      id-token: write',
    ];
    expect(jobsOf(lines)).toEqual(['', '', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b']);
    expect(runScripts(lines)).toEqual([
      { start: 8, text: '          echo ${{ inputs.t }}\n          npm ci', literal: true },
      { start: 12, text: 'npm test\n          --x', literal: false },
      { start: 14, text: '          echo y', literal: false },
    ]);
    expect(stepOf(lines, 4)).toEqual(['      - uses: x/y@v1', '        with:', '          k: v']);
    expect(["      id-token: 'write'", '      "id-token": write', '      id-token: read'].map((l) => ID_TOKEN_WRITE.test(l))).toEqual([true, true, false]);
  });

  it('the reader splits commands (&&, ||, ;, |, &, continued and folded lines) and finds npm flags turned off', () => {
    expect(commandsOf({ text: 'npm ci --ignore-scripts && npm publish --provenance # c\nnpm a || npm b; npm c & npm d', literal: true }))
      .toEqual(['npm ci --ignore-scripts', 'npm publish --provenance', 'npm a', 'npm b', 'npm c', 'npm d']);
    expect(commandsOf({ text: 'npm publish 2>&1 | tee log\nx &>y', literal: true })).toEqual(['npm publish 2>&1', 'tee log', 'x &>y']);
    expect(commandsOf({ text: '  npm ci --ignore-scripts \\\n    --ignore-scripts=false\n  echo', literal: true })).toEqual(['npm ci --ignore-scripts --ignore-scripts=false', 'echo']);
    expect(commandsOf({ text: 'npm ci --ignore-scripts\n  --no-ignore-scripts', literal: false })).toEqual(['npm ci --ignore-scripts --no-ignore-scripts']);
    const ok = ['npm ci --ignore-scripts --legacy-peer-deps', 'npm publish --access public --provenance --ignore-scripts 2>&1', 'npm install -g npm@12.2.1 --ignore-scripts'];
    for (const c of ok) expect(npmFlagProblems(c), c).toEqual([]);
    const bad = [
      'npm ci', 'npm publish --ignore-scripts', 'npm ci --no-ignore-scripts', 'npm ci --ignore-scripts --no-ignore-scripts',
      'npm publish --no-provenance --ignore-scripts', 'npm publish --provenance --ignore-scripts --no-provenance',
      'npm ci --ignore-scripts false', 'npm publish --provenance false --ignore-scripts', 'npm ci --ignore-scripts=false',
      'npm publish --provenance=false --ignore-scripts', 'npm ci --ignore-scripts --ignore-scripts=false',
    ];
    for (const c of bad) expect(npmFlagProblems(c), c).not.toEqual([]);
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
    };
    for (const [what, lines] of Object.entries(refused)) expect(unreadableForms(lines), what).not.toEqual([]);
  });

  it.each(FILES)('%s has no step or permissions in a form the reader cannot follow', (name) => {
    expect(unreadableForms(read(name)), name).toEqual([]);
  });

  it.each(FILES)('%s pins every action to a full commit SHA with the version in a comment', (name) => {
    const uses = read(name).filter((l) => /^\s*(-\s+)?["']?uses["']?\s*:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const ref = line.replace(/^\s*(-\s+)?["']?uses["']?\s*:\s*/, '');
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
    const checkouts = lines.map((l, i) => (/^\s*(-\s+)?["']?uses["']?\s*:\s*["']?actions\/checkout@/.test(l) ? i : -1)).filter((i) => i >= 0);
    for (const i of checkouts) expect(stepOf(lines, i).map((l) => l.trim()), `${name}: checkout at line ${i + 1}`).toContain('persist-credentials: false');
  });

  it('publish.yml runs npm without install scripts, publishes only with provenance, and runs no package code in publish', () => {
    const lines = read('publish.yml');
    const jobs = jobsOf(lines);
    const scripts = runScripts(lines).map((s) => ({ ...s, job: jobs[s.start - 1], commands: commandsOf(s) }));
    const npm = scripts.flatMap((s) => s.commands.filter((c) => /\bnpm\s+(ci|install|i|publish)\b/.test(c)).map((c) => ({ job: s.job, c })));
    expect(npm.map((n) => n.job)).toEqual(expect.arrayContaining(['verify', 'publish']));
    // Flags as whole arguments, not turned off (npmFlagProblems).
    for (const { c } of npm) expect(npmFlagProblems(c), c).toEqual([]);
    expect(npm.filter((n) => /\bnpm\s+publish\b/.test(n.c)).length).toBeGreaterThan(0);
    const inPublish = npm.filter((n) => n.job === 'publish' && !/\bnpm\s+publish\b/.test(n.c));
    expect(inPublish.map((n) => n.c)).toEqual([expect.stringMatching(/^npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts$/)]);
    expect(lines.join('\n')).not.toMatch(/npm@latest/);
    // The publish job runs no package code: no tests, no npx / npm exec (they fetch and run a package).
    const publishJob = scripts.filter((s) => s.job === 'publish').flatMap((s) => s.commands).join('\n');
    expect(publishJob).not.toMatch(/\bnpm\s+(test|t|run|run-script|exec|x)\b|\bnpx\b/);
  });
});
