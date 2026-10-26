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
const fetch = (env = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return require('./render').fetchPackage(VERSION, { retries: 1, delayMs: 0, npm: { ...npm, pre: [fakeNpm] } });
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

  test('a complete entry is used without npm; an unfinished one is replaced', () => {
    const cache = freshCache('existing');
    const entry = path.join(cache, 'packages', VERSION);
    fetch();
    fs.writeFileSync(path.join(entry, 'package', 'kept.txt'), 'x');
    expect(fetch({ FAKE_NPM_FAIL: '1' })).toBe(path.join(entry, 'package'));
    expect(fs.existsSync(path.join(entry, 'package', 'kept.txt'))).toBe(true);
    // Unfinished (no .complete) and unchanged for long - a run that stopped midway: moved aside and replaced by a
    // finished one.
    fs.rmSync(path.join(entry, '.complete'));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(entry, old, old);
    expect(fetch()).toBe(path.join(entry, 'package'));
    expect(fs.existsSync(path.join(entry, '.complete'))).toBe(true);
    expect(fs.existsSync(path.join(entry, 'package', 'kept.txt'))).toBe(false);
    expect(leftovers(cache)).toEqual([]);
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

  // The order cycle 1 of the review found: A looks at an old unfinished entry, another run moves it aside and places
  // its complete entry (and uses it), then A moves the place aside - the complete entry must come back, not be removed.
  test('placeEntry: an entry completed by another run between the look and the move is put back', () => {
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
    let looks = 0;
    const isComplete = (d) => {
      const answer = done(d);
      looks += 1;
      if (looks === 1) {
        // Right after A's look: B moves the unfinished entry aside and places its complete one (it is old here too,
        // so A would move it if A trusted its first look).
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'theirs'), 'z');
        fs.writeFileSync(path.join(dir, '.complete'), '');
        fs.utimesSync(dir, old, old);
      }
      return answer;
    };
    expect(placeEntry(tmp, dir, isComplete, { delayMs: 0 })).toBe('reused');
    expect(fs.readdirSync(dir).sort()).toEqual(['.complete', 'theirs']);
    expect(fs.readdirSync(base)).toEqual(['entry']);
  });

  test('placeEntry: a recent unfinished entry is waited for, never moved; a rename that keeps failing gives up', () => {
    const { placeEntry } = require('./render');
    const base = fs.mkdtempSync(path.join(work, 'place-recent-'));
    const dir = path.join(base, 'entry');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'filling'), 'x'); // an older release filling the entry in place
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'ours'), 'y');
    expect(() => placeEntry(tmp, dir, () => false, { delayMs: 0, waitMs: 50 })).toThrow(/could not place the render cache entry/);
    expect(fs.readdirSync(dir)).toEqual(['filling']);
    expect(fs.readdirSync(base)).toEqual(['entry']);
  });
});
