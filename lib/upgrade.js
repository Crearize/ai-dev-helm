'use strict';

// 3.7.0 (C3): `ai-dev-helm upgrade` - bring a product from the release its manifest records to this one.
// The comparison base is the old release's own render (lib/render.js), so no per-version move table is kept.
// Every file of the new render ends in one state - up to date, merged with the product's changes, pending (a
// conflict, `<file>.ai-dev-helm-new` beside it), or left out by a declaration with a reason - and anything else is
// "not installed", which fails the run (C3n: an upgrade never leaves a harness file out silently).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const render = require('./render');
const blocks = require('./managed-blocks');
const { setupRuntimeHooks, calledHook, matcherReaches, HANDOFF_FILE, HANDOFF_EVENTS } = require('./runtime-hooks');
const { mergeSettings } = require('./merge-settings');
const { setupCodexRuntime } = require('./codex-runtime');

const PACKAGE_ROOT = path.join(__dirname, '..');
const MANIFEST = '.ai-dev-helm.json';
const NEW_SUFFIX = '.ai-dev-helm-new';

// Files with their own merge (never three-way merged): settings and hook registrations, Codex's config and agents,
// .gitignore. Each is brought up to date by re-applying init's merge for it (C3a).
const SPECIAL_RE = [/^\.claude\/settings\.json$/, /^\.codex\/hooks\.json$/, /^\.codex\/config\.toml$/, /^\.codex\/agents\/[^/]+$/, /^\.gitignore$/];
const HOOK_BODY_RE = /^\.(claude|codex)\/hooks\/([^/]+\.(?:cjs|mjs|js))$/;
// Templates the product writes into from the start: created when missing, never touched afterwards (C3c).
const DEFAULT_SEED = [
  { path: 'documents/development/error-codes.md', reason: 'product error-code table (template)' },
  { path: 'documents/development/naming-conventions.md', reason: 'product naming conventions (template)' },
  { path: 'documents/development/coding-rules/**', reason: 'product coding rules (templates)' },
  { path: 'documents/development/test-recommendation-ledger.md', reason: 'product test-recommendation history' },
];
// The product's supplements to the skills (C3k): the harness never writes there.
const DEFAULT_OWNED = [{ path: 'documents/development/project/**', reason: 'product supplements read by the skills (C3k)' }];
const PARTS = {
  lint: ['lint/**'],
  'review-guides': ['.github/review-*.md'],
  superpowers: ['skills/superpowers/**'],
};

// ---------------------------------------------------------------- small helpers

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isBinary = (buf) => buf.includes(0);
/** Comparable form: BOM removed, CRLF -> LF (binary files compare by their bytes). */
function norm(buf) {
  if (buf === undefined || buf === null) return null;
  if (isBinary(buf)) return `\0binary:${sha(buf)}`;
  return blocks.toLf(buf.toString('utf8'));
}

function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i += 1; if (pattern[i + 1] === '/') i += 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${pattern.endsWith('/') ? '.*' : ''}$`);
}
const matchesAny = (p, patterns) => patterns.some((pattern) => globRe(pattern).test(p));

function quiet(fn) {
  const saved = [console.log, console.warn];
  console.log = () => {};
  console.warn = () => {};
  try { return fn(); } finally { [console.log, console.warn] = saved; }
}

function readFileOrNull(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

/** Write LF `text` to `file` in the line endings and BOM of `like` (the file it replaces), or as rendered. */
function writeLike(file, text, like) {
  let out = text;
  if (like && !isBinary(like)) {
    const raw = like.toString('utf8');
    if (raw.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n');
    if (raw.startsWith('﻿')) out = `﻿${out}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** git merge-file of LF texts: { clean, text }. */
