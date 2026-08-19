'use strict';

/**
 * Runner for `ai-dev-helm lint`.
 *
 * Orchestrates config loading, file collection, and check execution:
 *
 *   runLint({ dir, paths, configPath, only, json })
 *     -> { violations, errors, warnings, exitCode, output }
 *
 * Exit codes: 2 when any runner/config error occurred, else 1 when any
 * violation was found, else 0.
 *
 * Fail-closed: every check invocation is wrapped in try/catch. A throwing
 * check is recorded once into `errors` as `check '<name>' failed: <message>`
 * (forcing exit code 2) and skipped for the rest of the run; the other
 * checks still complete.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { loadLintConfig } = require('./config');
const { collectFiles, readFileText } = require('./scan');
const { checks: registry } = require('./checks');

/** Timeout for git helper invocations */
const GIT_TIMEOUT_MS = 5000;

/** stdout cap for git helper invocations */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Git toplevel of `dir`, or null when outside a git work tree */
function gitToplevel(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    }).trim();
  } catch {
    return null;
  }
}

/** Build the argv-style git helper handed to repo-scope checks */
function makeGitHelper(repoRoot) {
  return (args) => {
    try {
      return execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      }).trim();
    } catch {
      return null;
    }
  };
}

/** Sort violations by file (nulls first), then line (nulls first), then check */
function compareViolations(a, b) {
  if (a.file !== b.file) {
    if (a.file === null) return -1;
    if (b.file === null) return 1;
    return a.file < b.file ? -1 : 1;
  }
  if (a.line !== b.line) {
    if (a.line === null) return -1;
    if (b.line === null) return 1;
    return a.line - b.line;
  }
  if (a.check !== b.check) {
    return a.check < b.check ? -1 : 1;
  }
  return 0;
}

/** Render one violation as a text output line */
function formatViolation(v) {
  const tail = `[${v.check}] ${v.message}`;
  if (v.file === null || v.file === undefined) {
    return tail;
  }
  if (v.line === null || v.line === undefined) {
    return `${v.file} ${tail}`;
  }
  return `${v.file}:${v.line} ${tail}`;
}

/** Assemble the result object, computing exitCode and output */
function finish({ violations, errors, warnings, json }) {
  violations.sort(compareViolations);

  const exitCode = errors.length > 0 ? 2 : violations.length > 0 ? 1 : 0;

  let output;
  if (json) {
    output = JSON.stringify(violations, null, 2);
  } else {
    const lines = violations.map(formatViolation);
    for (const w of warnings) {
      lines.push(`warning: ${w}`);
    }
    lines.push(
      violations.length > 0
        ? `${violations.length} problem(s) found`
        : 'No problems found'
    );
    output = lines.join('\n');
  }

  return { violations, errors, warnings, exitCode, output };
}

/**
 * Run the linter.
 * @param {Object} opts
 * @param {string} opts.dir directory to lint (usually process.cwd())
 * @param {string[]} [opts.paths] restrict scanning to these files/subtrees
 * @param {string} [opts.configPath] explicit config file path
 * @param {string[]} [opts.only] restrict to these check names
 * @param {boolean} [opts.json] JSON output mode
 * @returns {{violations: Array, errors: string[], warnings: string[],
 *            exitCode: number, output: string}}
 */
function runLint({ dir, paths = [], configPath, only = [], json = false }) {
  const violations = [];
  const errors = [];
  const warnings = [];

  const config = loadLintConfig(dir, configPath);
  warnings.push(...config.warnings);
  if (config.error) {
    errors.push(config.error);
    return finish({ violations, errors, warnings, json });
  }

  const knownNames = new Set(registry.map((c) => c.name));
  const unknown = only.filter((name) => !knownNames.has(name));
  if (unknown.length > 0) {
    errors.push(`unknown check name(s): ${unknown.join(', ')}`);
    return finish({ violations, errors, warnings, json });
  }

  const selected = registry.filter((check) => {
    const cfg = config.checks[check.name];
    if (!cfg || !cfg.enabled) {
      return false;
    }
    return only.length === 0 || only.includes(check.name);
  });
  const fileChecks = selected.filter((c) => c.scope === 'file');
  const repoChecks = selected.filter((c) => c.scope === 'repo');

  const rootDir = path.resolve(dir);
  const failed = new Set();
  const recordFailure = (check, err) => {
    if (!failed.has(check.name)) {
      failed.add(check.name);
      errors.push(
        `check '${check.name}' failed: ${err && err.message ? err.message : err}`
      );
    }
  };

  // File-scope checks: read each collected file once, share content/lines.
  if (fileChecks.length > 0) {
    const { files } = collectFiles({ dir: rootDir, paths, exclude: config.exclude });
    for (const relPath of files) {
      const absPath = path.join(rootDir, relPath);
      let content;
      let eol;
      try {
        ({ content, eol } = readFileText(absPath));
      } catch {
        continue; // vanished/unreadable since collection: drop silently
      }
      const lines = content.split(/\r?\n/);
      for (const check of fileChecks) {
        if (failed.has(check.name)) {
          continue;
        }
        try {
          const found = check.run({
            relPath,
            content,
            lines,
            eol,
            options: config.checks[check.name].options,
            absPath,
            rootDir,
          });
          violations.push(...found);
        } catch (err) {
          recordFailure(check, err);
        }
      }
    }
  }

  // Repo-scope checks: run once against the git toplevel (or dir itself
  // outside git; the checks return [] when git is unavailable).
  if (repoChecks.length > 0) {
    const repoRoot = gitToplevel(rootDir) || rootDir;
    const git = makeGitHelper(repoRoot);
    for (const check of repoChecks) {
      try {
        const found = check.run({
          repoRoot,
          options: config.checks[check.name].options,
          git,
        });
        violations.push(...found);
      } catch (err) {
        recordFailure(check, err);
      }
    }
  }

  return finish({ violations, errors, warnings, json });
}

module.exports = { runLint };
