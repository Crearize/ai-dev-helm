'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isUtf8 } = require('buffer');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const posix = value => value.split(path.sep).join('/');
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const ROOT_FILES = [
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md',
  '.claude/CLAUDE.md', '.claude/CLAUDE.local.md', '.cursorrules', '.ai-dev-helm.json',
];
const RUNTIMES = ['.claude', '.codex', '.cursor'];
const CONFIG_FILES = ['settings.json', 'settings.local.json', 'config.toml', 'hooks.json'];
const POLICY_FILES = ['quality-policy.md', 'development-policy.md', 'harness-runtime.md'];

function hashes(file) {
  const bytes = fs.readFileSync(file);
  return {
    bytes: bytes.length,
    sha256: sha256(bytes),
    normalized_sha256: isUtf8(bytes) ? sha256(bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')) : null,
  };
}

// Baseline mappings describe distribution layout, not authorship. In particular,
// templates must be rendered/merged before they can be compared meaningfully.
function baselinePaths(relative) {
  if (/^(?:skills\/(?:project|superpowers)\/|templates\/hooks\/|shared\/documents\/)/.test(relative) || /^templates\/[^/]+\.template$/.test(relative)) {
    return { paths: [relative] };
  }
  if (['CLAUDE.md', 'AGENTS.md', '.cursorrules'].includes(relative)) {
    const name = relative === '.cursorrules' ? 'cursorrules' : relative;
    return { rendered: true, paths: [`templates/${name}.template`] };
  }
  const skill = relative.match(/^\.(?:claude|codex|cursor)\/skills\/(.+)$/);
  if (skill) {
    const tail = skill[1];
    return { paths: /^(?:project|superpowers)\//.test(tail) ? [`skills/${tail}`] : [`skills/project/${tail}`, `skills/superpowers/${tail}`] };
  }
  const hook = relative.match(/^\.(?:claude|codex|cursor)\/hooks\/(.+)$/);
  if (hook) return { paths: [`templates/hooks/${hook[1]}`] };
  if (relative.startsWith('documents/development/')) return { paths: [`shared/documents/${relative.slice('documents/development/'.length)}`] };
  return { paths: [] };
}

/** Read selected on-disk files only. No writes, processes, config evaluation,
 * runtime/session transcript reads, or claims about rules actually loaded.
 * baselineDir must be a pristine distribution checkout/package chosen by caller.
 * A version label alone cannot prove that this baseline is authentic or pristine.
 */
function inventoryHarness({ projectDir = process.cwd(), baselineDir } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir));
  if (!fs.statSync(root).isDirectory()) throw new Error('projectDir must be a directory');
  const baselineRoot = baselineDir ? fs.realpathSync(path.resolve(baselineDir)) : null;
  if (baselineRoot && !fs.statSync(baselineRoot).isDirectory()) throw new Error('baselineDir must be a directory');
  const warnings = [];
  const records = new Map();
  let visited = 0;
  function version(file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return typeof value.version === 'string' ? value.version : null;
    } catch (err) {
      if (err.code !== 'ENOENT') warnings.push(`Cannot read version from ${file}: ${err.code || 'invalid JSON'}`);
      return null;
    }
  }
  const recordedVersion = version(path.join(root, '.ai-dev-helm.json'));
  const baselineVersion = baselineRoot ? version(path.join(baselineRoot, 'package.json')) : null;
  let distributorVersion = null;
  let isDistributor = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    isDistributor = pkg.name === '@crearize/ai-dev-helm';
    if (isDistributor && typeof pkg.version === 'string') distributorVersion = pkg.version;
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`Cannot identify distributor package: ${err.code || 'invalid JSON'}`);
  }
  function compare(relative, digest) {
    if (!baselineRoot) return { status: 'baseline_unavailable' };
    const mapping = baselinePaths(relative);
    const candidate = mapping.paths.find(p => fs.existsSync(path.join(baselineRoot, p)) && fs.statSync(path.join(baselineRoot, p)).isFile());
    if (!candidate) return { status: 'no_baseline_file' };
    if (mapping.rendered) return { status: 'rendered_template', path: candidate };
    const original = hashes(path.join(baselineRoot, candidate));
    return {
      status: digest.sha256 === original.sha256 ? 'exact_match' : digest.normalized_sha256 && digest.normalized_sha256 === original.normalized_sha256 ? 'normalized_match' : 'different',
      path: candidate,
      ...original,
    };
  }
  function visit(relative, ancestors = new Set(), depth = 0) {
    if (++visited > 10000) throw new Error('Harness inventory exceeds 10000 entries; narrow installed skill trees before retrying');
    const absolute = path.join(root, relative);
    let real;
    let stat;
    try {
      real = fs.realpathSync(absolute);
      stat = fs.statSync(real);
    } catch (err) {
      if (err.code !== 'ENOENT') warnings.push(`Unreadable ${posix(relative)}: ${err.code}`);
      return;
    }
    if (stat.isDirectory()) {
      if (ancestors.has(identity(real))) { warnings.push(`Skipped directory link cycle: ${posix(relative)}`); return; }
      if (depth > 16) { warnings.push(`Skipped deep directory: ${posix(relative)}`); return; }
      const next = new Set(ancestors).add(identity(real));
      for (const name of fs.readdirSync(real).sort()) {
        if (name === '.git' || name === 'node_modules' || name.startsWith('.env')) continue;
        visit(path.join(relative, name), next, depth + 1);
      }
    } else if (stat.isFile()) {
      const alias = posix(relative);
      const key = identity(real);
      if (records.has(key)) { records.get(key).paths.push(alias); return; }
      const digest = hashes(real);
      records.set(key, { paths: [alias], real_path: real, ...digest, comparison: compare(alias, digest) });
    }
  }
  for (const file of ROOT_FILES) visit(file);
  for (const runtime of RUNTIMES) {
    for (const file of CONFIG_FILES) visit(`${runtime}/${file}`);
    for (const tree of ['skills', 'hooks', 'agents', 'commands', 'prompts', 'rules']) visit(`${runtime}/${tree}`);
  }
  for (const file of POLICY_FILES) visit(`documents/development/${file}`);
  if (isDistributor) {
    for (const tree of ['skills/project', 'skills/superpowers', 'templates/hooks']) visit(tree);
    for (const file of POLICY_FILES) visit(`shared/documents/${file}`);
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'cursorrules']) visit(`templates/${file}.template`);
  }
  return {
    schema_version: 1,
    observation: 'on_disk_inventory',
    project_dir: root,
    recorded_version: recordedVersion,
    distributor_version: distributorVersion,
    baseline: baselineRoot ? {
      directory: baselineRoot,
      version: baselineVersion,
      relationship: recordedVersion && baselineVersion ? recordedVersion === baselineVersion ? 'recorded_version' : 'different_version' : 'unknown',
      provenance: 'caller_supplied_not_verified',
    } : null,
    normalization: 'UTF-8 BOM removal and CRLF/CR to LF only',
    files: [...records.values()].sort((a, b) => a.paths[0].localeCompare(b.paths[0])),
    runtime_metrics: null,
    limitations: [
      'Inventory does not prove these rules were loaded or used by any runtime.',
      'Different files are not automatically local customizations; compare with the exact installed release and inspect distribution history.',
      'External marketplace skills outside installed links and custom hook paths in configuration are not automatically resolved.',
      'Nested directory-specific instructions and ancestor/user-wide rule files are not enumerated; this is a selected project inventory.',
      'Runtime elapsed time, tokens, intervention counts and finding adjudication are unavailable from disk inventory.',
    ],
    warnings,
  };
}

module.exports = { inventoryHarness };
