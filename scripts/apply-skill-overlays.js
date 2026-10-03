#!/usr/bin/env node
'use strict';
// Applies the harness-owned overlays in scripts/skill-overlays to a transformed
// skills tree.
//
//   node scripts/apply-skill-overlays.js check  <upstream_skills_dir>
//   node scripts/apply-skill-overlays.js apply  <upstream_skills_dir> <dest_dir>
//   node scripts/apply-skill-overlays.js update <upstream_skills_dir> <upstream_version>
//
// manifest.json maps "<skill>/<file>" to the SHA-256 of the upstream file the
// overlay was written against (null for a file upstream does not have). An
// overlay `<skill>/<file>` replaces the file; `<skill>/<file>.prepend` is
// prepended to the upstream file. If the upstream file no longer matches the
// recorded hash, apply fails and names the file: read the upstream change,
// update the overlay, then run `update`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const overlayDir = process.env.HELM_SKILL_OVERLAY_DIR || path.join(__dirname, 'skill-overlays');
const manifestFile = path.join(overlayDir, 'manifest.json');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

function overlayFor(key) {
  if (exists(path.join(overlayDir, key))) return { file: path.join(overlayDir, key), prepend: false };
  if (exists(path.join(overlayDir, `${key}.prepend`))) return { file: path.join(overlayDir, `${key}.prepend`), prepend: true };
  return null;
}

function overlayKeys() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (path.relative(overlayDir, file) !== 'manifest.json' && entry.name !== 'README.md') {
        out.push(path.relative(overlayDir, file).split(path.sep).join('/').replace(/\.prepend$/, ''));
      }
    }
  };
  walk(overlayDir);
  return out.sort();
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const [mode, a, b] = process.argv.slice(2);

if (mode === 'update') {
  const manifest = { upstreamVersion: b, files: {} };
  for (const key of overlayKeys()) {
    const upstream = path.join(a, key);
    manifest.files[key] = exists(upstream) ? sha(upstream) : null;
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated manifest for upstream ${b}: ${Object.keys(manifest.files).length} overlays.`);
} else if (mode === 'check' || mode === 'apply') {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const keys = overlayKeys();
  const unlisted = keys.filter((key) => !(key in manifest.files));
  if (unlisted.length) fail(`Overlay files missing from manifest.json: ${unlisted.join(', ')}`);
  const drifted = [];
  for (const [key, expected] of Object.entries(manifest.files)) {
    const overlay = overlayFor(key);
    if (!overlay) fail(`manifest.json lists ${key} but no overlay file exists`);
    const upstream = path.join(a, key);
    if (expected === null) {
      if (overlay.prepend) fail(`Prepend overlay ${key} needs an upstream file hash`);
      // A harness-owned file: upstream shipping the same name is drift.
      if (exists(upstream)) drifted.push(`${key}: now exists upstream (harness-owned file, overlay based on upstream ${manifest.upstreamVersion})`);
      continue;
    }
    if (!exists(upstream)) drifted.push(`${key}: removed upstream (overlay based on upstream ${manifest.upstreamVersion})`);
    else if (sha(upstream) !== expected) drifted.push(`${key}: changed upstream since ${manifest.upstreamVersion}`);
  }
  if (drifted.length) {
    fail(`Upstream drift in files that harness overlays own (overlays are based on upstream v${manifest.upstreamVersion}). Compare each file between upstream v${manifest.upstreamVersion} and the new release, port what matters into scripts/skill-overlays, then run \`node scripts/apply-skill-overlays.js update <upstream_skills_dir> <version>\`:\n  ${drifted.join('\n  ')}`);
  }
  if (mode === 'check') {
    console.log(`No upstream drift (${Object.keys(manifest.files).length} overlays).`);
    process.exit(0);
  }
  for (const key of Object.keys(manifest.files)) {
    const overlay = overlayFor(key);
    const target = path.join(b, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = fs.readFileSync(overlay.file, 'utf8');
    fs.writeFileSync(target, overlay.prepend ? body + fs.readFileSync(target, 'utf8') : body);
    console.log(`  Applied overlay: ${key}`);
  }
} else {
  fail('usage: apply-skill-overlays.js check <upstream_skills_dir> | apply <upstream_skills_dir> <dest_dir> | update <upstream_skills_dir> <version>');
}
