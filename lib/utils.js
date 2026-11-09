'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const os = require('os');

/** Root directory of ai-dev-helm package */
const PACKAGE_ROOT = path.resolve(__dirname, '..');

/** Skill scope option indices (maps to promptSelect menu order) */
const SKILL_SCOPE = { ALL: 0, SUPERPOWERS_ONLY: 1, PROJECT_ONLY: 2, CUSTOM: 3 };

/** AI tool identifiers (used as members of selectedTools arrays) */
const TOOL_IDS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
  CODEX: 'codex',
});

/** All supported tool ids in display order */
const ALL_TOOL_IDS = [TOOL_IDS.CLAUDE_CODE, TOOL_IDS.CURSOR, TOOL_IDS.CODEX];

/** Human-readable labels for tool selection prompt */
const TOOL_LABELS = {
  [TOOL_IDS.CLAUDE_CODE]: 'Claude Code',
  [TOOL_IDS.CURSOR]: 'Cursor',
  [TOOL_IDS.CODEX]: 'Codex (OpenAI)',
};

function printHeader() {
  console.log('');
  console.log('ai-dev-helm Setup');
  console.log('=================');
  console.log('');
}

/**
 * Prompt helper that works with both interactive and piped input.
 * Uses a line queue to handle buffered pipe input correctly.
 */
function createPrompter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY || false,
  });

  const lineQueue = [];
  let lineWaiter = null;
  let closed = false;

  rl.on('line', (line) => {
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = null;
      resolve(line.trim());
    } else {
      lineQueue.push(line.trim());
    }
  });

  rl.on('close', () => {
    closed = true;
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = null;
      resolve(null);
    }
  });

  function getLine() {
    return new Promise((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift());
      } else if (closed) {
        resolve(null);
      } else {
        lineWaiter = resolve;
      }
    });
  }

  async function promptInput(prompt) {
    process.stdout.write(prompt);
    const answer = await getLine();
    if (answer === null) {
      console.log('');
      console.log('Input ended. Exiting.');
      process.exit(0);
    }
    return answer;
  }

  async function promptSelect(prompt, options) {
    console.log(prompt);
    options.forEach((opt, i) => {
      console.log(`  ${i + 1}) ${opt}`);
    });

    while (true) {
      const answer = await promptInput('> ');
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= options.length) {
        return num - 1;
      }
      console.log(`Enter a number between 1 and ${options.length}`);
    }
  }

  async function promptMultiple(prompt) {
    const answer = await promptInput(prompt);
    return answer.split(/\s+/).filter(Boolean);
  }

  function close() {
    rl.close();
  }

  return { promptInput, promptSelect, promptMultiple, close };
}

const NEW_SUFFIX = '.ai-dev-helm-new';

