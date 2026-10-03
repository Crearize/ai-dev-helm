'use strict';

const fs = require('fs');
const path = require('path');

const TOOL_DIRS = { claude: '.claude', codex: '.codex', cursor: '.cursor' };

// What sits at <runtime>/skills right now. lstat first: a dangling link must
// read as "broken", not as "absent" (stat and existsSync follow the link).
// With expectedSource, a working link that resolves somewhere else (a project
// copied or moved with its junctions, or a pre-move junction) reads as
// 'stale_link'. Anything that is neither a link nor a directory (e.g. a
// committed symlink checked out as a plain file with core.symlinks=false)
// reads as 'not_directory'.
function inspectSkillLink(linkPath, expectedSource) {
  let lst;
  try {
    lst = fs.lstatSync(linkPath);
  } catch {
    return 'missing';
  }
  try {
    fs.statSync(linkPath);
  } catch {
    return 'broken_link';
  }
  if (lst.isSymbolicLink()) {
    if (expectedSource && !sameRealPath(linkPath, expectedSource)) return 'stale_link';
    return 'link';
  }
  return lst.isDirectory() ? 'directory' : 'not_directory';
}

function sameRealPath(a, b) {
  try {
    const ra = fs.realpathSync.native(a);
    const rb = fs.realpathSync.native(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

/**
 * Create <toolDir>/skills -> <projectDir>/skills only when nothing usable is
 * there. Never removes or overwrites a real directory (a copied install) or a
 * working link; a dangling link is replaced (only the link entry is removed).
 * Windows: junction (no admin rights). POSIX: relative symlink.
 * @returns {{status: 'created'|'would_create'|'link'|'directory'|'not_directory'|'no_source'|'failed', path: string, detail?: string}}
 */
function ensureSkillLink({ projectDir, toolDir, dryRun = false }) {
  const source = path.join(projectDir, 'skills');
  const linkPath = path.join(toolDir, 'skills');
  const current = inspectSkillLink(linkPath, source);
  if (current === 'link' || current === 'directory') return { status: current, path: linkPath };
  if (current === 'not_directory') return { status: current, path: linkPath };
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    return { status: 'no_source', path: linkPath, detail: `${source} does not exist` };
  }
  if (dryRun) return { status: 'would_create', path: linkPath, detail: current === 'broken_link' ? 'replaces a dangling link' : current === 'stale_link' ? 'replaces a link that points elsewhere' : undefined };
  try {
    if (current === 'broken_link' || current === 'stale_link') fs.unlinkSync(linkPath);
    fs.mkdirSync(toolDir, { recursive: true });
    if (process.platform === 'win32') fs.symlinkSync(path.resolve(source), linkPath, 'junction');
    else fs.symlinkSync(path.relative(toolDir, source), linkPath);
    return { status: 'created', path: linkPath };
  } catch (err) {
    return { status: 'failed', path: linkPath, detail: err.code || err.message };
  }
}

function resolveTools(projectDir, tools) {
  if (tools && tools.length) {
    const unknown = tools.filter((t) => !TOOL_DIRS[t]);
    if (unknown.length) throw new Error(`unknown tool(s): ${unknown.join(', ')} (use claude, codex, cursor)`);
    return tools;
  }
  // Default: every runtime directory already in the project; Claude Code if none.
  const present = Object.keys(TOOL_DIRS).filter((t) => fs.existsSync(path.join(projectDir, TOOL_DIRS[t])));
  return present.length ? present : ['claude'];
}

const MESSAGES = {
  created: 'created',
  would_create: 'would create',
  link: 'already linked (unchanged)',
  not_directory: 'is neither a link nor a directory (e.g. a symlink checked out as a plain file); not changed, remove it by hand and re-run link-skills',
  directory: 'is a real directory, i.e. a copied install (unchanged; changes to skills/ do not reach it)',
  no_source: 'not linked: skills/ is missing in the project',
  failed: 'FAILED to link',
};

function linkSkills({ dir = process.cwd(), tools, dryRun = false } = {}) {
  const projectDir = fs.realpathSync(path.resolve(dir));
  const results = resolveTools(projectDir, tools).map((tool) => ({
    tool,
    ...ensureSkillLink({ projectDir, toolDir: path.join(projectDir, TOOL_DIRS[tool]), dryRun }),
  }));
  const lines = results.map((r) => `${r.tool}: ${path.relative(projectDir, r.path) || r.path} ${MESSAGES[r.status]}${r.detail ? ` (${r.detail})` : ''}`);
  const exitCode = results.some((r) => r.status === 'failed' || r.status === 'no_source') ? 1 : 0;
  return { results, lines, exitCode };
}

module.exports = { linkSkills, ensureSkillLink, inspectSkillLink, TOOL_DIRS };
