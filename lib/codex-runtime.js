'use strict';

const fs = require('fs');
const path = require('path');
const toml = require('@iarna/toml');
const crypto = require('crypto');
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

const AGENT_DEFAULTS = { enabled: true, default_subagent_model: 'gpt-6.1-sol', default_subagent_reasoning_effort: 'medium' };
// Values written by earlier releases; replaced on upgrade, while user-chosen values are preserved.
const LEGACY_SUBAGENT_MODELS = ['gpt-5.6-terra'];
// SHA-256 (LF-normalized) of role files shipped by earlier releases, keyed by file name. An installed
// file that still matches its own earlier content was never customized, so it is updated.
const LEGACY_MANAGED_HASHES = new Map([
  ['helm-designer.toml', ['10480fa7450ee4889dd74fc9caa28b79ff68c3b041fd39a6336a3f65d3c0c779']],
  ['helm-explorer.toml', ['784b3f716591caae93daad12d400ba349b3b3dd2fc36a8186a7c187d37e9a79d']],
  ['helm-implementer.toml', ['bfd2db79986fcecd38ca0d38eac4d645ec5564e749e15dcd9403f84c4590d77c']],
  ['helm-reviewer.toml', ['bffebdc17000551cfe923d39210f09a3134868a88e02bd2ff80870526ed8672e']],
]);

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
    if (LEGACY_SUBAGENT_MODELS.includes(config.agents.default_subagent_model)) {
      warnings.push(`${dryRun ? 'Would update' : 'Updated'} [agents] default_subagent_model from ${config.agents.default_subagent_model} to ${AGENT_DEFAULTS.default_subagent_model}.`);
      config.agents.default_subagent_model = AGENT_DEFAULTS.default_subagent_model;
      configChanged = true;
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
      const installed = fs.readFileSync(destinationPath, 'utf8');
      if (normalizeEol(installed) === normalizeEol(sourceContent)) continue;
      if ((LEGACY_MANAGED_HASHES.get(path.basename(destinationPath)) || []).includes(sha256(normalizeEol(installed)))) {
        fs.writeFileSync(destinationPath, sourceContent, 'utf8');
        warnings.push(`Updated managed role file from a previous release: ${path.basename(destinationPath)}`);
        continue;
      }
      warnings.push(`Preserved customized managed ${templateDirectory === 'codex-agents' ? 'role file' : 'safety rule file'}: ${path.basename(destinationPath)}`);
      continue;
    }
    fs.writeFileSync(destinationPath, sourceContent, 'utf8');
  }
}

function normalizeEol(text) { return text.replace(/\r\n/g, '\n'); }
function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
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