function merge3(base, ours, theirs) {
  const dir = tmpDir('ai-dev-helm-merge-');
  try {
    const files = { ours: path.join(dir, 'ours'), base: path.join(dir, 'base'), theirs: path.join(dir, 'theirs') };
    fs.writeFileSync(files.ours, ours);
    fs.writeFileSync(files.base, base);
    fs.writeFileSync(files.theirs, theirs);
    const run = spawnSync('git', ['merge-file', '-p', '-L', 'product', '-L', 'old release', '-L', 'new release', files.ours, files.base, files.theirs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status === null || run.status < 0 || run.status > 127) throw new Error(`git merge-file failed: ${run.stderr || run.error}`);
    return { clean: run.status === 0, text: run.stdout };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Unified diff of two LF texts (for the record of declared-out files the release changed). */
function unifiedDiff(label, before, after) {
  const dir = tmpDir('ai-dev-helm-diff-');
  try {
    fs.writeFileSync(path.join(dir, 'a'), before || '');
    fs.writeFileSync(path.join(dir, 'b'), after || '');
    const run = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', 'a', 'b'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return (run.stdout || '').replace(/^diff --git a\/a b\/b\n/m, '').replace(/^--- a\/a$/m, `--- ${label} (old release)`).replace(/^\+\+\+ b\/b$/m, `+++ ${label} (new release)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function trackedFiles(dir) {
  const run = spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(run.status === 0 ? run.stdout.split('\0').filter(Boolean) : []);
}

function backupIfUntracked(file, rel, tracked) {
  if (fs.existsSync(file) && !tracked.has(rel)) fs.copyFileSync(file, `${file}.backup.${new Date().toISOString().replace(/[-:.TZ]/g, '')}`);
}

/** Special files compared as structures: JSON parsed, with permissions.deny / allow as sets (init writes the template's
 * order, the merge sorts - 3.7.0 cycle 1). Anything else by its normalized text. */
function sameSpecial(rel, a, b) {
  if (/\.json$/.test(rel)) {
    const canon = (buf) => {
      try {
        const json = JSON.parse(norm(buf));
        if (json && json.permissions && typeof json.permissions === 'object') {
          for (const key of ['deny', 'allow']) if (Array.isArray(json.permissions[key])) json.permissions[key] = [...json.permissions[key]].sort();
        }
        return JSON.stringify(json);
      } catch { return null; }
    };
    const [x, y] = [canon(a), canon(b)];
    if (x !== null && y !== null) return x === y;
  }
  return norm(a) === norm(b);
}

/** A path from the manifest that is written under the product: relative, POSIX, no "..", not inside .git. */
function insideProject(projectDir, rel) {
  if (typeof rel !== 'string' || !rel || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.git')) return false;
  const full = path.resolve(projectDir, rel);
  return full === projectDir || full.startsWith(projectDir + path.sep);
}

function manifestPathErrors(projectDir, manifest) {
  const errors = [];
  const targets = manifest.skillTargets;
  if (targets !== undefined) {
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) errors.push('skillTargets must be an object of arrays');
    else {
      for (const [tree, list] of Object.entries(targets)) {
        if (!Array.isArray(list)) { errors.push(`skillTargets.${tree} must be an array`); continue; }
        for (const t of list) if (!insideProject(projectDir, String(t).replace(/\/$/, ''))) errors.push(`skillTargets.${tree}: "${t}" is not a relative path inside the product`);
      }
    }
  }
  for (const p of Array.isArray(manifest.pending) ? manifest.pending : []) {
    if (!p || !insideProject(projectDir, p.path)) errors.push(`pending: "${p && p.path}" is not a relative path inside the product`);
  }
  return errors;
}

// ---------------------------------------------------------------- manifest and configuration

function readManifest(dir) {
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`${MANIFEST} not found in ${dir}: the harness is not installed there. Run \`npx @crearize/ai-dev-helm init\` first.`);
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('the root is not an object');
    return manifest;
  } catch (error) {
    throw new Error(`${file} could not be read: ${error.message}`);
  }
}

const TOOL_FILES = { 'claude-code': 'CLAUDE.md', codex: 'AGENTS.md', cursor: '.cursorrules' };

/**
 * The configuration to render (C3c): the manifest's values, overridden by arguments. A manifest written before
 * 3.7.0 has no projectName or skill list; they are inferred (CLAUDE.md's title or the directory name; the skills
 * found in the product) and reported in the plan.
 */
function resolveConfig(dir, manifest, overrides = {}) {
  const inferred = [];
  const config = {
    tools: overrides.tools || manifest.tools || ['claude-code'],
    stacks: overrides.stacks || manifest.stacks || [],
    skillScope: overrides.skillScope || manifest.skillScope || 'all',
  };
  let projectName = overrides.projectName || manifest.projectName;
  if (!projectName) {
    for (const file of Object.values(TOOL_FILES)) {
      const text = readFileOrNull(path.join(dir, file));
      const title = text && /^# (.+?) - (?:Claude Code Development Guide|Codex Development Guide|Cursor Development Rules)\s*$/m.exec(text.toString('utf8'));
      if (title) { projectName = title[1].trim(); break; }
    }
    if (!projectName) projectName = path.basename(path.resolve(dir));
    inferred.push(`projectName: "${projectName}" (inferred; record it in ${MANIFEST})`);
  }
  config.projectName = projectName;
  if (config.skillScope === 'custom') {
    let skills = overrides.skills || manifest.skills;
    if (!skills) {
      const roots = [path.join(dir, 'skills', 'project'), ...(((manifest.skillTargets || {}).project) || []).map((t) => path.join(dir, t))];
      skills = [...new Set(roots.flatMap((root) => {
        try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md'))).map((e) => e.name); } catch { return []; }
      }))].sort();
      inferred.push(`skills: ${skills.join(', ') || '(none)'} (inferred from the product's skills; record them in ${MANIFEST})`);
    }
    config.skills = skills;
  }
  return { config, inferred };
}

function declarationErrors(manifest) {
  const errors = [];
  for (const key of ['exclude', 'owned', 'seed']) {
    const list = manifest[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { errors.push(`${key} must be an array`); continue; }
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object') errors.push(`${key}[${i}] must be an object with a reason`);
      else if (typeof item.reason !== 'string' || !item.reason.trim()) errors.push(`${key}[${i}] has no reason (every declaration needs one - C3n)`);
      else if (key === 'exclude' ? !(typeof item.part === 'string' || typeof item.path === 'string') : typeof item.path !== 'string') {
        errors.push(`${key}[${i}] needs ${key === 'exclude' ? '"part" or "path"' : '"path"'}`);
      }
    });
  }
  return errors;
}

// ---------------------------------------------------------------- render, translated to the product's layout

/**
 * skillTargets (C3f): `skills/<tree>/...` of a render goes to each of the tree's targets, and the documents'
 * references to `skills/<tree>/` follow the first target, so the move is not a conflict on every upgrade.
 * Returns Map<path, { buf, origin }>.
 */
function layout(files, skillTargets) {
  const out = new Map();
  const targets = skillTargets && typeof skillTargets === 'object' ? skillTargets : {};
  const rewrite = (buf) => {
    if (!Object.keys(targets).length || isBinary(buf)) return buf;
    let text = buf.toString('utf8');
    for (const [tree, list] of Object.entries(targets)) {
      if (Array.isArray(list) && list.length) text = text.split(`skills/${tree}/`).join(`${list[0].replace(/\/$/, '')}/`);
    }
    return Buffer.from(text, 'utf8');
  };
  for (const [rel, buf] of files) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(rel);
    const list = m && Array.isArray(targets[m[1]]) && targets[m[1]].length ? targets[m[1]] : null;
    if (list) for (const target of list) out.set(`${target.replace(/\/$/, '')}/${m[2]}`, { buf: rewrite(buf), origin: rel });
    else out.set(rel, { buf: rewrite(buf), origin: rel });
  }
  return out;
}

function excludePatterns(manifest, knownSkills) {
  const patterns = [];
  for (const item of manifest.exclude || []) {
    if (typeof item.path === 'string') patterns.push({ pattern: item.path, origin: false, reason: item.reason });
    if (typeof item.part === 'string') {
      const list = PARTS[item.part] || (knownSkills.includes(item.part) ? [`skills/project/${item.part}/**`] : null);
      if (!list) throw new Error(`exclude: unknown part "${item.part}" (known: ${[...Object.keys(PARTS), ...knownSkills].join(', ')})`);
      for (const pattern of list) patterns.push({ pattern, origin: true, reason: item.reason });
    }
  }
  return patterns;
}