/** sha256 of file content, BOM stripped and CRLF normalized (line-ending/BOM-only edits do not count). */
function contentHash(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

function removeStaleNew(destPath, dryRun) {
  const stale = destPath + NEW_SUFFIX;
  if (!dryRun && fs.existsSync(stale)) fs.rmSync(stale, { force: true });
}

/**
 * Copy one file. Two policies:
 * - harness-owned (default): always overwritten; a stale `<file>.ai-dev-helm-new` is removed.
 * - adopter-editable (`options.protect`): never clobbers local edits. Missing dest is
 *   written; identical content is left alone; a dest whose hash equals the hash recorded
 *   at the last init (`options.prior[rel]`, i.e. unedited) is overwritten; anything else
 *   (edited, or no record, e.g. upgrading from 3.2.x) is kept and the new version is
 *   written to `<file>.ai-dev-helm-new` (path pushed to `options.kept`). Hashes of what
 *   the file is known to contain are stored in `options.records` (relative posix path).
 *   Names in `options.ownedNames` are treated as harness-owned even under `protect`.
 * 3.7.1 (D6): the destinations that now hold the distributed content (written, or already equal) are pushed to
 * `options.written` - a kept local edit is not.
 */
function copyFileKeepingLocal(srcPath, destPath, options = {}) {
  const { dryRun = false } = options;
  const owned = !options.protect || (options.ownedNames || []).includes(path.basename(destPath));
  const wrote = () => { if (Array.isArray(options.written)) options.written.push(destPath); };
  if (owned) {
    if (dryRun) return;
    fs.copyFileSync(srcPath, destPath);
    removeStaleNew(destPath, false);
    wrote();
    return;
  }
  const rel = path.relative(options.projectDir || path.dirname(destPath), destPath).split(path.sep).join('/');
  const records = options.records || {};
  const prior = options.prior || {};
  const srcBuf = fs.readFileSync(srcPath);
  const srcHash = contentHash(srcBuf);
  if (!fs.existsSync(destPath)) {
    if (!dryRun) fs.copyFileSync(srcPath, destPath);
    records[rel] = srcHash;
    wrote();
    return;
  }
  const curHash = contentHash(fs.readFileSync(destPath));
  if (curHash === srcHash) {
    records[rel] = srcHash;
    removeStaleNew(destPath, dryRun);
    wrote();
    return;
  }
  if (prior[rel] === curHash) {
    if (!dryRun) fs.copyFileSync(srcPath, destPath);
    records[rel] = srcHash;
    removeStaleNew(destPath, dryRun);
    wrote();
    return;
  }
  if (prior[rel] !== undefined) records[rel] = prior[rel];
  if (!dryRun) fs.writeFileSync(destPath + NEW_SUFFIX, srcBuf);
  if (Array.isArray(options.kept)) options.kept.push(destPath);
}

/** Dry-run helper: evaluate protected files without writing, so `kept` lists the would-be .ai-dev-helm-new files. */
function walkDryRun(src, dest, options, recursive = true) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (recursive) walkDryRun(srcPath, destPath, options);
    } else if (!options.filter || options.filter(srcPath)) {
      copyFileKeepingLocal(srcPath, destPath, options);
    }
  }
}

/**
 * Recursively copy a directory. Cleans up on failure.
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, log actions without writing
 * @param {(srcFile: string) => boolean} [options.filter] - Return false to skip a file
 */
function copyDirSync(src, dest, options = {}) {
  if (options.dryRun) {
    console.log(`  [dry-run] Would copy directory: ${src} -> ${dest}`);
    if (options.protect && fs.existsSync(src)) walkDryRun(src, dest, options);
    return;
  }
  // Destinations are often shared, user-owned trees (documents/development,
  // .claude/rules, lint/<tool>). Failure cleanup may only remove a directory
  // THIS call created — deleting a pre-existing dest on a mid-copy error
  // would wipe user content that was never ours to manage.
  const createdDest = !fs.existsSync(dest);
  fs.mkdirSync(dest, { recursive: true });
  try {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(srcPath, destPath, options);
      } else if (!options.filter || options.filter(srcPath)) {
        copyFileKeepingLocal(srcPath, destPath, options);
      }
    }
  } catch (err) {
    if (createdDest) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    throw new Error(`Failed to copy ${src} to ${dest}: ${err.message}`);
  }
}

/**
 * Copy files from src directory to dest directory (non-recursive, files only).
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, log actions without writing
 * @param {(srcFile: string) => boolean} [options.filter] - Return false to skip a file
 */
function copyFilesSync(src, dest, options = {}) {
  if (!fs.existsSync(src)) return;
  if (options.dryRun) {
    console.log(`  [dry-run] Would copy files: ${src} -> ${dest}`);
    if (options.protect) walkDryRun(src, dest, options, false);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isFile() && (!options.filter || options.filter(path.join(src, entry.name)))) {
      copyFileKeepingLocal(path.join(src, entry.name), path.join(dest, entry.name), options);
    }
  }
}

/**
 * Try to create a symlink/junction, fall back to directory copy.
 * On Windows, uses NTFS junction (no admin required).
 * @param {string} target - Target directory to link to
 * @param {string} linkPath - Path where the link/copy will be created
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, log actions without writing
 * @param {(srcFile: string) => boolean} [options.filter] - Return false to skip a file
 */
