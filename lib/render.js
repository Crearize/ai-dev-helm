'use strict';

// 3.7.0 (C3a/C3b): the distribution a configuration produces, without touching the product. `render` runs the
// package's own `init` non-interactively in an empty scratch repository and collects what it wrote, so `init` and
// `upgrade` share one mapping (a release can never render something `init` would not install). The same entry
// renders an older release for `upgrade`'s comparison base: 3.7.0 and later through `render --config`, 3.6.0 and
// earlier through their `init` with explicit flags, both running on this package's dependencies (NODE_PATH).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_NAME = '@crearize/ai-dev-helm';
const SKILL_FLAGS = { all: 'all', 'superpowers-only': 'superpowers', 'project-only': 'project' };
// What `init` leaves in a scratch repository that is not part of the distribution: the manifest it records, the
// backups it takes of files it rewrote, and the skill links (junctions/symlinks to skills/, which would repeat
// every skill).
const BACKUP_RE = /\.backup\.\d+$/;

function packageVersion(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

const knownStacks = (pkgRoot) => listDirs(path.join(pkgRoot, 'stacks'));
const knownProjectSkills = (pkgRoot) => listDirs(path.join(pkgRoot, 'skills', 'project'))
  .filter((name) => fs.existsSync(path.join(pkgRoot, 'skills', 'project', name, 'SKILL.md')));

/**
 * The configuration both renders of one upgrade use: stacks either release does not know (`custom-*`, a stack
 * added or removed between them) are dropped from both, so neither side loses or gains a stack's files alone
 * (2nd review M-C). A custom skill list keeps only names the release knows (an older `init` stops on an unknown
 * skill name - M-D).
 */
function commonConfig(config, pkgRoots) {
  const stacks = (config.stacks || []).filter((s) => pkgRoots.every((root) => knownStacks(root).includes(s)));
  return { ...config, stacks };
}

function initArgs(pkgRoot, config) {
  const args = ['--project-name', config.projectName, '--tools', (config.tools || []).join(',')];
  const stacks = (config.stacks || []).filter((s) => knownStacks(pkgRoot).includes(s));
  if (stacks.length) args.push('--stacks', stacks.join(','));
  else args.push('--stacks', '');
  if (config.skillScope === 'custom') {
    const known = knownProjectSkills(pkgRoot);
    const list = (config.skills || []).filter((s) => known.includes(s));
    args.push('--skills', list.length ? list.join(',') : 'superpowers');
  } else {
    args.push('--skills', SKILL_FLAGS[config.skillScope] || 'all');
  }
  return args;
}

// node_modules directories that hold this package's runtime dependencies, for an older release that ships none.
function dependencyPath() {
  const own = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const dirs = new Set();
  for (const dep of Object.keys(own.dependencies || {})) {
    try {
      const manifest = require.resolve(`${dep}/package.json`, { paths: [path.join(__dirname, '..')] });
      dirs.add(path.resolve(path.dirname(manifest), ...dep.split('/').map(() => '..')));
    } catch { /* resolved below by the release's own install if it is missing */ }
  }
  return [...dirs].join(path.delimiter);
}

function collectTree(root) {
  const files = new Map();
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (!rel && (entry.name === '.git' || entry.name === '.ai-dev-helm.json')) continue;
      if (BACKUP_RE.test(entry.name)) continue;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full, relPath);
      else if (stat.isFile()) files.set(relPath, fs.readFileSync(full));
    }
  };
  walk(root, '');
  return files;
}