// ---------------------------------------------------------------- the run

/**
 * mode: 'apply' (upgrade), 'plan' (--plan: write nothing), 'verify' (--verify: classify only).
 * Returns { exitCode, lines, record }.
 */
function runUpgrade({ dir = process.cwd(), mode = 'apply', baseDir, recordPath, resolve, overrides = {}, fetchOptions = {} } = {}) {
  const projectDir = path.resolve(dir);
  const manifest = readManifest(projectDir);
  const lines = [];
  if (resolve) {
    if (mode !== 'apply') throw new Error('--resolve cannot be combined with --plan or --verify (it writes the manifest)');
    return resolvePending(projectDir, manifest, resolve);
  }

  const errors = declarationErrors(manifest);
  if (errors.length) throw new Error(`${MANIFEST}: ${errors.join('; ')}`);
  const newVersion = render.packageVersion(PACKAGE_ROOT);
  const oldVersion = typeof manifest.version === 'string' ? manifest.version : null;
  if (!oldVersion) throw new Error(`${MANIFEST} records no version; run init --force once to record one`);
  // An older release never "upgrades" a newer install back (3.7.0 cycle 1).
  if (!render.versionAtLeast(newVersion, oldVersion)) {
    throw new Error(`this is @crearize/ai-dev-helm@${newVersion}, older than the ${oldVersion} recorded in ${MANIFEST}; run npx -y @crearize/ai-dev-helm@<${oldVersion} or later> upgrade`);
  }
  const pathErrors = manifestPathErrors(projectDir, manifest);
  if (pathErrors.length) throw new Error(`${MANIFEST}: ${pathErrors.join('; ')}`);
  const { config, inferred } = resolveConfig(projectDir, manifest, overrides);

  // Releases are rendered once per run (and the published ones once per version and configuration - render cache).
  const renders = new Map();
  const oldRoot = oldVersion === newVersion ? PACKAGE_ROOT : render.fetchPackage(oldVersion, { baseDir, ...fetchOptions });
  const common = render.commonConfig(config, [PACKAGE_ROOT, oldRoot]);
  const renderOf = (version) => {
    if (!renders.has(version)) {
      const files = version === newVersion ? render.renderPackage(PACKAGE_ROOT, common)
        : render.renderVersion(version, common, { baseDir, ...fetchOptions });
      renders.set(version, layout(files, manifest.skillTargets));
    }
    return renders.get(version);
  };
  const next = renderOf(newVersion);
  const old = renderOf(oldVersion);
  // "merged" is judged against the release the product's copy came from: the recorded version while the product has
  // not been upgraded to this release, else the release the last upgrade came from (3.7.0 cycle 1).
  const fromVersion = oldVersion !== newVersion ? oldVersion : (manifest.upgradedFrom && manifest.upgradedFrom !== newVersion ? manifest.upgradedFrom : newVersion);
  const verifyBaseVersion = fromVersion;

  const knownSkills = render.knownProjectSkills(PACKAGE_ROOT);
  const excludes = excludePatterns(manifest, knownSkills);
  const owned = [...DEFAULT_OWNED, ...(manifest.owned || [])];
  const seed = [...DEFAULT_SEED, ...(manifest.seed || [])];
  const pendingList = Array.isArray(manifest.pending) ? manifest.pending.filter((p) => p && typeof p.path === 'string') : [];
  const pendingOf = (rel, block) => pendingList.find((p) => p.path === rel && (p.block || null) === (block || null));

  // owned / seed may not take a harness rule file (C3n): only templates the product fills (the default seeds) and
  // paths the release does not ship.
  const defaultSeedPatterns = DEFAULT_SEED.map((s) => s.path);
  const ruleFile = (rel) => !matchesAny(rel, defaultSeedPatterns) && !blocks.ROOT_RULE_FILES.includes(rel) ? true : blocks.ROOT_RULE_FILES.includes(rel);
  const declErrors = [];
  // Root rule files keep only their managed blocks and the special files have their own merge: a declaration over
  // them would be accepted and not honored, so it is refused (3.7.0 cycle 1).
  const undeclarable = [MANIFEST, ...blocks.ROOT_RULE_FILES, '.claude/settings.json', '.codex/hooks.json', '.codex/config.toml', '.gitignore'];
  for (const [key, list] of [['exclude', (manifest.exclude || []).filter((i) => typeof i.path === 'string')], ['owned', manifest.owned || []], ['seed', manifest.seed || []]]) {
    for (const item of list) {
      const hits = undeclarable.filter((rel) => globRe(item.path).test(rel));
      if (hits.length) declErrors.push(`${key} "${item.path}" covers ${hits.join(', ')}, which cannot be declared (root rule files keep only their managed blocks - put product text outside them; settings and hook registrations have their own merge)`);
    }
  }
  for (const [key, list] of [['owned', manifest.owned || []], ['seed', manifest.seed || []]]) {
    for (const item of list) {
      const hits = [...next.keys()].filter((rel) => globRe(item.path).test(rel) && ruleFile(rel));
      if (hits.length) declErrors.push(`${key} "${item.path}" covers harness rule files (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', ...' : ''}); put product content in documents/development/project/ or an ai-dev-helm:local block instead, or exclude the part with a reason`);
    }
  }
  if (declErrors.length) throw new Error(`${MANIFEST}: ${declErrors.join('; ')}`);

  const declaredOut = (rel, origin) => {
    const ex = excludes.find((e) => globRe(e.pattern).test(e.origin ? origin : rel));
    if (ex) return { kind: 'exclude', reason: ex.reason };
    const ow = owned.find((o) => globRe(o.path).test(rel));
    if (ow) return { kind: 'owned', reason: ow.reason };
    return null;
  };
  const seedOf = (rel) => seed.find((s) => globRe(s.path).test(rel)) || null;

  const tracked = trackedFiles(projectDir);
  const actions = [];
  const writes = [];
  const deletes = [];
  const newPending = [];
  const declaredChanges = [];
  const note = (action, rel, detail) => actions.push({ action, path: rel, ...(detail ? { detail } : {}) });

  // ---- 1. hook bodies that conflict keep their registrations (body and registration never drift apart).
  const keepHooks = { claude: new Set(), codex: new Set() };
  const all = [...new Set([...old.keys(), ...next.keys()])].sort();
  const isSpecial = (rel) => SPECIAL_RE.some((re) => re.test(rel));

  // ---- 2. files
  const hookBodiesMissing = [];
  for (const rel of all) {
    if (rel === MANIFEST || isSpecial(rel) || blocks.ROOT_RULE_FILES.includes(rel)) continue;
    // A pending file is compared with the release its conflict came from (baseVersion), until it merges cleanly:
    // it is never dropped from pending without its content holding the release's changes (3.7.0 cycle 1).
    const pend = pendingOf(rel);
    const baseVersion = pend && pend.baseVersion ? pend.baseVersion : oldVersion;
    const o = pend && pend.baseVersion && pend.baseVersion !== oldVersion ? renderOf(pend.baseVersion).get(rel) : old.get(rel);
    const n = next.get(rel);
    if (!n && !o) continue;
    const origin = (n || o).origin;
    const file = path.join(projectDir, ...rel.split('/'));
    const aBuf = readFileOrNull(file);
    const [on, nn, an] = [o ? norm(o.buf) : null, n ? norm(n.buf) : null, norm(aBuf)];
    const out = declaredOut(rel, origin);
    if (out) {
      if (on !== nn) declaredChanges.push({ path: rel, ...out, diff: on && nn && !on.startsWith('\0') ? unifiedDiff(rel, on, nn) : `${on === null ? 'added' : nn === null ? 'removed' : 'changed'} in the new release` });
      note(`declared-out (${out.kind})`, rel);
      continue;
    }
    const sd = seedOf(rel);
    if (sd) {
      if (an === null && n) { writes.push({ file, rel, buf: n.buf }); note('seed (created)', rel); }
      else if (on !== nn) declaredChanges.push({ path: rel, kind: 'seed', reason: sd.reason, diff: on && nn ? unifiedDiff(rel, on, nn) : 'changed in the new release' });
      continue;
    }
    const hook = HOOK_BODY_RE.exec(rel);
    if (!n) {
      // Gone from the distribution (removed or moved): removed when the product never changed it.
      if (an === null) continue;
      if (an === on) { deletes.push({ file, rel }); note('removed (gone from the release)', rel); }
      else note('kept (gone from the release, edited by the product)', rel);
      continue;
    }
    if (hook) {
      if (an === null) { hookBodiesMissing.push({ rel, file, n, tool: hook[1], name: hook[2] }); continue; }
      if (an === nn) { note('up to date', rel); continue; }
      if (an === on) { writes.push({ file, rel, buf: n.buf, like: aBuf }); note('replaced', rel); continue; }
      // A hook body is never three-way merged: a hand-edited copy is a conflict, and its registration stays.
      keepHooks[hook[1]].add(hook[2]);
      writes.push({ file: `${file}${NEW_SUFFIX}`, rel: `${rel}${NEW_SUFFIX}`, buf: n.buf, raw: true });
      newPending.push({ path: rel, baseVersion });
      note('conflict (hook body edited; registration left as it is)', rel);
      continue;
    }
    if (an === null) { writes.push({ file, rel, buf: n.buf }); note(o ? 'added (the product had deleted it; exclude it with a reason to keep it out)' : 'added (new in the release)', rel); continue; }
    if (an === nn) { note('up to date', rel); continue; }
    if (on !== null && an === on) { writes.push({ file, rel, buf: n.buf, like: aBuf }); note('replaced', rel); continue; }
    if (on !== null && on === nn) { note('kept (product changes; the release did not change it)', rel); continue; }
    if (an.startsWith('\0') || nn.startsWith('\0')) {
      writes.push({ file: `${file}${NEW_SUFFIX}`, rel: `${rel}${NEW_SUFFIX}`, buf: n.buf, raw: true });
      newPending.push({ path: rel, baseVersion });
      note('conflict (binary)', rel);
      continue;
    }
    const merged = merge3(on === null ? '' : on, an, nn);
    if (merged.clean) { writes.push({ file, rel, text: merged.text, like: aBuf }); note('merged', rel); continue; }
    writes.push({ file: `${file}${NEW_SUFFIX}`, rel: `${rel}${NEW_SUFFIX}`, buf: n.buf, raw: true });
    newPending.push({ path: rel, baseVersion });
    note('conflict', rel);
  }

  // ---- 3. root rule files: only the managed blocks (C3d)
  for (const rel of blocks.ROOT_RULE_FILES) {
    const n = next.get(rel);
    if (!n) continue;
    const file = path.join(projectDir, rel);
    const aBuf = readFileOrNull(file);
    if (aBuf === null) { writes.push({ file, rel, buf: n.buf }); note('added', rel); continue; }
    const o = old.get(rel);
    const nText = norm(n.buf);
    const oText = o ? norm(o.buf) : '';
    let text = norm(aBuf);
    let changed = false;
    for (const name of blocks.BLOCK_NAMES) {
      const nb = blocks.blockOf(rel, name, nText, null);
      if (!nb || !nb.marked) continue;
      const pend = pendingOf(rel, name);
      const blockBaseVersion = pend && pend.baseVersion ? pend.baseVersion : oldVersion;
      const baseFile = blockBaseVersion !== oldVersion ? renderOf(blockBaseVersion).get(rel) : o;
      const ob = blocks.blockOf(rel, name, baseFile ? norm(baseFile.buf) : '', nb.body);
      const ab = blocks.blockOf(rel, name, text, nb.body);
      const unwrapped = ab && !ab.marked;
      if (!ab || (unwrapped && ob && !ob.marked && ab.headings.join('\n') !== ob.headings.join('\n'))
        || (unwrapped && ob && ob.marked)) {
        if (name === 'runtime' && !ab) {
          // The runtime block was always appended at the end (updateRuntimeInstructions); keep doing so.
          text = `${text.trimEnd()}\n\n${blocks.marker(name, 'start')}\n${nb.body}${blocks.marker(name, 'end')}\n`;
          changed = true;
          note(`block ${name} added`, rel);
          continue;
        }
        newPending.push(pend || { path: rel, block: name, baseVersion: blockBaseVersion });
        note(`block ${name} pending (its sections were not found as one run; wrap them in ${blocks.marker(name, 'start')} ... ${blocks.marker(name, 'end')} by hand once, then upgrade --resolve ${rel}#${name})`, rel);
        continue;
      }
      const base = ob ? ob.body : '';
      let body;
      if (ab.body === nb.body) body = nb.body;
      else if (ab.body === base) body = nb.body;
      else if (base === nb.body) body = ab.body;
      else {
        const merged = merge3(base, ab.body, nb.body);
        if (!merged.clean) {
          newPending.push(pend || { path: rel, block: name, baseVersion: blockBaseVersion });
          writes.push({ file: `${file}${NEW_SUFFIX}`, rel: `${rel}${NEW_SUFFIX}`, buf: n.buf, raw: true });
          note(`block ${name} conflict (see ${rel}${NEW_SUFFIX})`, rel);
          continue;
        }
        body = merged.text;
      }
      if (body !== ab.body || unwrapped) {
        text = blocks.replaceBlock(text, name, ab, body);
        changed = true;
        note(`block ${name} ${unwrapped ? 'wrapped and ' : ''}${body === nb.body ? 'updated' : 'merged'}`, rel);
      }
    }
    if (changed) writes.push({ file, rel, text, like: aBuf, backupUntracked: true });
  }

  // ---- 4. files with their own merge, re-applied on a scratch copy (the plan shows them without writing)
  const scratch = tmpDir('ai-dev-helm-upgrade-special-');
  const specialChanges = [];
  const replacedRegistrations = [];
  try {
    const specials = ['.claude/settings.json', '.codex/hooks.json', '.codex/config.toml', '.gitignore'];
    for (const rel of specials) {
      const src = path.join(projectDir, rel);
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true }); fs.copyFileSync(src, path.join(scratch, rel)); }
    }
    if (fs.existsSync(path.join(projectDir, '.codex', 'agents'))) fs.cpSync(path.join(projectDir, '.codex', 'agents'), path.join(scratch, '.codex', 'agents'), { recursive: true });
    applySpecials(scratch, config, next, manifest, keepHooks, replacedRegistrations);
    const scratchFiles = render.collectTree(scratch);
    for (const [rel, buf] of scratchFiles) {
      const before = readFileOrNull(path.join(projectDir, rel));
      if (before === null || !sameSpecial(rel, before, buf)) {
        specialChanges.push(rel);
        writes.push({ file: path.join(projectDir, rel), rel, buf, raw: true, backupUntracked: true });
        note(before === null ? 'added' : 'merged (own merge)', rel);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const command of replacedRegistrations) note('hand-edited registration replaced', '.claude/settings.json', command.slice(0, 120));
  for (const warning of duplicateRisks(projectDir)) note('possible duplicate registration (a product hook on the same tools as the harness gate / review-budget; check it is not a second gate)', warning.file, warning.command.slice(0, 120));

  // ---- 5. hook bodies the product does not have: added only where a registration runs the distributed copy
  const registrations = registrationTargets(projectDir, writes);
  for (const item of hookBodiesMissing) {
    const runsHere = (registrations[item.tool] || []).some((c) => c.dir === item.tool && c.file === item.name);
    if (item.tool === 'claude' && config.tools.includes('claude-code')) {
      writes.push({ file: item.file, rel: item.rel, buf: item.n.buf });
      note('added (hook body)', item.rel);
    } else if (runsHere) {
      writes.push({ file: item.file, rel: item.rel, buf: item.n.buf });
      note('added (hook body)', item.rel);
    } else {
      note('not added (the registrations run another copy; checked by --verify)', item.rel);
    }
  }

  // ---- 6. plan / apply
  const pendingAfter = dedupePending(newPending);
  if (mode === 'apply') {
    for (const w of writes) applyWrite(w, tracked);
    for (const d of deletes) fs.rmSync(d.file, { force: true });
    // A .new left from a resolved conflict is stale.
    for (const rel of new Set(pendingList.map((p) => p.path))) {
      if (!pendingAfter.some((q) => q.path === rel)) fs.rmSync(path.join(projectDir, ...rel.split('/')) + NEW_SUFFIX, { force: true });
    }
  }

  // ---- 7. verify (C3n): after applying, or on its own
  let verdict = null;
  if (mode !== 'plan') {
    const base = renderOf(verifyBaseVersion);
    verdict = verifyInstall({ projectDir, config, manifest, next, base, baseIsNew: verifyBaseVersion === newVersion, declaredOut, seedOf, pending: mode === 'apply' ? pendingAfter : pendingList, keepHooks });
  }

  if (mode === 'apply') {
    writeManifest(projectDir, manifest, {
      version: newVersion,
      upgradedFrom: oldVersion !== newVersion ? oldVersion : manifest.upgradedFrom,
      projectName: config.projectName,
      tools: config.tools,
      stacks: config.stacks,
      skillScope: config.skillScope,
      skills: config.skillScope === 'custom' ? config.skills : manifest.skills,
      pending: pendingAfter,
      complete: verdict.missing.length === 0 && pendingAfter.length === 0,
      next,
    });
  }

  const record = { mode, from: oldVersion, to: newVersion, inferred, actions, declaredChanges, pending: mode === 'verify' ? pendingList : pendingAfter, verdict };
  lines.push(...formatRecord(record));
  if (recordPath) fs.writeFileSync(path.resolve(recordPath), `${formatRecord(record, { markdown: true }).join('\n')}\n`, 'utf8');
  const failed = verdict && (verdict.missing.length > 0 || record.pending.length > 0);
  return { exitCode: failed ? 1 : 0, lines, record };
}