function linkOrCopy(target, linkPath, options = {}) {
  if (options.dryRun) {
    console.log(`  [dry-run] Would link: ${linkPath} -> ${target}`);
    return;
  }

  // Remove existing. lstat, not existsSync: existsSync follows the link, so
  // a dangling skills link read as "nothing here", the removal was skipped,
  // and both symlinkSync and the copy fallback then failed with EEXIST.
  let linkExists = false;
  try {
    fs.lstatSync(linkPath);
    linkExists = true;
  } catch {
    // No entry at linkPath.
  }
  if (linkExists) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  try {
    if (os.platform() === 'win32') {
      // Junction for directories on Windows (no admin needed)
      fs.symlinkSync(path.resolve(target), linkPath, 'junction');
      console.log(`  Junction created: ${linkPath} -> ${target}`);
    } else {
      // Relative symlink on Unix
      const relTarget = path.relative(path.dirname(linkPath), target);
      fs.symlinkSync(relTarget, linkPath);
      console.log(`  Symlink created: ${linkPath} -> ${relTarget}`);
    }
  } catch {
    copyDirSync(target, linkPath, options);
    console.log(`  Symlink/junction failed. Copied ${target} -> ${linkPath}`);
    console.log('  Note: Changes to skills/ won\'t auto-reflect. Re-run setup after updates.');
  }
}

/**
 * Detect available tech stacks (directories under given dir, excluding _template).
 * @param {string} [stacksDir] - Directory to scan. Defaults to PACKAGE_ROOT/stacks.
 * @returns {string[]} Array of stack directory names
 */
function detectStacks(stacksDir) {
  const dir = stacksDir || path.join(PACKAGE_ROOT, 'stacks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_template')
    .map((d) => d.name);
}

/**
 * Detect available project skills (directories containing SKILL.md).
 * @param {string} skillsDir - Directory to scan for skills
 * @returns {string[]} Sorted array of skill directory names
 */
function detectProjectSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

/**
 * Copy selected skills and always include non-skill directories (like _schemas).
 * @param {string} srcDir - Source skills directory
 * @param {string} destDir - Destination skills directory
 * @param {string[]} selectedSkills - Array of skill directory names to copy
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]
 */
function copySelectedSkills(srcDir, destDir, selectedSkills, options = {}) {
  if (!fs.existsSync(srcDir)) return;
  if (!options.dryRun) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const isSkill = fs.existsSync(path.join(srcDir, entry.name, 'SKILL.md'));
    if (isSkill && !selectedSkills.includes(entry.name)) continue;
    copyDirSync(
      path.join(srcDir, entry.name),
      path.join(destDir, entry.name),
      options
    );
  }
}

/**
 * Parse space-separated number tokens into selected items from an options array.
 * @param {string[]} tokens - User-entered tokens (e.g. ['1', '3', '5'])
 * @param {string[]} options - Available options to select from
 * @returns {{ selected: string[], warnings: string[] }}
 */
function parseNumberSelection(tokens, options) {
  const selected = [];
  const warnings = [];
  for (const token of tokens) {
    const num = parseInt(token, 10);
    if (num >= 1 && num <= options.length) {
      // Dedupe: "2 2" must not install a stack twice or write a duplicate
      // into the .ai-dev-helm.json manifest.
      if (!selected.includes(options[num - 1])) {
        selected.push(options[num - 1]);
      }
    } else {
      warnings.push(`"${token}" is not a valid number, skipping`);
    }
  }
  return { selected, warnings };
}

/**
 * 3.7.2 (the design "git location", rules 1-3): every git the harness runs is one of
 * - rule 1, a scratch place the harness made (a scratch repository, a release's CLI run there, files merged or diffed
 *   in a temporary directory): git gets scratchGitEnv() - the variables that point git at a repository are dropped, so
 *   an inherited GIT_DIR (a git hook gets one) never sends it to the product's repository (a scratch `git init`
 *   re-initialised that one as bare - C7-P1 / C8-P1 of the 3.7.2 quality-check);
 * - rule 2, the product's repository: git inherits the environment as it is and finds what the user's own git
 *   commands find (a product that sets GIT_DIR and GIT_WORK_TREE on purpose keeps them - C8-H1);
 * - rule 3: where only one of GIT_DIR / GIT_WORK_TREE is set, or one is empty, git takes the current directory for the
 *   top of the work tree, and init / upgrade / upgrade --resolve cannot tell what they write for: they write nothing
 *   (gitLocationProblem), and the commands that only read warn.
 * The variables kept for a scratch place: the configuration ones (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT and its
 * GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n), which carry settings such as not prompting for credentials.
 */
