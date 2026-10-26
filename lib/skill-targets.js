'use strict';

// 3.7.0 (C3f): the manifest's skillTargets - per skill tree, the directories its skills are copied to
// (e.g. { "project": [".claude/skills"], "superpowers": [".claude/skills/superpowers"] }). A declared target is a
// real directory on purpose: not a stale copy to warn about, and never a link to list in .gitignore.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LINK_IGNORES = ['/.claude/skills', '/.codex/skills', '/.cursor/skills'];

/** The declared target directories of a manifest object. */
function targetsOf(manifest) {
  const targets = manifest && manifest.skillTargets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return [];
  return Object.values(targets).filter(Array.isArray).flat()
    .filter((t) => typeof t === 'string' && t && !t.includes('..'))
    .map((t) => t.replace(/\\/g, '/').replace(/\/+$/, ''));
}

function readSkillTargets(projectDir) {
  try {
    return targetsOf(JSON.parse(fs.readFileSync(path.join(projectDir, '.ai-dev-helm.json'), 'utf8')));
  } catch {
    return [];
  }
}

const holds = (targets, relDir) => {
  const dir = relDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return targets.some((t) => t === dir || t.startsWith(`${dir}/`));
};

/** Whether `relDir` (e.g. ".claude/skills") is a declared target or holds one. */
function isDeclaredTarget(projectDir, relDir) {
  return holds(readSkillTargets(projectDir), relDir);
}

/** 3.7.1 (D6): the link entries whose directory holds files git tracks in `projectDir` (a real, committed copy). */
function trackedLinkDirs(projectDir) {
  const run = spawnSync('git', ['ls-files', '-z', '--', ...LINK_IGNORES.map((e) => `${e.slice(1)}/`)], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return [];
  const files = run.stdout.split('\0').filter(Boolean);
  return LINK_IGNORES.filter((entry) => files.some((f) => f.startsWith(`${entry.slice(1)}/`)));
}

/**
 * The .gitignore link entries that must not be added: their directory holds a declared target, or (3.7.1 D6) files
 * git tracks - ignoring it would hide the files added there later. `trackedIn` is the product directory when the
 * first argument is a manifest (upgrade merges on a scratch copy). Lines already in .gitignore are not removed.
 */
function skippedLinkIgnores(projectDirOrManifest, trackedIn) {
  const isDir = typeof projectDirOrManifest === 'string';
  const targets = isDir ? readSkillTargets(projectDirOrManifest) : targetsOf(projectDirOrManifest);
  const repo = isDir ? projectDirOrManifest : trackedIn;
  const tracked = repo ? trackedLinkDirs(repo) : [];
  return LINK_IGNORES.filter((entry) => holds(targets, entry.slice(1)) || tracked.includes(entry));
}

// 3.7.1 (D6): the distributed documents and skills call the review-budget hook at its distributed place; a product
// that declares its own (reviewBudgetScript) reads them as a call of that file (upgrade's layout and init).
const REVIEW_BUDGET_CALL_RE = /(?<![\w./-])node \.(?:claude|codex)\/hooks\/review-budget\.cjs(?![\w.-])/g;
function readReviewBudgetCalls(text, script) {
  if (typeof text !== 'string' || typeof script !== 'string' || !script) return text;
  return text.replace(REVIEW_BUDGET_CALL_RE, () => `node ${script}`);
}

/**
 * init: the review-budget calls of the Markdown files under `dirs` (relative to the product), read as `script`.
 * The product's own supplements (documents/development/project/) are not the harness's to rewrite.
 */
function applyReviewBudgetScript(projectDir, script, dirs) {
  const changed = [];
  const own = path.join(projectDir, 'documents', 'development', 'project');
  const walk = (abs) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(abs, e.name);
      if (e.isSymbolicLink() || full === own) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.md$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8');
        const read = readReviewBudgetCalls(text, script);
        if (read !== text) { fs.writeFileSync(full, read, 'utf8'); changed.push(path.relative(projectDir, full)); }
      }
    }
  };
  for (const dir of new Set(dirs)) {
    const abs = path.join(projectDir, ...dir.split('/'));
    try { if (fs.lstatSync(abs).isDirectory()) walk(abs); } catch { /* not there */ }
  }
  return changed;
}

module.exports = { readSkillTargets, targetsOf, isDeclaredTarget, skippedLinkIgnores, trackedLinkDirs, readReviewBudgetCalls, applyReviewBudgetScript, LINK_IGNORES };
