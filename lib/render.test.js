'use strict';

// 3.7.1 (D6): the render cache filled by two runs at once. Each run builds in its own temporary directory and renames
// it into place; a complete entry another run placed first is used, never removed. No network: a fake npm packs a
// minimal package.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = '9.9.1';
let work;
let fakeNpm;
let savedCache;

// The fake `npm pack <spec> --pack-destination <dir> --silent`: a tarball of package/package.json. With
// FAKE_NPM_RACE set, another run "finishes" the shared entry first (its package holds a marker file).
const FAKE_NPM = `
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_FAIL) process.exit(1);
const dest = args[args.indexOf('--pack-destination') + 1];
const version = args[1].split('@').pop();
fs.mkdirSync(path.join(dest, 'package'), { recursive: true });
fs.writeFileSync(path.join(dest, 'package', 'package.json'), JSON.stringify({ name: '@crearize/ai-dev-helm', version }));
const tar = spawnSync('tar', ['-czf', 'pkg.tgz', 'package'], { cwd: dest, encoding: 'utf8' });
if (tar.status !== 0) { process.stderr.write(String(tar.stderr || tar.error)); process.exit(1); }
fs.rmSync(path.join(dest, 'package'), { recursive: true, force: true });
const race = process.env.FAKE_NPM_RACE;
if (race) {
  fs.mkdirSync(path.join(race, 'package'), { recursive: true });
  fs.writeFileSync(path.join(race, 'package', 'package.json'), JSON.stringify({ name: '@crearize/ai-dev-helm', version }));
  fs.writeFileSync(path.join(race, 'package', 'other-run.txt'), 'placed by the other run');
  fs.writeFileSync(path.join(race, '.complete'), '');
}
`;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-render-cache-'));
  fakeNpm = path.join(work, 'fake-npm.cjs');
  fs.writeFileSync(fakeNpm, FAKE_NPM);
  savedCache = process.env.AI_DEV_HELM_CACHE_DIR;
});

afterAll(() => {
  if (savedCache === undefined) delete process.env.AI_DEV_HELM_CACHE_DIR; else process.env.AI_DEV_HELM_CACHE_DIR = savedCache;
  fs.rmSync(work, { recursive: true, force: true });
});

// The cache as AI_DEV_HELM_CACHE_DIR names it is shared with older releases; this release's entries are under PLACED
// (3.7.2 U5, 3.7.1 C3-M2). freshCache returns that directory.
function freshCache(name) {
  const base = path.join(work, name);
  process.env.AI_DEV_HELM_CACHE_DIR = base;
  return path.join(base, 'placed');
}

const npm = { file: process.execPath, pre: [], shell: false };
const fetch = (env = {}, options = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return require('./render').fetchPackage(VERSION, { retries: 1, delayMs: 0, npm: { ...npm, pre: [fakeNpm] }, ...options });
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
};
const leftovers = (cache) => fs.readdirSync(path.join(cache, 'packages')).filter((f) => f !== VERSION);

