'use strict';

const fs = require('fs');
const path = require('path');
const toml = require('@iarna/toml');

/**
 * Merge a TOML template into an existing TOML file.
 *
 * Behavior mirrors merge-settings.js semantics:
 * - Creates a timestamped backup of the existing file
 * - Top-level scalar/table keys from template are added as defaults (existing values preserved)
 * - Keys listed in `options.upgradeKeys` are force-overwritten with template values
 * - Top-level array-of-tables `rules` lists are merged by unique `name`
 *   (existing rules retained; template rules added if name is not present)
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
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
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
    const existingRules = Array.isArray(existing.rules) ? existing.rules : [];
    const existingNames = new Set(existingRules.map((r) => r && r.name).filter(Boolean));
    const merged = [...existingRules];
    for (const rule of template.rules) {
      if (!rule || !rule.name) continue;
      if (!existingNames.has(rule.name)) {
        merged.push(rule);
        existingNames.add(rule.name);
      }
    }
    existing.rules = merged;
  }

  fs.writeFileSync(targetPath, toml.stringify(existing), 'utf8');
  console.log('  TOML settings merged');
}

module.exports = { mergeToml };
