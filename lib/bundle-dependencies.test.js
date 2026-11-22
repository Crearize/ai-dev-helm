'use strict';

// 3.8.0 (#248, C4): the runtime dependencies are bundled into the published
// tarball (bundleDependencies), so the transitive versions npx installs are the
// ones in package-lock.json. This builds the real tarball (not --dry-run, whose
// "bundled files: 0" is only a display) into a throwaway folder, lists it and
// runs it offline with an empty cache. It needs the installed dependencies, so
// it is skipped without node_modules. (publish.yml's pack job makes the
// published file and runs the same comparison without any third-party code;
// the script it runs is taken out of the workflow and tested here.)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const installed = Object.keys(pkg.dependencies || {}).every((d) => fs.existsSync(path.join(ROOT, 'node_modules', d, 'package.json')));

// npm is run as node + its CLI file, never through a shell: on Windows a shell (cmd.exe) is the only process a
// timeout stops, and npm itself would stay behind holding the folder open.
const NPM_CLI = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((c) => c && /npm-cli\.js$/.test(c) && fs.existsSync(c));
const npm = (args, cwd, timeout) => spawnSync(process.execPath, [NPM_CLI, '--no-update-notifier', '--no-audit', '--no-fund', ...args], { cwd, encoding: 'utf8', timeout });

// A failed clean-up must not hide the failure of the test itself.
const cleanup = (d) => {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left in the temp folder */ }
};

// The comparison script that publish.yml's pack job writes with a here-document, taken out of the workflow.
function checkBundleScript() {
  const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('check-bundle.js" <<'));
  const end = lines.findIndex((l, n) => n > start && l.trim() === 'EOF');
  const indent = lines[end].length - lines[end].trimStart().length;
  return `${lines.slice(start + 1, end).map((l) => l.slice(indent)).join('\n')}\n`;
}

// Every package of the lock that is not a dev dependency (the root excluded): what has to be inside the tarball.
const expectedKeys = () => Object.entries(lock.packages).filter(([k, v]) => k.startsWith('node_modules/') && !v.dev).map(([k, v]) => [k, v.version]);

describe('bundled runtime dependencies (3.8.0, #248)', () => {
  it('package.json bundles exactly the runtime dependencies, and the lock marks them as bundled', () => {
    expect([...(pkg.bundleDependencies || [])].sort()).toEqual(Object.keys(pkg.dependencies).sort());
    expect(lock.packages[''].bundleDependencies.slice().sort()).toEqual(pkg.bundleDependencies.slice().sort());
    // Break: change bundleDependencies without running `npm install --package-lock-only` (the lock then has no inBundle).
    for (const [k] of expectedKeys()) expect(lock.packages[k].inBundle, k).toBe(true);
  });

  it('the comparison script of the pack job is in the workflow and uses only fs and path', () => {
    // Break: change the here-document of the pack job so that it no longer ends with EOF or loads another module.
    const script = checkBundleScript();
    expect(script).toContain("require('fs')");
    expect(script).toContain('package-lock.json');
    expect(script).not.toMatch(/\bnpm\b|\bnpx\b|require\('(?!fs'|path')/);
  });

  it.skipIf(!installed || !NPM_CLI)('the real tarball holds every non-dev package of the lock and runs offline, and the pack job comparison tells a good one from a broken one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-helm pack ')); // a space in the path on purpose
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-helm work ')); // npm runs here, outside the folder it reads
    try {
      const pack = npm(['pack', '--ignore-scripts', '--pack-destination', dir], ROOT, 120000);
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

      // The comparison script of the pack job: 0 for this tarball, 1 once one transitive dependency is missing.
      const script = path.join(work, 'check-bundle.js');
      fs.writeFileSync(script, checkBundleScript());
      const good = spawnSync(process.execPath, [script, ROOT, path.join(dir, 'unpacked')], { encoding: 'utf8' });
      expect(good.status, `${good.stdout}${good.stderr}`).toBe(0);
      const transitive = [...found.keys()].find((k) => !pkg.bundleDependencies.some((d) => k === `node_modules/${d}`));
      expect(transitive, 'a transitive dependency to remove').toBeDefined();
      fs.rmSync(path.join(base, transitive), { recursive: true, force: true });
      const broken = spawnSync(process.execPath, [script, ROOT, path.join(dir, 'unpacked')], { encoding: 'utf8' });
      expect(broken.status, `${broken.stdout}${broken.stderr}`).toBe(1);
      expect(broken.stdout).toContain(transitive);

      // The tarball runs with nothing but itself: an empty cache, no network.
      fs.mkdirSync(path.join(dir, 'cache'));
      const run = npm(['exec', '--yes', '--offline', '--cache', path.join(dir, 'cache'), `--package=${path.join(dir, name)}`, '--', 'ai-dev-helm', '--version'], work, 150000);
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      expect(run.stdout).toContain(pkg.version);
    } finally {
      cleanup(dir);
      cleanup(work);
    }
  }, 280000);
});