describe('render cache: two runs filling one entry (3.7.1 D6)', () => {
  test('a run builds apart and renames its finished package into place', () => {
    const cache = freshCache('alone');
    const root = fetch();
    expect(root).toBe(path.join(cache, 'packages', VERSION, 'package'));
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe(VERSION);
    expect(fs.existsSync(path.join(cache, 'packages', VERSION, '.complete'))).toBe(true);
    expect(leftovers(cache)).toEqual([]);
  });

  test('when another run completes the entry first, it is used as it is and the own copy is dropped', () => {
    const cache = freshCache('race');
    const entry = path.join(cache, 'packages', VERSION);
    const root = fetch({ FAKE_NPM_RACE: entry });
    expect(root).toBe(path.join(entry, 'package'));
    expect(fs.readFileSync(path.join(root, 'other-run.txt'), 'utf8')).toBe('placed by the other run');
    expect(leftovers(cache)).toEqual([]);
  });

  // Cycle 3 (C2-H3): an unfinished entry is never judged abandoned by its time (an older release may be filling it
  // in place, deep down, or its time may be in the future); it is left as it is and this run does not cache.
  test('a complete entry is used without npm; an unfinished one is left as it is and this run does not cache', () => {
    const cache = freshCache('existing');
    const entry = path.join(cache, 'packages', VERSION);
    fetch();
    fs.writeFileSync(path.join(entry, 'package', 'kept.txt'), 'x');
    expect(fetch({ FAKE_NPM_FAIL: '1' })).toBe(path.join(entry, 'package'));
    expect(fs.existsSync(path.join(entry, 'package', 'kept.txt'))).toBe(true);
    fs.rmSync(path.join(entry, '.complete'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const when of [new Date(Date.now() - 10 * 60 * 1000), new Date(Date.now() + 10 * 60 * 1000)]) {
        fs.utimesSync(entry, when, when);
        const root = fetch({}, { waitMs: 50 });
        expect(path.dirname(path.dirname(root))).toBe(path.join(cache, 'packages'));
        expect(path.basename(path.dirname(root))).toMatch(/^\.tmp-/);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe(VERSION);
        // The same run asks again: its own copy, without npm.
        expect(fetch({ FAKE_NPM_FAIL: '1' }, { waitMs: 50 })).toBe(root);
        expect(fs.readdirSync(entry).sort()).toEqual(['package']);
        expect(fs.readdirSync(path.join(entry, 'package')).sort()).toEqual(['kept.txt', 'package.json']);
      }
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/is unfinished .*did not cache\. Remove it by hand/);
    } finally {
      warn.mockRestore();
    }
  });

  test('a failed download leaves no entry and no temporary directory', () => {
    const cache = freshCache('failed');
    expect(() => fetch({ FAKE_NPM_FAIL: '1' })).toThrow(/could not download .* Nothing was written/);
    expect(fs.readdirSync(path.join(cache, 'packages'))).toEqual([]);
  });

  test('placeEntry: a complete entry is never removed; the temporary directory is', () => {
    const { placeEntry } = require('./render');
    const base = fs.mkdtempSync(path.join(work, 'place-'));
    const dir = path.join(base, 'entry');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'theirs'), 'x');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'ours'), 'y');
    expect(placeEntry(tmp, dir, () => true, { delayMs: 0 })).toBe('reused');
    expect(fs.readdirSync(dir)).toEqual(['theirs']);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  // The orders cycles 1 and 2 of the review found (C2-H2): another run places its complete entry while this one
  // looks at an old unfinished entry. Nothing this run did not place is moved or removed - at no moment is the place
  // the other run returned missing.
  test('placeEntry: an entry it did not place is never moved or removed, at any moment', () => {
    const { placeEntry } = require('./render');
    const base = fs.mkdtempSync(path.join(work, 'place-race-'));
    const dir = path.join(base, 'entry');
    const done = (d) => fs.existsSync(path.join(d, '.complete'));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'half'), 'x');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'ours'), 'y');
    const touched = [];
    const rename = vi.spyOn(fs, 'renameSync');
    const remove = vi.spyOn(fs, 'rmSync');
    let looks = 0;
    const isComplete = (d) => {
      const answer = done(d);
      looks += 1;
      if (looks === 1) {
        // Right after the first look: the other run's complete entry takes the place (old here too).
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'theirs'), 'z');
        fs.writeFileSync(path.join(dir, '.complete'), '');
        fs.utimesSync(dir, old, old);
        remove.mockClear();
      }
      return answer;
    };
    try {
      expect(placeEntry(tmp, dir, isComplete, { delayMs: 0 })).toBe('reused');
      for (const [from] of rename.mock.calls) if (path.resolve(from) === dir) touched.push(`renamed ${from}`);
      for (const [target] of remove.mock.calls) if (path.resolve(target) === dir) touched.push(`removed ${target}`);
    } finally {
      rename.mockRestore();
      remove.mockRestore();
    }
    expect(touched).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(['.complete', 'theirs']);
    expect(fs.readdirSync(base)).toEqual(['entry']);
  });

  test('placeEntry: an unfinished entry is waited for and left as it is; the temporary directory stays for the caller', () => {
    const { placeEntry } = require('./render');
    const base = fs.mkdtempSync(path.join(work, 'place-recent-'));
    const dir = path.join(base, 'entry');
    fs.mkdirSync(path.join(dir, 'deep', 'down'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep', 'down', 'filling'), 'x'); // an older release filling the entry in place
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'ours'), 'y');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(placeEntry(tmp, dir, () => false, { delayMs: 0, waitMs: 50 })).toBe('uncached');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(fs.readdirSync(path.join(dir, 'deep', 'down'))).toEqual(['filling']);
    expect(fs.readdirSync(base).sort()).toEqual(['entry', 'tmp']);
  });

  // The copy a run could not cache is its own and is removed when the process ends. Each run is a new process, so
  // an entry with a future time goes through placeEntry too (3.7.2 U5, 3.7.1 C3-M1: the same process reused its copy).
  test('a package this run could not cache is removed when the process ends, whatever the time of the unfinished entry', () => {
    const times = [new Date(Date.now() - 10 * 60 * 1000), new Date(Date.now() + 10 * 60 * 1000)];
    times.forEach((when, i) => {
      const cache = freshCache(`uncached-exit-${i}`);
      const entry = path.join(cache, 'packages', VERSION);
      fs.mkdirSync(path.join(entry, 'package'), { recursive: true }); // unfinished: no .complete
      fs.utimesSync(entry, when, when);
      const script = [
        `const render = require(${JSON.stringify(path.join(__dirname, 'render.js'))});`,
        `const root = render.fetchPackage(${JSON.stringify(VERSION)}, { retries: 1, delayMs: 0, waitMs: 50, npm: { file: process.execPath, pre: [${JSON.stringify(fakeNpm)}], shell: false } });`,
        'process.stdout.write(root);',
      ].join('\n');
      const r = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, AI_DEV_HELM_CACHE_DIR: path.dirname(cache) } });
      expect(r.status, `${when.toISOString()}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/\.tmp-/);
      expect(r.stderr).toMatch(/is unfinished/);
      expect(fs.existsSync(r.stdout)).toBe(false);
      expect(fs.readdirSync(path.join(cache, 'packages'))).toEqual([VERSION]);
      expect(fs.readdirSync(entry)).toEqual(['package']);
    });
  });

  // 3.7.2 (U5, 3.7.1 C3-M1): placeEntry itself, with the unfinished entry's time in the future.
  test('placeEntry: an unfinished entry whose time is in the future is waited for and left as it is', () => {
    const { placeEntry } = require('./render');
    const base = fs.mkdtempSync(path.join(work, 'place-future-'));
    const dir = path.join(base, 'entry');
    fs.mkdirSync(path.join(dir, 'package'), { recursive: true });
    const future = new Date(Date.now() + 10 * 60 * 1000);
    fs.utimesSync(dir, future, future);
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'ours'), 'y');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(placeEntry(tmp, dir, () => false, { delayMs: 0, waitMs: 50 })).toBe('uncached');
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/is unfinished/);
    } finally {
      warn.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual(['package']);
    expect(fs.readdirSync(tmp)).toEqual(['ours']);
    // Completed later (in the future too): used, the own copy dropped.
    expect(placeEntry(tmp, dir, () => true, { delayMs: 0 })).toBe('reused');
    expect(fs.existsSync(tmp)).toBe(false);
  });

  // 3.7.2 (U5, 3.7.1 C3-M2): POSIX rename replaces an empty directory. Nothing is renamed onto an entry that is there,
  // even an empty one (no run creates one where this release keeps its entries - see the test of the older releases).
  test('placeEntry: nothing is renamed onto an entry that is there, even an empty one; it is waited for', () => {
    const { placeEntry } = require('./render');
    const base = fs.mkdtempSync(path.join(work, 'place-empty-'));
    const dir = path.join(base, 'entry');
    fs.mkdirSync(dir); // an empty entry
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'ours'), 'y');
    const rename = vi.spyOn(fs, 'renameSync');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(placeEntry(tmp, dir, () => false, { delayMs: 0, waitMs: 50 })).toBe('uncached');
      expect(rename.mock.calls.filter(([, to]) => path.resolve(to) === path.resolve(dir))).toEqual([]);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/is unfinished/);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(fs.readdirSync(tmp)).toEqual(['ours']);
      // Completed while this run waits: used as it is.
      let looks = 0;
      expect(placeEntry(tmp, dir, () => { looks += 1; return looks > 2; }, { delayMs: 0, waitMs: 5000 })).toBe('reused');
      expect(rename.mock.calls.filter(([, to]) => path.resolve(to) === path.resolve(dir))).toEqual([]);
    } finally {
      rename.mockRestore();
      warn.mockRestore();
    }
    expect(fs.existsSync(tmp)).toBe(false);
  });

  // 3.7.2 (U5, 3.7.1 C3-M2): this release's entries are apart from the older releases' (the cache's top level), where
  // 3.7.0 created an entry and filled it in place and 3.7.1 renamed onto an empty one. An older release's entry, empty
  // or unfinished or complete, is neither used nor touched, and no run of an older release can create or replace one of
  // this release's entries.
  test('entries of older releases in the top level of the cache are neither used nor touched', () => {
    const cache = freshCache('older-releases');
    const older = path.dirname(cache);
    const emptyEntry = path.join(older, 'packages', VERSION);
    fs.mkdirSync(emptyEntry, { recursive: true }); // just created by 3.7.0, about to be filled in place
    const completeEntry = path.join(older, `${VERSION}-0123456789abcdef`);
    fs.mkdirSync(path.join(completeEntry, 'tree'), { recursive: true });
    fs.writeFileSync(path.join(completeEntry, '.complete'), '');
    const rename = vi.spyOn(fs, 'renameSync');
    let root;
    try {
      root = fetch();
    } finally {
      rename.mockRestore();
    }
    expect(root).toBe(path.join(cache, 'packages', VERSION, 'package'));
    expect(rename.mock.calls.filter(([, to]) => path.resolve(to).startsWith(`${path.join(older, 'packages')}${path.sep}`))).toEqual([]);
    expect(fs.readdirSync(emptyEntry)).toEqual([]);
    expect(fs.readdirSync(completeEntry).sort()).toEqual(['.complete', 'tree']);
    expect(fs.readdirSync(older).sort()).toEqual([`${VERSION}-0123456789abcdef`, 'packages', 'placed']);
  });

  // renderVersion sweeps the render cache's own stale temporary directories before it builds its own - those in
  // PLACED only. The cache's top level (the older releases', and other tools' where AI_DEV_HELM_CACHE_DIR points at a
  // shared directory) is not swept, whatever the names there (cycles 9 and 10 of the 3.7.2 quality-check).
  test('renderVersion removes the stale temporary directories of the render cache; recent ones and the top level stay', () => {
    const { renderVersion, packageVersion } = require('./render');
    const root = path.resolve(__dirname, '..');
    const cache = freshCache('render-version-stale');
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const stale = path.join(cache, '.tmp-0.0.1-0123456789abcdef-stopd1');
    const recent = path.join(cache, '.tmp-0.0.1-0123456789abcdef-runng1');
    // An older release's (3.7.1), in the top level of the cache: left for the hand (harness-upgrade.md).
    const olderStale = path.join(path.dirname(cache), '.tmp-0.0.1-base-0123456789ab-0123456789abcdef-stopd2');
    const olderRecent = path.join(path.dirname(cache), '.tmp-0.0.1-0123456789abcdef-runng2');
    // Another tool's, where AI_DEV_HELM_CACHE_DIR points at a directory it shares - named like the harness's too
    // (cycle 10: `.tmp-<x.y.z>-<anything>-<6 characters>`).
    const otherTool = path.join(path.dirname(cache), '.tmp-othertool-session');
    const otherLookalike = path.join(path.dirname(cache), '.tmp-2.1.0-build-a1b2c3');
    const otherInPackages = path.join(path.dirname(cache), 'packages', '.tmp-18.20.4-node-gyp-x9Y8z7');
    for (const dir of [stale, recent, olderStale, olderRecent, otherTool, otherLookalike, otherInPackages]) fs.mkdirSync(path.join(dir, 'tree'), { recursive: true });
    for (const dir of [stale, olderStale, otherTool, otherLookalike, otherInPackages]) fs.utimesSync(dir, old, old);
    const version = packageVersion(root);
    const files = renderVersion(version, { projectName: 'render-version-stale', tools: ['claude-code'], stacks: [] }, { baseDir: root });
    expect(files.size).toBeGreaterThan(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(olderStale)).toBe(true);
    expect(fs.existsSync(olderRecent)).toBe(true);
    expect(fs.existsSync(otherTool)).toBe(true);
    expect(fs.existsSync(otherLookalike)).toBe(true);
    expect(fs.existsSync(otherInPackages)).toBe(true);
    expect(fs.readdirSync(cache).some((name) => name.startsWith(`${version}-base-`))).toBe(true);
  }, 240000);

  // 3.7.2 (U5, 3.7.1 C3-M3): a run stopped by Ctrl+C or a kill leaves its temporary directory; a later run removes
  // the ones older than a day. Entries, recent temporary directories and anything else stay.
  test('a temporary directory older than a day is removed by a later download; entries and recent ones stay', () => {
    const { dropStaleTemporaries } = require('./render');
    const cache = freshCache('stale');
    const packages = path.join(cache, 'packages');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const make = (rel, when) => {
      const full = path.join(packages, rel);
      fs.mkdirSync(path.join(full, 'package'), { recursive: true });
      fs.writeFileSync(path.join(full, 'package', 'package.json'), '{}');
      if (when) fs.utimesSync(full, when, when);
      return full;
    };
    make(`.tmp-${VERSION}-stopd1`, old);
    make(`.tmp-${VERSION}-runng1`);
    make('.tmp-stopped-by-hand', old); // in PLACED every `.tmp-` directory is a run's of the harness: removed too
    make('9.9.0', old); // an entry, however old
    fs.writeFileSync(path.join(packages, '.tmp-note'), 'not a directory');
    fs.utimesSync(path.join(packages, '.tmp-note'), old, old);
    // An older release's (3.7.1) temporary directories, in the cache's top level, are not swept (left for the hand).
    const olderPackages = path.join(path.dirname(cache), 'packages');
    for (const name of [`.tmp-${VERSION}-stopd2`, `.tmp-${VERSION}-runng2`, '9.8.0']) fs.mkdirSync(path.join(olderPackages, name, 'package'), { recursive: true });
    for (const name of [`.tmp-${VERSION}-stopd2`, '9.8.0']) fs.utimesSync(path.join(olderPackages, name), old, old);
    fetch();
    expect(fs.readdirSync(packages).sort()).toEqual([`.tmp-${VERSION}-runng1`, '.tmp-note', '9.9.0', VERSION].sort());
    expect(fs.readdirSync(olderPackages).sort()).toEqual([`.tmp-${VERSION}-runng2`, `.tmp-${VERSION}-stopd2`, '9.8.0'].sort());
    // The render cache's own temporary directories (renderVersion) are swept the same way.
    const stale = path.join(cache, '.tmp-9.9.0-0123456789abcdef-stopd3');
    const recent = path.join(cache, '.tmp-9.9.0-0123456789abcdef-runng3');
    for (const dir of [stale, recent]) fs.mkdirSync(path.join(dir, 'tree'), { recursive: true });
    fs.utimesSync(stale, old, old);
    dropStaleTemporaries(cache);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(packages)).toBe(true);
    // A later moment: the recent one is a day old then.
    dropStaleTemporaries(cache, { now: Date.now() + 2 * 24 * 60 * 60 * 1000 });
    expect(fs.existsSync(recent)).toBe(false);
    expect(fs.existsSync(packages)).toBe(true);
    expect(fs.existsSync(path.join(olderPackages, `.tmp-${VERSION}-runng2`))).toBe(true);
    // Only PLACED is swept: any other directory is refused, before anything is read there.
    expect(() => dropStaleTemporaries(path.dirname(cache))).toThrow(/placed directory only/);
    expect(() => dropStaleTemporaries(olderPackages)).toThrow(/placed directory only/);
    expect(fs.readdirSync(olderPackages).sort()).toEqual([`.tmp-${VERSION}-runng2`, `.tmp-${VERSION}-stopd2`, '9.8.0'].sort());
  });
});

// 3.7.2 quality-check, cycle 8: a release's CLI and the scratch repository of `render --out` get no git location
// variables. The fake 3.5.0 release records what its CLI saw; a real older release would run its own git with them.
describe('render: no git location variables reach a scratch render (3.7.2 C7-P1)', () => {
  const { spawnSync } = require('node:child_process');
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-gitenv-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const withGitDir = (gitDir, fn) => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = gitDir;
    try { return fn(); } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
  };
  const product = () => {
    const repo = path.join(tmp, 'product');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
    return repo;
  };
  const config = { projectName: 'Demo', tools: ['claude-code'], stacks: [], skillScope: 'all' };

  test('the CLI of an older release runs without the git location variables', () => {
    const repo = product();
    const pkg = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@crearize/ai-dev-helm', version: '3.5.0' }));
    fs.writeFileSync(path.join(pkg, 'bin', 'cli.js'), "require('fs').writeFileSync('seen.txt', String(Object.keys(process.env).filter((k) => /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/i.test(k)).length));\n");
    const tree = withGitDir(path.join(repo, '.git'), () => require('./render').renderPackage(pkg, config));
    expect(tree.get('seen.txt').toString()).toBe('0');
    expect(spawnSync('git', ['config', 'core.bare'], { cwd: repo, encoding: 'utf8' }).stdout.trim()).toBe('false');
  });

  test('render --out leaves the repository GIT_DIR points at as it is', () => {
    const repo = product();
    const out = path.join(tmp, 'out');
    withGitDir(path.join(repo, '.git'), () => require('./render').renderToDirectory(config, out));
    expect(fs.existsSync(path.join(out, 'CLAUDE.md'))).toBe(true);
    expect(spawnSync('git', ['config', 'core.bare'], { cwd: repo, encoding: 'utf8' }).stdout.trim()).toBe('false');
  }, 120000);
});
