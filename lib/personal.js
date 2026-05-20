'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const utils = require('./utils');
const mergeSettingsModule = require('./merge-settings');

async function doPersonal(options = {}) {
  const { upgradeModel = false } = options;

  console.log('Personal environment setup');
  console.log('');

  console.log('Available options:');
  console.log('');
  console.log('  1) Claude Code global settings');
  console.log('     Block destructive commands, safety hooks, model version upgrade');
  console.log('');
  console.log('  2) Cursor global settings guide');
  console.log('     Copy recommended rules to clipboard');
  console.log('');
  console.log('  3) Codex global settings');
  console.log('     Merge ~/.codex/config.toml with destructive-command rules and safe defaults');
  console.log('');

  const prompter = utils.createPrompter();

  try {
    const selections = await prompter.promptMultiple('Select options (space-separated): ');

    for (const sel of selections) {
      switch (sel) {
        case '1':
          await setupClaudeCodeGlobal({ upgradeModel, prompter });
          break;
        case '2':
          setupCursorGlobal();
          break;
        case '3':
          await setupCodexGlobal({ upgradeModel, prompter });
          break;
        default:
          console.log(`  Warning: "${sel}" is not a valid option, skipping`);
          break;
      }
    }

    console.log('');
    console.log('Personal setup complete!');
  } finally {
    prompter.close();
  }
}

/**
 * Apply Claude Code global safety settings by merging template into ~/.claude/settings.json.
 *
 * If the template's `model` differs from the existing `model`, prompts the user (or
 * auto-upgrades when `upgradeModel: true`) and force-overwrites the model field.
 *
 * @param {Object} [options]
 * @param {boolean} [options.upgradeModel=false] - Force model upgrade without prompting
 * @param {Object} [options.prompter] - Prompter instance for interactive confirmation
 */
async function setupClaudeCodeGlobal(options = {}) {
  const { upgradeModel = false, prompter = null } = options;

  console.log('');
  console.log('--- Claude Code global settings ---');

  const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const templatePath = path.join(utils.PACKAGE_ROOT, 'templates', 'settings-global.json.template');

  const upgradeKeys = await detectModelUpgrade(claudeSettings, templatePath, { upgradeModel, prompter });

  mergeSettingsModule.mergeSettings(claudeSettings, templatePath, { upgradeKeys });
  console.log('  Claude Code global settings updated');
}

/**
 * Detect a model version mismatch between existing settings and template.
 * Returns ['model'] if the user (or flag) approves the upgrade, otherwise [].
 *
 * @param {string} targetPath - Path to existing settings file
 * @param {string} templatePath - Path to template settings file
 * @param {Object} options
 * @param {boolean} options.upgradeModel - Force upgrade without prompting
 * @param {Object|null} options.prompter - Prompter instance (null if non-interactive)
 * @returns {Promise<string[]>}
 */
