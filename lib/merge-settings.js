'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Merge settings from a template into an existing settings file.
 *
 * Behavior:
 * - Creates a timestamped backup of the existing file
 * - Top-level keys from template are added as defaults (existing values preserved)
 * - Keys listed in `options.upgradeKeys` are force-overwritten with template values
 * - permissions.deny lists are merged (union)
 * - permissions.allow is preserved (defaulted to [] if missing)
 * - All other permissions keys (defaultMode, additionalDirectories, etc.) are preserved
 * - hooks are preserved from existing file
 *
 * @param {string} targetPath - Path to the existing settings file (created if missing)
 * @param {string} templatePath - Path to the template settings file
 * @param {Object} [options]
 * @param {string[]} [options.upgradeKeys] - Top-level keys to force-overwrite from template
 */
function mergeSettings(targetPath, templatePath, options = {}) {
  const upgradeKeys = Array.isArray(options.upgradeKeys) ? options.upgradeKeys : [];
  // Read or initialize existing settings
  let existing = {};
  if (fs.existsSync(targetPath)) {
    // Create backup. Millisecond resolution: two merges inside the same
    // second must not overwrite the pristine backup with the merged file.
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const backup = `${targetPath}.backup.${timestamp}`;
    fs.copyFileSync(targetPath, backup);
    console.log(`  Backup created: ${backup}`);

    try {
      existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch (parseErr) {
      throw new Error(`Failed to parse ${targetPath}: ${parseErr.message}. Check for JSON syntax errors. Backup: ${backup}`);
    }
  } else {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  let template;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch (parseErr) {
    throw new Error(`Failed to parse template ${templatePath}: ${parseErr.message}`);
  }

  // Apply top-level settings from template as defaults (existing values take precedence,
  // unless the key is listed in upgradeKeys, in which case the template value is forced).
  for (const key of Object.keys(template)) {
    if (key !== 'permissions' && key !== 'hooks') {
      if (!(key in existing) || upgradeKeys.includes(key)) {
        existing[key] = template[key];
      }
    }
  }

  // Ensure permissions is a plain object; a string/array/number here would
  // otherwise throw an opaque TypeError below (the backup already exists, so
  // normalizing the invalid shape is recoverable).
  if (
    !existing.permissions ||
    typeof existing.permissions !== 'object' ||
    Array.isArray(existing.permissions)
  ) {
    existing.permissions = {};
  }

  // Merge deny lists (union) - all other permissions keys are preserved
  const existingDeny = new Set(
    Array.isArray(existing.permissions.deny) ? existing.permissions.deny : []
  );
  const templateDeny = template.permissions?.deny || [];
  for (const rule of templateDeny) {
    existingDeny.add(rule);
  }
  existing.permissions.deny = [...existingDeny].sort();

  // Ensure allow list exists
  if (!existing.permissions.allow) {
    existing.permissions.allow = [];
  }

  // Write merged settings
  fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  console.log('  Settings merged');
}

module.exports = { mergeSettings };
