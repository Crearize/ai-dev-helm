'use strict';

// 3.7.2 (#234, design S3 / S4): the hardening of the GitHub workflows, kept from coming back undone.
// - every action is pinned to a full commit SHA (the version in a trailing comment)
// - no ${{ }} expression inside a run: script (expressions reach scripts through env:)
// - no permission at the top level beyond contents: read; id-token: write only in publish.yml's publish job
// - every checkout leaves no credential behind (persist-credentials: false)
// - publish.yml: every npm ci / install / publish runs with --ignore-scripts, every publish has --provenance (no
//   publish without provenance), the publish job installs no dependency and npm is an exact version, not @latest
//
// The workflows are read line by line (no YAML dependency): a job is a two-space key under `jobs:`, a step starts at
// `- `, and a block scalar (`run: |`) runs while the lines are indented deeper than its key.

const fs = require('node:fs');
const path = require('node:path');
// describe / it / expect come from vitest globals (see vitest config).

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const FILES = fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort();
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8').split(/\r?\n/);
const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);

// The job of each line ('' before `jobs:` and for top-level keys).
function jobsOf(lines) {
  let inJobs = false;
  let job = '';
  return lines.map((line) => {
    if (/^\S/.test(line)) { inJobs = /^jobs:\s*$/.test(line); job = ''; return ''; }
    const m = inJobs && line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) job = m[1];
    return job;
  });
}

// [{ start, text }] for every run: script (inline or block scalar).
function runScripts(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*(?:-\s+)?)run:\s*(.*)$/);
    if (!m) return;
    const keyIndent = m[1].length;
    if (!/^[|>][-+0-9]*\s*(#.*)?$/.test(m[2])) { out.push({ start: i + 1, text: m[2] }); return; }
    const body = [];
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

// The shell commands of a script (comments dropped), for the npm checks.
const commandsOf = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);

describe('workflow hardening (3.7.2, S3 / S4)', () => {
  it('reads the three workflows', () => {
    expect(FILES).toEqual(expect.arrayContaining(['publish.yml', 'sync-superpowers.yml', 'test.yml']));
  });

  // Self-test of the reader on a made-up workflow, so a check below cannot pass by reading nothing.
  it('the reader finds jobs, run scripts and steps', () => {
    const lines = [
      'permissions: {}', 'jobs:', '  a:', '    steps:', '      - uses: x/y@v1', '        with:', '          k: v',
      '      - run: |', '          echo ${{ inputs.t }}', '          npm ci', '      - name: n', '        run: npm test',
      '  b:', '    permissions:', '      id-token: write',
    ];
    expect(jobsOf(lines)).toEqual(['', '', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b']);
    expect(runScripts(lines)).toEqual([{ start: 8, text: '          echo ${{ inputs.t }}\n          npm ci' }, { start: 12, text: 'npm test' }]);
    expect(stepOf(lines, 4)).toEqual(['      - uses: x/y@v1', '        with:', '          k: v']);
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
    const idToken = lines.map((l, i) => (/^\s*id-token:\s*write/.test(l) ? jobs[i] : null)).filter((j) => j !== null);
    expect(idToken).toEqual(name === 'publish.yml' ? ['publish'] : []);
  });

  it.each(FILES)('%s leaves no credential behind in any checkout', (name) => {
    const lines = read(name);
    const checkouts = lines.map((l, i) => (/^\s*(-\s+)?uses:\s*actions\/checkout@/.test(l) ? i : -1)).filter((i) => i >= 0);
    for (const i of checkouts) expect(stepOf(lines, i).map((l) => l.trim()), `${name}: checkout at line ${i + 1}`).toContain('persist-credentials: false');
  });

  it('publish.yml runs npm without install scripts, publishes only with provenance, and installs nothing in publish', () => {
    const lines = read('publish.yml');
    const jobs = jobsOf(lines);
    const scripts = runScripts(lines).map((s) => ({ ...s, job: jobs[s.start - 1], commands: commandsOf(s.text) }));
    const npm = scripts.flatMap((s) => s.commands.filter((c) => /\bnpm (ci|install|i|publish)\b/.test(c)).map((c) => ({ job: s.job, c })));
    expect(npm.map((n) => n.job)).toEqual(expect.arrayContaining(['verify', 'publish']));
    for (const { c } of npm) expect(c).toContain('--ignore-scripts');
    const publishes = npm.filter((n) => /\bnpm publish\b/.test(n.c));
    expect(publishes.length).toBeGreaterThan(0);
    for (const { c } of publishes) expect(c).toContain('--provenance');
    const inPublish = npm.filter((n) => n.job === 'publish' && !/\bnpm publish\b/.test(n.c));
    expect(inPublish.map((n) => n.c)).toEqual([expect.stringMatching(/^npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts$/)]);
    expect(lines.join('\n')).not.toMatch(/npm@latest/);
    expect(scripts.filter((s) => s.job === 'publish').map((s) => s.text).join('\n')).not.toMatch(/\bnpm test\b/);
  });
});