async function detectModelUpgrade(targetPath, templatePath, { upgradeModel, prompter }) {
  if (!fs.existsSync(targetPath)) return [];

  let existing;
  let template;
  try {
    existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch {
    return [];
  }

  if (!template.model || !existing.model || existing.model === template.model) {
    return [];
  }

  console.log('  Model version mismatch detected:');
  console.log(`    Current:  ${existing.model}`);
  console.log(`    Template: ${template.model}`);

  if (upgradeModel) {
    console.log('  --upgrade-model flag set, upgrading.');
    return ['model'];
  }

  if (!prompter) {
    console.log('  Run with --upgrade-model to upgrade. Skipping.');
    return [];
  }

  const answer = await prompter.promptInput('  Upgrade model? (y/N): ');
  if (/^y(es)?$/i.test(String(answer).trim())) {
    return ['model'];
  }
  console.log('  Skipped model upgrade.');
  return [];
}

/**
 * Apply Codex global settings by merging template into ~/.codex/config.toml.
 *
 * If the template's `model` differs from the existing `model`, prompts the user
 * (or auto-upgrades when `upgradeModel: true`) and force-overwrites the model field.
 *
 * @param {Object} [options]
 * @param {boolean} [options.upgradeModel=false] - Force model upgrade without prompting
 * @param {Object} [options.prompter] - Prompter instance for interactive confirmation
 */
async function setupCodexGlobal(options = {}) {
  const { upgradeModel = false, prompter = null } = options;
  const mergeTomlModule = require('./merge-toml');

  console.log('');
  console.log('--- Codex global settings ---');

  const codexSettings = path.join(os.homedir(), '.codex', 'config.toml');
  const templatePath = path.join(utils.PACKAGE_ROOT, 'templates', 'codex-config-global.toml.template');

  const upgradeKeys = await detectCodexModelUpgrade(codexSettings, templatePath, { upgradeModel, prompter });

  mergeTomlModule.mergeToml(codexSettings, templatePath, { upgradeKeys });
  console.log('  Codex global settings updated');
}

/**
 * Detect a model version mismatch in Codex TOML config.
 * Returns ['model'] if the user (or flag) approves the upgrade, otherwise [].
 *
 * @param {string} targetPath - Path to existing TOML file
 * @param {string} templatePath - Path to template TOML file
 * @param {Object} options
 * @param {boolean} options.upgradeModel - Force upgrade without prompting
 * @param {Object|null} options.prompter - Prompter instance (null if non-interactive)
 * @returns {Promise<string[]>}
 */
async function detectCodexModelUpgrade(targetPath, templatePath, { upgradeModel, prompter }) {
  const toml = require('@iarna/toml');
  if (!fs.existsSync(targetPath)) return [];

  let existing;
  let template;
  try {
    existing = toml.parse(fs.readFileSync(targetPath, 'utf8'));
    template = toml.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch {
    return [];
  }

  if (!template.model || !existing.model || existing.model === template.model) {
    return [];
  }

  console.log('  Codex model version mismatch detected:');
  console.log(`    Current:  ${existing.model}`);
  console.log(`    Template: ${template.model}`);

  if (upgradeModel) {
    console.log('  --upgrade-model flag set, upgrading.');
    return ['model'];
  }

  if (!prompter) {
    console.log('  Run with --upgrade-model to upgrade. Skipping.');
    return [];
  }

  const answer = await prompter.promptInput('  Upgrade Codex model? (y/N): ');
  if (/^y(es)?$/i.test(String(answer).trim())) {
    return ['model'];
  }
  console.log('  Skipped Codex model upgrade.');
  return [];
}

/**
 * Display Cursor global safety rules and copy to clipboard if available.
 * Uses platform-specific clipboard commands (pbcopy/clip/xclip).
 */
function setupCursorGlobal() {
  console.log('');
  console.log('--- Cursor global settings ---');
  console.log('');
  console.log('Cursor global rules are managed via GUI (SQLite-based).');
  console.log('Please manually configure:');
  console.log('');
  console.log('  Cursor Settings -> Rules -> User Rules');
  console.log('');

  const rules = `## Safety Rules

- Never run destructive commands without explicit confirmation:
  - rm -rf /, rm -rf ~, rm -rf .
  - git push --force to main/master
  - git reset --hard
  - git clean -fd
  - docker system prune
  - npm/pnpm/yarn publish

## Development Rules

- Always check current branch before work (git branch --show-current)
- Never work directly on main branch
- Create GitHub Issues before starting work
- Follow project coding conventions in documents/development/coding-rules/`;

  // Try to copy to clipboard
  let copied = false;
  try {
    if (os.platform() === 'darwin') {
      childProcess.execSync('pbcopy', { input: rules });
      copied = true;
    } else if (os.platform() === 'win32') {
      childProcess.execSync('clip', { input: rules });
      copied = true;
    } else {
      // Try xclip on Linux
      childProcess.execSync('xclip -selection clipboard', { input: rules });
      copied = true;
    }
  } catch {
    // Clipboard not available
  }

  if (copied) {
    console.log('  Recommended rules copied to clipboard');
    console.log('  Paste into Cursor Settings -> Rules -> User Rules');
  } else {
    console.log('Recommended rules:');
    console.log('---');
    console.log(rules);
    console.log('---');
    console.log('  (Clipboard not available. Please copy manually.)');
  }
}

module.exports = {
  doPersonal,
  _setupClaudeCodeGlobal: setupClaudeCodeGlobal,
  _setupCursorGlobal: setupCursorGlobal,
  _setupCodexGlobal: setupCodexGlobal,
  _detectModelUpgrade: detectModelUpgrade,
  _detectCodexModelUpgrade: detectCodexModelUpgrade,
};
