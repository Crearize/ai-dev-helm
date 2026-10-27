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

function freshCache(name) {
  const cache = path.join(work, name);
  process.env.AI_DEV_HELM_CACHE_DIR = cache;
  return cache;
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

  // The copy a run could not cache is its own and is removed when the process ends.
  test('a package this run could not cache is removed when the process ends', () => {
    const cache = freshCache('uncached-exit');
    const entry = path.join(cache, 'packages', VERSION);
    fs.mkdirSync(path.join(entry, 'package'), { recursive: true }); // unfinished: no .complete
    const script = [
      `const render = require(${JSON.stringify(path.join(__dirname, 'render.js'))});`,
      `const root = render.fetchPackage(${JSON.stringify(VERSION)}, { retries: 1, delayMs: 0, waitMs: 50, npm: { file: process.execPath, pre: [${JSON.stringify(fakeNpm)}], shell: false } });`,
      'process.stdout.write(root);',
    ].join('\n');
    const r = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, AI_DEV_HELM_CACHE_DIR: cache } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\.tmp-/);
    expect(r.stderr).toMatch(/is unfinished/);
    expect(fs.existsSync(r.stdout)).toBe(false);
    expect(fs.readdirSync(path.join(cache, 'packages'))).toEqual([VERSION]);
    expect(fs.readdirSync(entry)).toEqual(['package']);
  });
});
