'use strict';

// 3.8.0 (#248, C4): the runtime dependencies are bundled into the published
// tarball (bundleDependencies), so the transitive versions npx installs are the
// ones in package-lock.json. This builds the real tarball (not --dry-run, whose
// "bundled files: 0" is only a display) into a throwaway folder, lists it and
// runs it offline with an empty cache. It needs the installed dependencies, so
// it is skipped without node_modules. (publish.yml's pack job makes the
// published file and runs the same comparison without any third-party code.)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const installed = Object.keys(pkg.dependencies || {}).every((d) => fs.existsSync(path.join(ROOT, 'node_modules', d, 'package.json')));
const win = process.platform === 'win32';

// Every package of the lock that is not a dev dependency (the root excluded): what has to be inside the tarball.
const expectedKeys = () => Object.entries(lock.packages).filter(([k, v]) => k.startsWith('node_modules/') && !v.dev).map(([k, v]) => [k, v.version]);

describe('bundled runtime dependencies (3.8.0, #248)', () => {
  it('package.json bundles exactly the runtime dependencies, and the lock marks them as bundled', () => {
    expect([...(pkg.bundleDependencies || [])].sort()).toEqual(Object.keys(pkg.dependencies).sort());
    expect(lock.packages[''].bundleDependencies.slice().sort()).toEqual(pkg.bundleDependencies.slice().sort());
    // Break: change bundleDependencies without running `npm install --package-lock-only` (the lock then has no inBundle).
    for (const [k] of expectedKeys()) expect(lock.packages[k].inBundle, k).toBe(true);
  });

  it.skipIf(!installed)('the real tarball holds every non-dev package of the lock, at its version, and runs offline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-helm pack ')); // a space in the path on purpose
    const quote = (x) => (win ? `"${x}"` : x); // the shell of Windows splits an argument at a space
    try {
      const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', quote(dir)], { cwd: ROOT, encoding: 'utf8', shell: win });
      expect(pack.status, pack.stderr).toBe(0);
      const name = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
      // tar runs inside the folder with bare names: GNU tar reads "C:\..." as host:file.
      fs.mkdirSync(path.join(dir, 'unpacked'));
      const untar = spawnSync('tar', ['-xzf', name, '-C', 'unpacked'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      expect(untar.status, untar.stderr).toBe(0);
      const base = path.join(dir, 'unpacked', 'package');
      const found = new Map();
      const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
          if (!e.isDirectory() || e.name === '.bin') continue;
          const r = `${rel}/${e.name}`;
          if (e.name.startsWith('@')) { walk(r); continue; }
          const f = path.join(base, r, 'package.json');
          if (!fs.existsSync(f)) continue;
          found.set(r, JSON.parse(fs.readFileSync(f, 'utf8')).version);
          if (fs.existsSync(path.join(base, r, 'node_modules'))) walk(`${r}/node_modules`);
        }
      };
      walk('node_modules');
      // Break: bundle a different tree than the lock's (a missing transitive dependency, an extra or another version).
      expect([...found].sort()).toEqual(expectedKeys().sort());
      for (const dep of pkg.bundleDependencies) expect(found.has(`node_modules/${dep}`), dep).toBe(true);
      expect(fs.existsSync(path.join(base, 'bin', 'cli.js')), 'the CLI itself').toBe(true);
      // The tarball runs with nothing but itself: an empty cache, no network.
      fs.mkdirSync(path.join(dir, 'cache'));
      const run = spawnSync('npm', ['exec', '--yes', '--offline', '--cache', quote(path.join(dir, 'cache')), quote(`--package=${path.join(dir, name)}`), '--', 'ai-dev-helm', '--version'], { cwd: dir, encoding: 'utf8', shell: win, timeout: 90000 });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      expect(run.stdout).toContain(pkg.version);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});
