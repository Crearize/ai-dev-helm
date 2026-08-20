'use strict';

const fs = require('fs');
const path = require('path');
const toml = require('@iarna/toml');

// Rules whose `reason` carries this prefix are package-managed: shipped by
// the ai-dev-helm template, not authored by the user. The prefix is the
// ownership marker that lets a re-run of `personal` upgrade them.
const MANAGED_REASON_PREFIX = 'Blocked by ai-dev-helm:';

function isManagedRule(rule) {
  return (
    rule && typeof rule.reason === 'string' && rule.reason.startsWith(MANAGED_REASON_PREFIX)
  );
}

/**
 * Merge a TOML template into an existing TOML file.
 *
 * Behavior mirrors merge-settings.js semantics:
 * - Creates a timestamped backup of the existing file
 * - Top-level scalar/table keys from template are added as defaults (existing values preserved)
 * - Keys listed in `options.upgradeKeys` are force-overwritten with template values
 * - Top-level array-of-tables `rules` lists are merged by `name`:
 *   - PACKAGE-MANAGED existing rules (reason starts with "Blocked by
 *     ai-dev-helm:") are refreshed from the template when the name still
 *     exists there, and DROPPED when it does not (a renamed/retired template
 *     rule must not linger as a stale orphan). Without this, hardened
 *     template regexes never reached users who had already run `personal`.
 *   - User-authored existing rules (any other reason) are always retained,
 *     and win over a template rule of the same name.
 *   - Template rules whose name is not present are appended.
 *   - An existing `rules` key that is not an array is left untouched (with a
 *     warning) rather than silently destroyed.
 *
 * @param {string} targetPath - Path to the existing TOML file (created if missing)
 * @param {string} templatePath - Path to the template TOML file
 * @param {Object} [options]
 * @param {string[]} [options.upgradeKeys] - Top-level keys to force-overwrite from template
 */
function mergeToml(targetPath, templatePath, options = {}) {
  const upgradeKeys = Array.isArray(options.upgradeKeys) ? options.upgradeKeys : [];

  let existing = {};
  if (fs.existsSync(targetPath)) {
    // Millisecond-resolution backups: two merges inside the same second must
    // not overwrite the pristine backup with the already-merged file.
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const backup = `${targetPath}.backup.${timestamp}`;
    fs.copyFileSync(targetPath, backup);
    console.log(`  Backup created: ${backup}`);

    try {
      existing = toml.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch (parseErr) {
      throw new Error(`Failed to parse ${targetPath}: ${parseErr.message}. Check for TOML syntax errors. Backup: ${backup}`);
    }
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  let template;
  try {
    template = toml.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch (parseErr) {
    throw new Error(`Failed to parse template ${templatePath}: ${parseErr.message}`);
  }

  for (const key of Object.keys(template)) {
    if (key === 'rules') continue;
    if (!(key in existing) || upgradeKeys.includes(key)) {
      existing[key] = template[key];
    }
  }

  if (Array.isArray(template.rules) && template.rules.length > 0) {
    if ('rules' in existing && !Array.isArray(existing.rules)) {
      // A `[rules]` table (or other non-array shape) is not ours to rewrite;
      // overwriting it wholesale would silently destroy user configuration.
      console.warn(
        `  warning: 'rules' in ${targetPath} is not an array of tables; leaving it untouched`
      );
    } else {
      const existingRules = Array.isArray(existing.rules) ? existing.rules : [];
      const templateByName = new Map(
        template.rules.filter((r) => r && r.name).map((r) => [r.name, r])
      );
      const merged = [];
      const mergedNames = new Set();
      for (const rule of existingRules) {
        if (isManagedRule(rule) && rule.name) {
          const upgraded = templateByName.get(rule.name);
          if (!upgraded) continue; // Retired/renamed managed rule: drop it.
          merged.push(upgraded);
          mergedNames.add(rule.name);
        } else {
          merged.push(rule);
          if (rule && rule.name) mergedNames.add(rule.name);
        }
      }
      for (const rule of template.rules) {
        if (!rule || !rule.name) continue;
        if (!mergedNames.has(rule.name)) {
          merged.push(rule);
          mergedNames.add(rule.name);
        }
      }
      existing.rules = merged;
    }
  }

  fs.writeFileSync(targetPath, toml.stringify(existing), 'utf8');
  console.log('  TOML settings merged');
}

module.exports = { mergeToml };