const SCRATCH_DROPPED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_CONFIG'];
const SCRATCH_KEPT = new Set(['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']);
let scratchDropped = null;
/** The names rule 1 drops, given what git lists (`git rev-parse --local-env-vars`): those and the fixed list. */
function scratchDroppedFrom(listed) {
  const names = String(listed || '').split(/\s+/).filter((name) => /^GIT_[A-Z0-9_]+$/.test(name));
  return new Set([...SCRATCH_DROPPED, ...names.filter((name) => !SCRATCH_KEPT.has(name))]);
}
/** The names rule 1 drops for this git, asked once. */
function scratchDroppedNames() {
  if (!scratchDropped) {
    let listed = '';
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRATCH_DROPPED.includes(key.toUpperCase())));
      const run = require('child_process').spawnSync('git', ['rev-parse', '--local-env-vars'], { cwd: require('os').tmpdir(), encoding: 'utf8', timeout: 10000, env });
      if (run.status === 0 && typeof run.stdout === 'string') listed = run.stdout;
    } catch {
      // no git: the fixed list
    }
    scratchDropped = scratchDroppedFrom(listed);
  }
  return scratchDropped;
}
/** Rule 1: the environment for git (and a release's CLI) in a scratch place - no variable pointing git anywhere. */
function scratchGitEnv(base = process.env) {
  const drop = scratchDroppedNames();
  return Object.fromEntries(Object.entries(base).filter(([key]) => !drop.has(key.toUpperCase())));
}

/** An environment variable as git reads it (on Windows the name in any case, as the system does). */
function envValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (process.platform === 'win32') {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name);
    if (key !== undefined) return env[key];
  }
  return undefined;
}
/**
 * Rule 3: null when GIT_DIR and GIT_WORK_TREE are both absent or both set to a value. Else, with `command`, the reason
 * that writing command writes nothing; with `command` null, the warning of a command that only reads.
 */
function gitLocationProblem(command, env = process.env) {
  const dir = envValue(env, 'GIT_DIR');
  const tree = envValue(env, 'GIT_WORK_TREE');
  const set = (v) => typeof v === 'string' && v !== '';
  if ((dir === undefined && tree === undefined) || (set(dir) && set(tree))) return null;
  const what = 'GIT_DIR / GIT_WORK_TREE: only one of them is set, or one is empty (as inside a git hook) - git then takes the current directory for the top of the work tree';
  return command
    ? `${what}, so ${command} cannot tell which repository it writes for. Run it outside the git hook, or set both GIT_DIR and GIT_WORK_TREE. Nothing was written.`
    : `${what}, so what git tracks and ignores may be read from the wrong place. init, upgrade and upgrade --resolve write nothing in this environment (run them outside the git hook, or set both).`;
}

/**
 * 3.7.2 (U2): the paths of `rels` (POSIX, relative to `dir`) that git ignores and does not track - a fresh checkout
 * of the product would not have them. A tracked file is never listed (git does not apply the ignore rules to it).
 * Empty without git, outside a repository or when git fails: the caller only warns, it never stops.
 */
function gitIgnoredPaths(dir, rels) {
  const list = [...new Set(rels || [])].filter((rel) => typeof rel === 'string' && rel);
  if (!list.length) return [];
  let run;
  try {
    run = require('child_process').spawnSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: dir, input: `${list.join('\0')}\0`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000,
    }); // rule 2: the product's repository, found as the user's git finds it
  } catch {
    return [];
  }
  // 0: some are ignored; 1: none; 128 and the rest: not a repository, or git failed.
  if (!run || run.status !== 0 || typeof run.stdout !== 'string') return [];
  return run.stdout.split('\0').filter(Boolean).map((rel) => rel.replace(/\\/g, '/'));
}

module.exports = {
  PACKAGE_ROOT,
  SKILL_SCOPE,
  TOOL_IDS,
  ALL_TOOL_IDS,
  TOOL_LABELS,
  printHeader,
  createPrompter,
  copyDirSync,
  copyFilesSync,
  copyFileKeepingLocal,
  contentHash,
  NEW_SUFFIX,
  linkOrCopy,
  detectStacks,
  detectProjectSkills,
  copySelectedSkills,
  parseNumberSelection,
  gitIgnoredPaths,
  scratchGitEnv,
  scratchDroppedFrom,
  gitLocationProblem,
};