function writeTree(files, outDir) {
  for (const [rel, content] of files) {
    const dest = path.join(outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function scratchRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init failed in ${dir}: ${git.stderr || git.error}`);
  return dir;
}

function runCli(pkgRoot, args, cwd) {
  const env = { ...process.env, NODE_PATH: [dependencyPath(), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  // A Claude Code / Codex session's variables must not steer the scratch render toward the product.
  delete env.CLAUDE_PROJECT_DIR;
  const run = spawnSync(process.execPath, [path.join(pkgRoot, 'bin', 'cli.js'), ...args], {
    cwd, env, encoding: 'utf8', input: '', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    const detail = `${run.stderr || ''}${run.stdout || ''}`.trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`rendering ${PACKAGE_NAME}@${packageVersion(pkgRoot)} failed (${args[0]}, exit ${run.status ?? run.error}):\n${detail}`);
  }
  return run;
}

function versionAtLeast(version, floor) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Render a package tree for `config` ({ projectName, tools, stacks, skillScope, skills }). Returns Map<posix path,
 * Buffer>. 3.7.0 and later go through `render --config` (it reads the manifest-only keys too); older releases
 * through their own `init`.
 */
function renderPackage(pkgRoot, config) {
  // Everything lives inside one private mkdtemp directory (0700): the scratch repository, the config and the output.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-helm-render-'));
  try {
    const repo = path.join(work, 'repo');
    fs.mkdirSync(repo);
    const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
    if (git.status !== 0) throw new Error(`git init failed in ${repo}: ${git.stderr || git.error}`);
    // This package itself always goes through render (its version is the previous release's until the release PR).
    const own = path.resolve(pkgRoot) === path.resolve(__dirname, '..');
    if ((own || versionAtLeast(packageVersion(pkgRoot), '3.7.0')) && fs.existsSync(path.join(pkgRoot, 'lib', 'render.js'))) {
      const configFile = path.join(work, 'config.json');
      fs.writeFileSync(configFile, JSON.stringify(config));
      const out = path.join(work, 'out');
      runCli(pkgRoot, ['render', '--config', configFile, '--out', out], repo);
      return collectTree(out);
    }
    runCli(pkgRoot, ['init', ...initArgs(pkgRoot, config)], repo);
    return collectTree(repo);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** `render --config <file> --out <dir>` (this release): the files `init` would write for the configuration. */
function renderToDirectory(config, outDir) {
  const pkgRoot = path.join(__dirname, '..');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`--out ${outDir} is not empty`);
  const repo = scratchRepo('ai-dev-helm-render-init-');
  // 3.7.0 (C3j/C3g): the manifest-only keys reach init through its --config, from a private directory outside the
  // scratch repository (so the file is not collected).
  const extras = require('./workflow').extrasOf(config);
  const extrasDir = Object.keys(extras).length ? fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dev-helm-render-config-')) : null;
  try {
    const args = initArgs(pkgRoot, config);
    if (extrasDir) {
      const file = path.join(extrasDir, 'config.json');
      fs.writeFileSync(file, JSON.stringify(extras));
      args.push('--config', file);
    }
    runCli(pkgRoot, ['init', ...args], repo);
    const files = collectTree(repo);
    writeTree(files, outDir);
    return files;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    if (extrasDir) fs.rmSync(extrasDir, { recursive: true, force: true });
  }
}

const baseRoot = (baseDir) => (fs.existsSync(path.join(baseDir, 'package', 'package.json')) ? path.join(baseDir, 'package') : baseDir);
// The cache holds code that is run (older releases) and trees that are written into products, so it lives in the
// user's own cache directory - never a shared one such as Linux's /tmp - and is checked before use (3.7.0 cycle 1):
// created 0700, not a link, and on POSIX owned by this user and not writable by others. AI_DEV_HELM_CACHE_DIR moves it
// (tests); the same checks apply.
function cacheRoot() {
  const base = process.env.AI_DEV_HELM_CACHE_DIR
    || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ai-dev-helm', 'render-cache')
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ai-dev-helm', 'render-cache'));
  const root = path.resolve(base);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivate(root);
  return root;
}

function assertPrivate(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`the render cache ${dir} is not a plain directory; remove it or set AI_DEV_HELM_CACHE_DIR`);
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) throw new Error(`the render cache ${dir} belongs to another user; remove it or set AI_DEV_HELM_CACHE_DIR`);
    if (stat.mode & 0o022) throw new Error(`the render cache ${dir} is writable by other users (mode ${(stat.mode & 0o777).toString(8)}); chmod 700 it or set AI_DEV_HELM_CACHE_DIR`);
  }
}

// A cache entry is used only when it is a plain directory this user owns (checked like the root).
function privateEntry(dir) {
  try { assertPrivate(dir); return true; } catch { return false; }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// npm run without a shell: its JavaScript entry through this node (a .cmd shim needs a shell, which concatenates
// arguments unescaped). The plain command remains the fallback where the entry is not found (the version is
// checked against VERSION_RE first, so nothing but a version reaches it).
function npmCommand() {
  const exec = process.env.npm_execpath || '';
  const candidates = [exec, exec.replace(/npx-cli\.js$/, 'npm-cli.js'), path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const cli = candidates.find((c) => c && /npm-cli\.js$/.test(c) && fs.existsSync(c));
  return cli ? { file: process.execPath, pre: [cli], shell: false } : { file: 'npm', pre: [], shell: process.platform === 'win32' };
}

// Run npm. Through a shell (Windows without a resolvable npm-cli.js) every argument is quoted, so a path with spaces
// stays one argument (the command line is built here, not concatenated by Node).
function runNpm(npm, args, options) {
  if (!npm.shell) return spawnSync(npm.file, [...npm.pre, ...args], options);
  const quote = (a) => (/^[A-Za-z0-9_@./:=+-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
  return spawnSync([npm.file, ...npm.pre, ...args].map(quote).join(' '), { ...options, shell: true });
}

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The published package of `version`, unpacked outside the product (OS temp). `npm pack` is retried 3 times; then
 * it stops without writing anything, naming --base-dir. `baseDir` (an unpacked package) skips the download.
 */
function fetchPackage(version, { baseDir, retries = 3, delayMs = 3000, npm = npmCommand() } = {}) {
  if (!VERSION_RE.test(String(version))) throw new Error(`not a release version: ${version}`);
  if (baseDir) {
    const root = baseRoot(baseDir);
    const found = packageVersion(root);
    if (found !== version) throw new Error(`--base-dir holds ${PACKAGE_NAME}@${found}, but the manifest records ${version}`);
    return root;
  }
  const dir = path.join(cacheRoot(), 'packages', version);
  const root = path.join(dir, 'package');
  if (fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(dir, '.complete')) && privateEntry(dir)
    && packageVersion(root) === version) return root;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lastError = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const pack = runNpm(npm, ['pack', `${PACKAGE_NAME}@${version}`, '--pack-destination', dir, '--silent'], {
      encoding: 'utf8', timeout: 120000,
    });
    const tarball = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (pack.status === 0 && tarball) {
      const tar = spawnSync('tar', ['-xzf', tarball], { cwd: dir, encoding: 'utf8' });
      if (tar.status === 0 && fs.existsSync(path.join(root, 'package.json'))) {
        fs.rmSync(path.join(dir, tarball), { force: true });
        installMissingDependencies(root, npm);
        fs.writeFileSync(path.join(dir, '.complete'), '');
        return root;
      }
      lastError = `tar: ${tar.stderr || tar.error}`;
    } else {
      lastError = `${pack.stderr || pack.stdout || pack.error || ''}`.trim();
    }
    if (attempt < retries) sleep(delayMs);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  throw new Error(`could not download ${PACKAGE_NAME}@${version} after ${retries} attempts (${lastError.split(/\r?\n/).pop()}). Nothing was written. Retry when the registry is reachable, or pass --base-dir <an unpacked ${PACKAGE_NAME}@${version} package>.`);
}

// An older release normally runs on this package's dependencies (3.4.3-3.7.0 share yargs ^18 and @iarna/toml).
// One that needs another dependency gets its own install (no scripts run).
function installMissingDependencies(root, npm) {
  const own = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).dependencies || {};
  const theirs = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies || {};
  if (Object.keys(theirs).every((dep) => dep in own)) return;
  const install = runNpm(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], {
    cwd: root, encoding: 'utf8', timeout: 300000,
  });
  if (install.status !== 0) throw new Error(`installing the dependencies of ${root} failed: ${install.stderr || install.error}`);
}

const configKey = (config) => crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);

/**
 * The render of a published release, cached per version and configuration (OS temp), so `--plan`, `upgrade` and
 * `--verify` of one version render it once (C3n "speed").
 */
function renderVersion(version, config, options = {}) {
  // --base-dir is used only for the release it holds (a later --verify may need another one). Its renders are cached
  // apart from the registry's, keyed by its place: an unpacked tree is not known to hold the published content.
  const useBase = Boolean(options.baseDir) && packageVersion(baseRoot(options.baseDir)) === version;
  const origin = useBase ? `-base-${crypto.createHash('sha256').update(path.resolve(baseRoot(options.baseDir))).digest('hex').slice(0, 12)}` : '';
  const dir = path.join(cacheRoot(), `${version}${origin}-${configKey(config)}`);
  if (fs.existsSync(path.join(dir, '.complete')) && privateEntry(dir)) return collectTree(path.join(dir, 'tree'));
  const root = fetchPackage(version, { ...options, baseDir: useBase ? options.baseDir : undefined });
  const files = renderPackage(root, config);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeTree(files, path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, '.complete'), '');
  return files;
}

module.exports = {
  PACKAGE_NAME,
  packageVersion,
  knownStacks,
  knownProjectSkills,
  commonConfig,
  initArgs,
  collectTree,
  writeTree,
  renderPackage,
  renderToDirectory,
  renderVersion,
  fetchPackage,
  versionAtLeast,
};