/** One planned write: a backup when asked and untracked, the product's line endings and BOM for text, bytes as they
 * are for binary content (3.7.0 cycle 1: a binary file was written as its comparison key). */
function applyWrite(w, tracked = new Set()) {
  if (w.backupUntracked) backupIfUntracked(w.file, w.rel, tracked);
  if (w.raw || w.buf) {
    if (!w.raw && w.like && !isBinary(w.buf)) writeLike(w.file, norm(w.buf), w.like);
    else { fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, w.buf); }
  } else writeLike(w.file, w.text, w.like);
}

function dedupePending(list) {
  const seen = new Set();
  return list.filter((p) => {
    const key = `${p.path}#${p.block || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Re-apply init's merges for the special files in `dir` (the product, or a scratch copy of it). */
function applySpecials(dir, config, next, manifest, keepHooks, replaced = []) {
  const put = (rel) => {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file) && next.has(rel)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, next.get(rel).buf); return true; }
    return false;
  };
  quiet(() => {
    if (config.tools.includes('claude-code')) {
      const settings = path.join(dir, '.claude', 'settings.json');
      if (!put('.claude/settings.json')) {
        mergeSettings(settings, path.join(PACKAGE_ROOT, 'templates', 'settings.json.template'), { mergeEnv: true, backup: false, mergeDeny: !(manifest.settings && manifest.settings.mergeDeny === false) });
      }
      const report = {};
      setupRuntimeHooks(dir, 'claude', { copyScripts: false, keep: keepHooks.claude, backup: false, report });
      replaced.push(...(report.replaced || []));
    }
    if (config.tools.includes('codex')) {
      put('.codex/hooks.json');
      put('.codex/config.toml');
      setupRuntimeHooks(dir, 'codex', { copyScripts: false, keep: keepHooks.codex, backup: false, preserveCodex: true });
      setupCodexRuntime(dir, { backup: false, rules: false });
    }
    if (next.has('.gitignore')) {
      const { ensureGitignoreEntries } = require('./init');
      ensureGitignoreEntries(dir);
    }
  });
  // Rendered agent files the product lacks (setupCodexRuntime manages their content).
  for (const rel of next.keys()) if (/^\.codex\/agents\//.test(rel)) put(rel);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The hook files the registrations run, per tool, after the pending writes. */
function registrationTargets(projectDir, writes = []) {
  const pendingWrite = (rel) => writes.find((w) => w.rel === rel && (w.buf || w.text));
  const load = (rel) => {
    const w = pendingWrite(rel);
    if (w) { try { return JSON.parse(w.buf ? w.buf.toString('utf8') : w.text); } catch { return null; } }
    return readJson(path.join(projectDir, rel));
  };
  const out = {};
  for (const [tool, rel] of [['claude', '.claude/settings.json'], ['codex', '.codex/hooks.json']]) {
    const json = load(rel);
    out[tool] = [];
    for (const entries of Object.values((json && json.hooks) || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) for (const hook of (entry && Array.isArray(entry.hooks) ? entry.hooks : [])) {
        const called = calledHook(hook && hook.command);
        if (called) out[tool].push(called);
      }
    }
  }
  return out;
}

/**
 * C3e: registrations the harness does not manage that sit where its own do - a PreToolUse matcher reaching Bash or
 * PowerShell, or the review-budget matcher. Judged by the matcher, never by a name (a product gate need not be
 * called "gate"). Reported in the record; nothing is changed.
 */
function duplicateRisks(projectDir) {
  const out = [];
  const reaches = (matcher, tool) => {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
    try { return new RegExp(matcher).test(tool); } catch { return matcher === tool; }
  };
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
    const json = readJson(path.join(projectDir, rel));
    for (const entry of ((json && json.hooks && json.hooks.PreToolUse) || [])) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      const shell = reaches(entry.matcher, 'Bash') || reaches(entry.matcher, 'PowerShell');
      const review = reaches(entry.matcher, 'Agent') || reaches(entry.matcher, 'spawn_agent');
      if (!shell && !review) continue;
      for (const hook of entry.hooks) {
        if (hook && typeof hook.command === 'string' && !calledHook(hook.command)) out.push({ file: rel, command: hook.command });
      }
    }
  }
  return out;
}

/** Registrations of `json` per event that run hook `name` (any harness tool directory), under a matcher that reaches
 * `reach` when given ({ all: [tools] } or { any: [tools] }). */
function countRuns(json, event, name, reach = null) {
  const entries = (json && json.hooks && json.hooks[event]) || [];
  let n = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (reach && reach.all && !reach.all.every((tool) => matcherReaches(entry && entry.matcher, tool))) continue;
    if (reach && reach.any && !reach.any.some((tool) => matcherReaches(entry && entry.matcher, tool))) continue;
    for (const hook of (entry && Array.isArray(entry.hooks) ? entry.hooks : [])) {
      const called = calledHook(hook && hook.command);
      if (called && called.file === name) n += 1;
    }
  }
  return n;
}

/**
 * C3n: classify every file of the new render and every expected registration. Returns
 * { match: [], merged: [], pending: [], declared: [], missing: [{ path, why }] }.
 */
function verifyInstall({ projectDir, config, manifest, next, base, baseIsNew = false, declaredOut, seedOf, pending, keepHooks }) {
  const v = { match: [], merged: [], pending: [], declared: [], missing: [] };
  const isPending = (rel, block) => pending.some((p) => p.path === rel && (p.block || null) === (block || null));
  const registrations = registrationTargets(projectDir);
  for (const [rel, n] of next) {
    if (rel === MANIFEST || SPECIAL_RE.some((re) => re.test(rel)) || blocks.ROOT_RULE_FILES.includes(rel)) continue;
    if (declaredOut(rel, n.origin)) { v.declared.push(rel); continue; }
    const aBuf = readFileOrNull(path.join(projectDir, ...rel.split('/')));
    if (seedOf(rel)) { if (aBuf === null) v.missing.push({ path: rel, why: 'seed file missing' }); else v.declared.push(rel); continue; }
    if (isPending(rel)) { v.pending.push(rel); continue; }
    const nn = norm(n.buf);
    const hook = HOOK_BODY_RE.exec(rel);
    if (aBuf === null) {
      if (hook && !(hook[1] === 'claude' && config.tools.includes('claude-code'))) {
        // Not installed at the distributed place: the registrations must run a copy that matches it.
        const runs = (registrations[hook[1]] || []).filter((c) => c.file === hook[2]);
        const copies = runs.map((c) => readFileOrNull(path.join(projectDir, `.${c.dir}`, 'hooks', c.file)));
        if (runs.length === 0) { v.declared.push(rel); continue; }
        if (copies.every((c) => c !== null && norm(c) === nn)) v.match.push(rel);
        else v.missing.push({ path: rel, why: `the ${hook[1]} registration runs a copy that differs from the release` });
        continue;
      }
      v.missing.push({ path: rel, why: 'missing' });
      continue;
    }
    const an = norm(aBuf);
    if (an === nn) { v.match.push(rel); continue; }
    if (hook) { v.missing.push({ path: rel, why: 'hook body differs from the release' }); continue; }
    // A file the base release did not have is judged from nothing (not from the new release, which would call any
    // content "merged" - 3.7.0 cycle 1).
    const b = base.get(rel);
    const bn = b ? norm(b.buf) : (baseIsNew ? nn : '');
    if (!an.startsWith('\0') && !nn.startsWith('\0')) {
      const merged = merge3(bn, an, nn);
      if (merged.clean && merged.text === an) { v.merged.push(rel); continue; }
    }
    v.missing.push({ path: rel, why: "differs from the release and lacks the release's changes" });
  }
  // Root rule files: each managed block equals the new template's (or holds its changes).
  for (const rel of blocks.ROOT_RULE_FILES) {
    const n = next.get(rel);
    if (!n) continue;
    const aBuf = readFileOrNull(path.join(projectDir, rel));
    if (aBuf === null) { v.missing.push({ path: rel, why: 'missing' }); continue; }
    const nText = norm(n.buf);
    const aText = norm(aBuf);
    const b = base.get(rel);
    const bText = b ? norm(b.buf) : nText;
    let ok = true;
    for (const name of blocks.BLOCK_NAMES) {
      const nb = blocks.blockOf(rel, name, nText, null);
      if (!nb || !nb.marked) continue;
      if (isPending(rel, name)) { v.pending.push(`${rel}#${name}`); ok = false; continue; }
      const found = blocks.findBlocks(aText);
      const ab = found.blocks[name];
      if (!ab) { v.missing.push({ path: `${rel}#${name}`, why: found.malformed.includes(name) ? 'malformed markers' : 'managed block missing' }); ok = false; continue; }
      if (ab.body === nb.body) continue;
      const bb = blocks.blockOf(rel, name, bText, nb.body);
      const merged = merge3(bb ? bb.body : (baseIsNew ? nb.body : ''), ab.body, nb.body);
      if (!(merged.clean && merged.text === ab.body)) { v.missing.push({ path: `${rel}#${name}`, why: "block lacks the release's changes" }); ok = false; }
    }
    if (ok) v.match.push(rel);
  }
  // Files with their own merge: re-applying the merge must change nothing, and each harness hook is registered once.
  const scratch = tmpDir('ai-dev-helm-verify-');
  try {
    for (const rel of ['.claude/settings.json', '.codex/hooks.json', '.codex/config.toml', '.gitignore']) {
      const src = path.join(projectDir, rel);
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true }); fs.copyFileSync(src, path.join(scratch, rel)); }
    }
    if (fs.existsSync(path.join(projectDir, '.codex', 'agents'))) fs.cpSync(path.join(projectDir, '.codex', 'agents'), path.join(scratch, '.codex', 'agents'), { recursive: true });
    applySpecials(scratch, config, next, manifest, keepHooks || { claude: new Set(), codex: new Set() });
    for (const [rel, buf] of render.collectTree(scratch)) {
      const before = readFileOrNull(path.join(projectDir, rel));
      if (before === null) v.missing.push({ path: rel, why: 'missing' });
      else if (!sameSpecial(rel, before, buf)) v.missing.push({ path: rel, why: 'not up to date with the release (re-run upgrade)' });
      else v.match.push(rel);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  // Each harness hook is registered once, under a matcher that reaches the tools it guards (a registration under
  // "NoSuchTool" runs nothing - 3.7.0 cycle 1).
  // The gate must reach every shell tool; review-budget at least one review tool (products name Codex's differently).
  const REVIEW_TOOLS = ['Agent', 'Task', 'spawn_agent', 'followup_task', 'send_message', 'send_input', 'resume_agent', 'SendMessage'];
  const REACH = { claude: { 'quality-gate.cjs': { all: ['Bash', 'PowerShell'] }, 'review-budget.cjs': { any: REVIEW_TOOLS } }, codex: { 'quality-gate.cjs': { all: ['Bash'] }, 'review-budget.cjs': { any: REVIEW_TOOLS } } };
  const expect = (tool, rel, event, name, want) => {
    const json = readJson(path.join(projectDir, rel));
    const got = countRuns(json, event, name);
    const reach = (REACH[tool] || {})[name];
    const reaching = reach && event !== 'PostToolUse' ? countRuns(json, event, name, reach) : got;
    if (got !== want) v.missing.push({ path: `${rel} ${event} ${name}`, why: `registered ${got} time(s), expected ${want}` });
    else if (reaching !== want) v.missing.push({ path: `${rel} ${event} ${name}`, why: `its matcher does not reach ${(reach.all || reach.any).join(reach.all ? ' and ' : ' or ')}` });
  };
  if (config.tools.includes('claude-code')) {
    const keep = (keepHooks && keepHooks.claude) || new Set();
    if (!keep.has('quality-gate.cjs')) expect('claude', '.claude/settings.json', 'PreToolUse', 'quality-gate.cjs', 1);
    if (!keep.has('review-budget.cjs')) {
      expect('claude', '.claude/settings.json', 'PreToolUse', 'review-budget.cjs', 1);
      expect('claude', '.claude/settings.json', 'PostToolUse', 'review-budget.cjs', 1);
    }
    if (!keep.has(HANDOFF_FILE)) for (const { event } of HANDOFF_EVENTS) expect('claude', '.claude/settings.json', event, HANDOFF_FILE, 1);
  }
  if (config.tools.includes('codex')) {
    expect('codex', '.codex/hooks.json', 'PreToolUse', 'quality-gate.cjs', 1);
    expect('codex', '.codex/hooks.json', 'PreToolUse', 'review-budget.cjs', 1);
    expect('codex', '.codex/hooks.json', 'PostToolUse', 'review-budget.cjs', 1);
    for (const called of registrationTargets(projectDir).codex) {
      if (!fs.existsSync(path.join(projectDir, `.${called.dir}`, 'hooks', called.file))) v.missing.push({ path: `.codex/hooks.json -> .${called.dir}/hooks/${called.file}`, why: 'the registration runs a file that does not exist' });
    }
  }
  return v;
}

