'use strict';

// 3.7.0 (C3f): the manifest's skillTargets - per skill tree, the directories its skills are copied to
// (e.g. { "project": [".claude/skills"], "superpowers": [".claude/skills/superpowers"] }). A declared target is a
// real directory on purpose: not a stale copy to warn about, and never a link to list in .gitignore.

const fs = require('fs');
const path = require('path');

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

/** The .gitignore link entries that must not be added: their directory holds a declared target. */
function skippedLinkIgnores(projectDirOrManifest) {
  const targets = typeof projectDirOrManifest === 'string' ? readSkillTargets(projectDirOrManifest) : targetsOf(projectDirOrManifest);
  return LINK_IGNORES.filter((entry) => holds(targets, entry.slice(1)));
}

module.exports = { readSkillTargets, targetsOf, isDeclaredTarget, skippedLinkIgnores, LINK_IGNORES };
