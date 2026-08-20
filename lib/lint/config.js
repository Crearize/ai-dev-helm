'use strict';

/**
 * Lint config loader for `ai-dev-helm lint`.
 *
 * Reads `.ai-dev-helm-lint.json` and merges it onto built-in defaults.
 *
 * Result shape (always the same, never throws):
 *
 *   {
 *     configPath: string | null,   // resolved path of the loaded file, or null
 *     exclude: string[],           // glob patterns excluded from file checks
 *     checks: {                    // one entry per registered check
 *       [name]: { enabled: boolean, options: object },
 *     },
 *     warnings: string[],          // e.g. unknown check names in the config
 *     error: string | null,        // broken JSON / missing explicit path;
 *   }                              //   the runner maps error -> exit code 2
 *
 * Merge rules:
 *   - Unspecified checks fall back to defaults.
 *   - For a specified check, option keys merge shallowly onto that check's
 *     defaults (`enabled` is separate from options).
 *   - Unknown check names are ignored and reported in `warnings`.
 *
 * Search: starting at startDir, walk parent directories looking for the
 * config file, stopping at the git repository root (directory containing
 * `.git`) inclusive, or the filesystem root. An explicitPath bypasses the
 * search and must exist.
 */

const fs = require('fs');
const path = require('path');
const { checks: registry } = require('./checks');

/** Config file name searched for at/above startDir */
const CONFIG_FILENAME = '.ai-dev-helm-lint.json';

/**
 * Per-check option defaults. The registry provides only
 * { name, defaultEnabled }; option defaults live here so there is a single
 * place for them. Checks without an entry default to {}.
 */
const DEFAULT_OPTIONS = {
  secrets: { allow: [] },
  'commented-code': { minLines: 3 },
  'todo-deadline': {},
  'import-exists': { aliases: {} },
  'file-naming': { rules: [] },
  'branch-naming': {
    pattern: '^(feat|fix|chore|docs|refactor|test|ci|perf)/[a-z0-9._-]+$',
    exempt: ['main', 'master', 'develop'],
  },
  'commit-message': {
    pattern: '^(feat|fix|chore|docs|refactor|test|ci|perf|revert)(\\(.+\\))?!?: .+',
  },
};

/** Build the all-defaults checks map from the registry */
function defaultChecks() {
  // Null-prototype map so config keys like `__proto__` / `constructor` cannot
  // resolve against Object.prototype (prototype-pollution / crash guard).
  const checks = Object.create(null);
  for (const entry of registry) {
    checks[entry.name] = {
      enabled: entry.defaultEnabled,
      options: { ...(DEFAULT_OPTIONS[entry.name] || {}) },
    };
  }
  return checks;
}

/**
 * Find the config file by walking parents of startDir, stopping at the git
 * repository root (inclusive) or the filesystem root.
 * @returns {string|null} resolved config path, or null when not found
 */
function findConfigFile(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (fs.existsSync(path.join(dir, '.git'))) {
      return null; // git root reached (inclusive), do not search above
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null; // filesystem root
    }
    dir = parent;
  }
}

/**
 * Load lint configuration.
 * @param {string} startDir directory to start searching from
 * @param {string} [explicitPath] load exactly this file instead of searching
 * @returns {{configPath: string|null, exclude: string[], checks: Object,
 *            warnings: string[], error: string|null}}
 */
function loadLintConfig(startDir, explicitPath) {
  const result = {
    configPath: null,
    exclude: [],
    checks: defaultChecks(),
    warnings: [],
    error: null,
  };

  let configPath;
  if (explicitPath) {
    configPath = explicitPath;
    result.configPath = configPath;
    if (!fs.existsSync(configPath)) {
      result.error = `Lint config file not found: ${configPath}`;
      return result;
    }
  } else {
    configPath = findConfigFile(startDir);
    if (!configPath) {
      return result; // defaults
    }
    result.configPath = configPath;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    result.error = `Failed to parse ${configPath}: ${err.message}`;
    return result;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    result.error = `Invalid lint config in ${configPath}: expected a JSON object`;
    return result;
  }

  if (Array.isArray(raw.exclude)) {
    result.exclude = raw.exclude.filter((e) => typeof e === 'string');
  }

  const rawChecks =
    raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks)
      ? raw.checks
      : {};
  for (const [name, value] of Object.entries(rawChecks)) {
    if (!Object.prototype.hasOwnProperty.call(result.checks, name)) {
      result.warnings.push(`Unknown check "${name}" in ${configPath} (ignored)`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      result.warnings.push(
        `Invalid config for check "${name}" in ${configPath} (ignored)`
      );
      continue;
    }
    const { enabled, ...options } = value;
    if (typeof enabled === 'boolean') {
      result.checks[name].enabled = enabled;
    }
    // Shallow merge of this check's options onto its defaults
    Object.assign(result.checks[name].options, options);
  }

  return result;
}

module.exports = { loadLintConfig, CONFIG_FILENAME };