function writeManifest(projectDir, manifest, { version, upgradedFrom, projectName, tools, stacks, skillScope, skills, pending, complete, next }) {
  // Keys the harness writes are replaced (the configuration this run rendered, so an override sticks); a product's own
  // keys (reviewBudgetScript, source ...) stay (C3c).
  const out = { ...manifest, version, projectName, tools, stacks, skillScope, appliedAt: new Date().toISOString() };
  if (upgradedFrom) out.upgradedFrom = upgradedFrom;
  if (skills) out.skills = skills;
  if (pending.length) out.pending = pending; else delete out.pending;
  out.complete = complete;
  if (manifest.files && typeof manifest.files === 'object') {
    const files = {};
    for (const rel of Object.keys(manifest.files).sort()) {
      const n = next.get(rel);
      if (n) files[rel] = sha(norm(n.buf));
    }
    out.files = files;
  }
  fs.writeFileSync(path.join(projectDir, MANIFEST), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function resolvePending(projectDir, manifest, target) {
  const [rel, block] = String(target).replace(/\\/g, '/').split('#');
  if (!insideProject(projectDir, rel)) throw new Error(`${target} is not a relative path inside the product`);
  const list = Array.isArray(manifest.pending) ? manifest.pending : [];
  const hit = list.find((p) => p.path === rel && (p.block || null) === (block || null));
  if (!hit) throw new Error(`${target} is not pending (pending: ${list.map((p) => (p.block ? `${p.path}#${p.block}` : p.path)).join(', ') || 'none'})`);
  if (!block && fs.existsSync(path.join(projectDir, `${rel}${NEW_SUFFIX}`))) {
    throw new Error(`${rel}${NEW_SUFFIX} still exists: merge it into ${rel}, delete it, then resolve again`);
  }
  const rest = list.filter((p) => p !== hit);
  const out = { ...manifest };
  if (rest.length) out.pending = rest; else delete out.pending;
  fs.writeFileSync(path.join(projectDir, MANIFEST), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return { exitCode: 0, lines: [`resolved: ${target} (${rest.length} pending left). Run upgrade --verify to confirm the install.`], record: null };
}

function formatRecord(record, { markdown = false } = {}) {
  const out = [];
  const h = (text) => out.push(markdown ? `\n## ${text}` : `\n${text}`);
  const item = (text) => out.push(markdown ? `- ${text}` : `  ${text}`);
  out.push(markdown ? `# ai-dev-helm upgrade ${record.from} -> ${record.to} (${record.mode})` : `ai-dev-helm upgrade ${record.from} -> ${record.to} (${record.mode})`);
  if (record.inferred.length) { h('Inferred configuration'); record.inferred.forEach(item); }
  const changed = record.actions.filter((a) => !/^(up to date|declared-out)/.test(a.action));
  h(`Changes (${changed.length})`);
  for (const a of changed) item(`${a.action}: ${a.path}${a.detail ? ` - ${a.detail}` : ''}`);
  const declared = record.actions.filter((a) => a.action.startsWith('declared-out'));
  if (declared.length) { h(`Declared out (${declared.length})`); item(`${declared.length} file(s) left out by exclude/owned declarations`); }
  if (record.declaredChanges.length) {
    h(`Changed in the release but left out by a declaration (${record.declaredChanges.length}) - check whether to take them`);
    for (const d of record.declaredChanges) {
      item(`${d.path} (${d.kind}: ${d.reason})`);
      if (markdown && d.diff) out.push('', '```diff', d.diff.trimEnd(), '```', '');
    }
  }
  if (record.pending.length) {
    h(`Pending (${record.pending.length}) - merge each <file>.ai-dev-helm-new, delete it, then upgrade --resolve <path>`);
    for (const p of record.pending) item(p.block ? `${p.path}#${p.block}` : p.path);
  }
  if (record.verdict) {
    const v = record.verdict;
    h(`Verify: ${v.match.length} up to date, ${v.merged.length} merged, ${v.pending.length} pending, ${v.declared.length} declared out, ${v.missing.length} not installed`);
    for (const m of v.missing) item(`NOT INSTALLED: ${m.path} (${m.why})`);
    if (v.merged.length) item(`merged (review these in the update PR): ${v.merged.join(', ')}`);
    out.push(v.missing.length || record.pending.length ? 'upgrade: incomplete (exit 1)' : 'upgrade: complete');
  } else {
    out.push('[plan] nothing was written');
  }
  return out;
}

module.exports = { runUpgrade, resolveConfig, layout, verifyInstall, merge3, globRe, applyWrite, sameSpecial, insideProject, DEFAULT_SEED, DEFAULT_OWNED, SPECIAL_RE };
