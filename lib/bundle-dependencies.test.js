'use strict';

// 3.8.0 (#248, C4): the runtime dependencies are bundled into the published
// tarball (bundleDependencies), so the transitive versions npx installs are the
// ones in package-lock.json. This builds the real tarball (not --dry-run, whose
// "bundled files: 0" is only a display) into a throwaway folder and lists it.
// It needs the installed dependencies, so it is skipped without node_modules.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const installed = Object.keys(pkg.dependencies || {}).every((d) => fs.existsSync(path.join(ROOT, 'node_modules', d, 'package.json')));

describe('bundled runtime dependencies (3.8.0, #248)', () => {
  it('package.json bundles exactly the runtime dependencies', () => {
    expect([...(pkg.bundleDependencies || [])].sort()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  it.skipIf(!installed)('the real tarball contains the bundled dependencies, at the versions of package-lock.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-helm-pack-'));
    try {
      const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
      expect(pack.status, pack.stderr).toBe(0);
      const tgz = path.join(dir, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
      expect(fs.existsSync(tgz)).toBe(true);
      // tar runs inside the folder with a bare file name: GNU tar reads "C:\..." as host:file.
      const list = spawnSync('tar', ['-tzf', path.basename(tgz)], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      expect(list.status, list.stderr).toBe(0);
      const files = list.stdout.split(/\r?\n/).filter(Boolean);
      for (const dep of pkg.bundleDependencies) {
        expect(files, dep).toContain(`package/node_modules/${dep}/package.json`);
        const one = spawnSync('tar', ['-xzOf', path.basename(tgz), `package/node_modules/${dep}/package.json`], { cwd: dir, encoding: 'utf8' });
        expect(one.status, one.stderr).toBe(0);
        expect(JSON.parse(one.stdout).version, dep).toBe(lock.packages[`node_modules/${dep}`].version);
      }
      expect(files.some((f) => f.startsWith('package/node_modules/yargs/'))).toBe(true);
      expect(files, 'the CLI itself').toContain('package/bin/cli.js');
      expect(files.filter((f) => /^package\/node_modules\/(vitest|eslint|typescript)\//.test(f)), 'no dev dependency').toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
