'use strict';

const fs = require('fs');
const path = require('path');
const toml = require('@iarna/toml');
const { PACKAGE_ROOT } = require('./utils');

const LEGACY_RULES = [
  ['block-rm-rf-root', 'rm\\s+(-[a-zA-Z-]+\\s+)*-{1,2}[a-zA-Z]*[rR][a-zA-Z]*\\s+(-[a-zA-Z-]+\\s+)*/(\\s|$)', 'recursive rm of / is destructive'],
  ['block-rm-rf-home', 'rm\\s+(-[a-zA-Z-]+\\s+)*-{1,2}[a-zA-Z]*[rR][a-zA-Z]*\\s+(-[a-zA-Z-]+\\s+)*~/?(\\s|$)', 'recursive rm of ~ is destructive'],
  ['block-rm-rf-dot', 'rm\\s+(-[a-zA-Z-]+\\s+)*-{1,2}[a-zA-Z]*[rR][a-zA-Z]*\\s+(-[a-zA-Z-]+\\s+)*\\./?(\\s|$)', 'recursive rm of . is destructive'],
  ['block-git-force-push-main', 'git\\s+push\\s+([^\\s;&|]+\\s+)*(--force(-with-lease[^\\s;&|]*)?|-f)\\s+([^\\s;&|]+\\s+)*([^\\s;&|]*:)?\\+?(main|master)(\\s|$)|git\\s+push\\s+([^\\s;&|]+\\s+)*([^\\s;&|]*:)?\\+?(main|master)\\s+([^\\s;&|]+\\s+)*(--force(-with-lease[^\\s;&|]*)?|-f)(\\s|$)|git\\s+push\\s+([^\\s;&|]+\\s+)*\\+(main|master)(\\s|$)', 'force push to main/master'],
  ['block-git-reset-hard', 'git\\s+reset\\s+(-[a-zA-Z-]+\\s+)*--hard', 'git reset --hard'],
  ['block-git-clean-force', 'git\\s+clean\\s+(-[a-zA-Z-]+\\s+)*-{1,2}[a-zA-Z]*[fF][a-zA-Z]*(\\s|$)', 'git clean with -f/--force deletes untracked files'],
  ['block-docker-system-prune', 'docker\\s+system\\s+prune', 'docker system prune'],
  ['block-npm-publish', '(npm|pnpm|yarn)\\s+publish', 'package publish must be done manually'],
].map(([name, command_regex, reason]) => ({ name, match: { tool: 'Bash', command_regex }, decision: 'deny', reason: `Blocked by ai-dev-helm: ${reason}` }));

const AGENT_DEFAULTS = { enabled: true, default_subagent_model: 'gpt-5.6-terra', default_subagent_reasoning_effort: 'medium' };

function setupCodexRuntime(projectDir, { dryRun = false, codexDir = path.join(projectDir, '.codex') } = {}) {
  const warnings = [];
  const configPath = path.join(codexDir, 'config.toml');
  let config = {};
  let configChanged = false;
  if (fs.existsSync(configPath)) {
    try { config = toml.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { return [`Could not parse ${configPath}; left it unchanged: ${error.message}`]; }
  }
  const migration = migrateLegacyRules(config);
  warnings.push(...migration.warnings);
  configChanged ||= migration.changed;
  if (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)) {
    if (config.agents !== undefined) warnings.push('Preserved non-table [agents] setting; runtime defaults were not added.');
    else config.agents = {};
  }
  if (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)) {
    for (const [key, value] of Object.entries(AGENT_DEFAULTS)) {
      if (!(key in config.agents)) { config.agents[key] = value; configChanged = true; }
    }
  }
  if (!dryRun) {
    if (configChanged || !fs.existsSync(configPath)) {
      fs.mkdirSync(codexDir, { recursive: true });
      if (fs.existsSync(configPath)) backup(configPath);
      fs.writeFileSync(configPath, toml.stringify(config), 'utf8');
    }
    installManagedDirectory('codex-agents', path.join(codexDir, 'agents'), '', warnings);
    installManagedDirectory('codex-rules', path.join(codexDir, 'rules'), '.template', warnings);
  }
  return warnings;
}

function migrateLegacyRules(config) {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'rules')) return { removed: [], warnings: [], changed: false };
  if (!Array.isArray(config.rules)) {
    return { removed: [], warnings: ['ACTION REQUIRED: preserved non-array Codex rules setting; migrate it manually to a .rules file.'], changed: false };
  }
  const removed = [];
  const retained = [];
  const warnings = [];
  for (const rule of config.rules) {
    if (LEGACY_RULES.some((legacy) => sameTomlValue(legacy, rule))) removed.push(rule);
    else {
      retained.push(rule);
      const name = rule && typeof rule.name === 'string' ? ` \"${rule.name}\"` : '';
      warnings.push(`ACTION REQUIRED: preserved unknown Codex [[rules]] entry${name}; move it to a .rules file manually.`);
    }
  }
  if (retained.length === 0) delete config.rules;
  else config.rules = retained;
  return { removed, warnings, changed: true };
}

function installManagedDirectory(templateDirectory, destination, suffix = '', warnings = []) {
  const source = path.join(PACKAGE_ROOT, 'templates', templateDirectory);
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || (suffix && !entry.name.endsWith(suffix))) continue;
    const destinationPath = path.join(destination, suffix ? entry.name.slice(0, -suffix.length) : entry.name);
    const sourceContent = fs.readFileSync(path.join(source, entry.name), 'utf8');
    if (fs.existsSync(destinationPath)) {
      if (fs.readFileSync(destinationPath, 'utf8') === sourceContent) continue;
      warnings.push(`Preserved customized managed ${templateDirectory === 'codex-agents' ? 'role file' : 'safety rule file'}: ${path.basename(destinationPath)}`);
      continue;
    }
    fs.writeFileSync(destinationPath, sourceContent, 'utf8');
  }
}

function backup(filePath) { fs.copyFileSync(filePath, `${filePath}.backup.${new Date().toISOString().replace(/[-:.TZ]/g, '')}`); }
function sameTomlValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameTomlValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameTomlValue(left[key], right[key]));
}

module.exports = { setupCodexRuntime, migrateLegacyRules };
