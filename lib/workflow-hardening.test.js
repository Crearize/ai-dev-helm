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
// plain scalar continued on the next lines). YAML forms this reader would misread are refused outright instead: a
// step in flow form (`- { ... }`) and a permissions value on the key's line other than `{}` (`write-all`, `read-all`,
// `{ id-token: write }`).

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
    const body = m[2] === '' || /^[|>][-+0-9]*\s*(#.*)?$/.test(m[2]) ? [] : [m[2]];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= keyIndent) break;
      body.push(lines[j]);
    }
    out.push({ start: i + 1, text: body.join('\n') });
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

// The shell commands of a script (comments dropped), and the arguments of one command.
const commandsOf = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);
const argsOf = (command) => command.split(/\s+/);

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
      { start: 8, text: '          echo ${{ inputs.t }}\n          npm ci' },
      { start: 12, text: 'npm test\n          --x' },
      { start: 14, text: '          echo y' },
    ]);
    expect(stepOf(lines, 4)).toEqual(['      - uses: x/y@v1', '        with:', '          k: v']);
    expect(["      id-token: 'write'", '      "id-token": write', '      id-token: read'].map((l) => ID_TOKEN_WRITE.test(l))).toEqual([true, true, false]);
  });

  it.each(FILES)('%s has no step or permissions in a form the reader cannot follow', (name) => {
    for (const [i, line] of read(name).entries()) {
      expect(line, `${name}:${i + 1}: a step in flow form`).not.toMatch(/^\s*-\s*\{/);
      const p = line.match(/^\s*["']?permissions["']?\s*:\s*(.*?)\s*(#.*)?$/);
      if (p) expect(p[1], `${name}:${i + 1}: permissions as one value`).toMatch(/^(\{\})?$/);
    }
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
    const scripts = runScripts(lines).map((s) => ({ ...s, job: jobs[s.start - 1], commands: commandsOf(s.text) }));
    const npm = scripts.flatMap((s) => s.commands.filter((c) => /\bnpm\s+(ci|install|i|publish)\b/.test(c)).map((c) => ({ job: s.job, c })));
    expect(npm.map((n) => n.job)).toEqual(expect.arrayContaining(['verify', 'publish']));
    // Flags as whole arguments: `--ignore-scripts=false` or `--provenance=false` would turn them off.
    for (const { c } of npm) {
      expect(argsOf(c), c).toContain('--ignore-scripts');
      expect(c).not.toMatch(/--(ignore-scripts|provenance)=/);
    }
    const publishes = npm.filter((n) => /\bnpm\s+publish\b/.test(n.c));
    expect(publishes.length).toBeGreaterThan(0);
    for (const { c } of publishes) expect(argsOf(c), c).toContain('--provenance');
    const inPublish = npm.filter((n) => n.job === 'publish' && !/\bnpm\s+publish\b/.test(n.c));
    expect(inPublish.map((n) => n.c)).toEqual([expect.stringMatching(/^npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts$/)]);
    expect(lines.join('\n')).not.toMatch(/npm@latest/);
    // The publish job runs no package code: no tests, no npx / npm exec (they fetch and run a package).
    const publishJob = scripts.filter((s) => s.job === 'publish').flatMap((s) => s.commands).join('\n');
    expect(publishJob).not.toMatch(/\bnpm\s+(test|t|run|run-script|exec|x)\b|\bnpx\b/);
  });
});
