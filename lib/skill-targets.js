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
  const run = spawnSync('git', ['ls-files', '-z', '--', ...LINK_IGNORES.map((e) => `${e.slice(1)}/`)], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); // rule 2 (utils): the product's repository
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
 * init: the review-budget calls of `files` - the distributed Markdown files this init wrote (absolute paths) - read
 * as `script`. Only those: the product's own files (supplements, seeds it edited, its own skills and documents) are
 * not the harness's to rewrite.
 */
function applyReviewBudgetScript(projectDir, script, files) {
  const changed = [];
  const own = path.join(projectDir, 'documents', 'development', 'project') + path.sep;
  for (const full of new Set(files)) {
    if (!/\.md$/.test(full) || full.startsWith(own)) continue;
    let text;
    try {
      if (!fs.lstatSync(full).isFile()) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    const read = readReviewBudgetCalls(text, script);
    if (read !== text) { fs.writeFileSync(full, read, 'utf8'); changed.push(path.relative(projectDir, full)); }
  }
  return changed;
}

// 3.7.3 (U1): the files of the release that must be executable (git mode 100755 here), as render paths. Kept by hand:
// a package npx unpacks on Windows has no mode to read them from. lib/upgrade.test.js checks the list against
// `git ls-files -s` of the release's files, so a superpowers sync that adds a script fails there until it is listed.
const EXECUTABLE_FILES = [
  'skills/superpowers/brainstorming/scripts/start-server.sh',
  'skills/superpowers/brainstorming/scripts/stop-server.sh',
  'skills/superpowers/subagent-driven-development/scripts/review-package',
  'skills/superpowers/subagent-driven-development/scripts/sdd-repo',
  'skills/superpowers/subagent-driven-development/scripts/sdd-workspace',
  'skills/superpowers/subagent-driven-development/scripts/task-brief',
  'skills/superpowers/systematic-debugging/find-polluter.sh',
  'skills/superpowers/writing-skills/render-graphs.js',
];

module.exports = { EXECUTABLE_FILES, readSkillTargets, targetsOf, isDeclaredTarget, skippedLinkIgnores, trackedLinkDirs, readReviewBudgetCalls, applyReviewBudgetScript, LINK_IGNORES };
