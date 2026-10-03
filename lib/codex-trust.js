'use strict';

// Read-only check of Codex hook trust (H-52). Codex skips a hook it has not
// been told to trust - a new one, or one whose definition changed - without a
// warning, so an installed quality-gate can be silently inactive. This module
// reads the Codex user config and the project's `.codex/hooks.json` and says
// whether Codex will run each hook. It never writes to any Codex config and
// never runs `codex`.
//
// What Codex records (codex-rs, rust-v0.156.1):
//   - project trust: `[projects."<dir>"] trust_level = "trusted"`, looked up
//     for the cwd, the project root and the repository root, compared with
//     ASCII case folded on Windows (config/src/loader/mod.rs);
//   - hook trust: `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"]
//     trusted_hash = "sha256:..."` (hooks/src/lib.rs `hook_key`). The key is
//     compared EXACTLY, and on Windows its path is spelled the way the cwd
//     Codex started in was spelled.
//   - the hash covers the normalized REGISTRATION only - event name, matcher
//     and the handler fields (type, command, timeout, async, statusMessage,
//     additionalContextLimit) - and not the script the command runs
//     (hooks/src/engine/discovery.rs `hook_hash`, config/src/fingerprint.rs
//     `version_for_toml`: SHA-256 of the key-sorted compact JSON). It was
//     checked against the hashes Codex 0.156.1 itself reports.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const toml = require('@iarna/toml');

// hooks.json event name -> the label Codex uses in keys and hashes, whether
// the matcher counts (matcher_pattern_for_event), whether
// additionalContextLimit counts, and the timeout rule (normalize_command_hook).
const EVENTS = {
  PreToolUse: { label: 'pre_tool_use', matcher: true, context: true },
  PermissionRequest: { label: 'permission_request', matcher: true, context: false },
  PostToolUse: { label: 'post_tool_use', matcher: true, context: true },
  PreCompact: { label: 'pre_compact', matcher: true, context: false },
  PostCompact: { label: 'post_compact', matcher: true, context: false },
  SessionStart: { label: 'session_start', matcher: true, context: true },
  SessionEnd: { label: 'session_end', matcher: true, context: false, shortTimeout: true },
  UserPromptSubmit: { label: 'user_prompt_submit', matcher: false, context: true },
  SubagentStart: { label: 'subagent_start', matcher: true, context: true },
  SubagentStop: { label: 'subagent_stop', matcher: true, context: false },
  Stop: { label: 'stop', matcher: false, context: false },
  Interrupt: { label: 'interrupt', matcher: false, context: false, shortTimeout: true },
};
const DEFAULT_TIMEOUT_SEC = 600;
const SHORT_DEFAULT_TIMEOUT_SEC = 1;
const SHORT_MAX_TIMEOUT_SEC = 3;
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

// The trusted_hash Codex 0.156.1 records for one handler, or null when the
// handler is not a command hook this function can read the way Codex does.
function codexHookHash(eventName, matcher, handler, { platform = process.platform } = {}) {
  const event = EVENTS[eventName];
  if (!event || !isPlainObject(handler) || handler.type !== 'command') return null;
  const windowsCommand = handler.commandWindows !== undefined ? handler.commandWindows : handler.command_windows;
  const command = platform === 'win32' && typeof windowsCommand === 'string' ? windowsCommand : handler.command;
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (handler.timeout !== undefined && handler.timeout !== null && !isUint(handler.timeout)) return null;
  if (handler.async !== undefined && typeof handler.async !== 'boolean') return null;
  if (handler.statusMessage !== undefined && handler.statusMessage !== null && typeof handler.statusMessage !== 'string') return null;
  const limit = handler.additionalContextLimit;
  if (limit !== undefined && limit !== null && !isUint(limit)) return null;
  if (matcher !== undefined && matcher !== null && typeof matcher !== 'string') return null;

  let timeout = isUint(handler.timeout) ? handler.timeout : null;
  if (event.shortTimeout) {
    timeout = Math.min(Math.max(timeout === null ? SHORT_DEFAULT_TIMEOUT_SEC : timeout, 1), SHORT_MAX_TIMEOUT_SEC);
  } else {
    timeout = Math.max(timeout === null ? DEFAULT_TIMEOUT_SEC : timeout, 1);
  }
  const normalized = { type: 'command', command, timeout, async: handler.async === true };
  if (typeof handler.statusMessage === 'string') normalized.statusMessage = handler.statusMessage;
  if (event.context && isUint(limit) && limit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) normalized.additionalContextLimit = limit;
  const identity = { event_name: event.label, hooks: [normalized] };
  if (event.matcher && typeof matcher === 'string') identity.matcher = matcher;
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical(identity)), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

// --codex-home > CODEX_HOME > ~/.codex (USERPROFILE on Windows).
function resolveCodexHome({ codexHome, env = process.env, platform = process.platform } = {}) {
  if (codexHome) return { dir: path.resolve(codexHome), source: '--codex-home' };
  if (env.CODEX_HOME) return { dir: path.resolve(env.CODEX_HOME), source: 'CODEX_HOME' };
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  return { dir: path.join(home, '.codex'), source: 'default' };
}

function pathKey(p, platform) {
  if (platform !== 'win32') return p;
  return p.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function spellings(p) {
  const out = [path.resolve(p)];
  try {
    const real = fs.realpathSync.native(p);
    if (!out.includes(real)) out.push(real);
  } catch {
    // A path that does not resolve keeps its given spelling only.
  }
  return out;
}

// The directories Codex looks project trust up for: the project directory, its
// git toplevel, and the main repository root (a worktree's trust key).
function projectTrustDirs(projectDir) {
  const dirs = spellings(projectDir);
  try {
    const out = execFileSync('git', ['-C', projectDir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).split(/\r?\n/).filter(Boolean);
    const [toplevel, commonDir] = out;
    if (toplevel) dirs.push(...spellings(toplevel));
    if (commonDir && path.basename(commonDir) === '.git') dirs.push(...spellings(path.dirname(commonDir)));
  } catch {
    // Not a git repository (or git missing): the directory alone.
  }
  return [...new Set(dirs)];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

const HOOK_KEY_RE = /^(.*):([a-z_]+):(\d+):(\d+)$/;

function checkCodexTrust({ projectDir = process.cwd(), codexHome, env = process.env, platform = process.platform } = {}) {
  const lines = [];
  const home = resolveCodexHome({ codexHome, env, platform });
  const configPath = path.join(home.dir, 'config.toml');
  const unreadable = (what, file, error) => {
    lines.push(`UNREADABLE: could not read ${what}: ${file}${error ? ` (${error})` : ''}`);
    return { exitCode: 2, lines, configPath };
  };

  const sourceLabel = home.source === 'default' ? '~/.codex (default)' : home.source;
  lines.push(`Codex config read: ${configPath} (from ${sourceLabel})`);
  if (home.source === 'default') {
    lines.push('note: neither --codex-home nor CODEX_HOME was given, so ~/.codex was read. If you run Codex with another config location (an orca account, for example), pass it with --codex-home <dir>. Trust is recorded per config location, so check each one you use.');
  }
  let config;
  try {
    config = toml.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    return unreadable('the Codex config', configPath, error.code === 'ENOENT' ? 'no such file' : error.message.split('\n')[0]);
  }

  const project = path.resolve(projectDir);
  const hooksPath = path.join(project, '.codex', 'hooks.json');
  lines.push(`Project: ${project}`);
  let hooksFile;
  try {
    hooksFile = readJson(hooksPath);
  } catch (error) {
    return unreadable('the project hooks', hooksPath, error.code === 'ENOENT' ? 'no such file' : error.message.split('\n')[0]);
  }

  let actionRequired = false;
  const action = (message) => {
    actionRequired = true;
    lines.push(`ACTION REQUIRED: ${message}`);
  };

  // Project trust: Codex reads the project's .codex/ only for a trusted project.
  const projects = isPlainObject(config.projects) ? config.projects : {};
  const trustDirs = projectTrustDirs(project).map((d) => pathKey(d, platform));
  const projectEntry = Object.entries(projects).find(([key]) => trustDirs.includes(pathKey(key, platform)));
  if (!projectEntry) {
    action(`the project is not trusted in ${configPath}, so Codex does not read its .codex/ (hooks included). Trust the project when Codex asks on start-up.`);
  } else if (!isPlainObject(projectEntry[1]) || projectEntry[1].trust_level !== 'trusted') {
    const level = isPlainObject(projectEntry[1]) ? projectEntry[1].trust_level : undefined;
    action(`the project entry "${projectEntry[0]}" has trust_level ${JSON.stringify(level)}, not "trusted", so Codex does not read its .codex/ (hooks included).`);
  } else {
    lines.push(`project trust: trusted ("${projectEntry[0]}")`);
  }

  // Hook trust, per handler.
  const hooks = isPlainObject(hooksFile) && isPlainObject(hooksFile.hooks) ? hooksFile.hooks : {};
  const states = isPlainObject(config.hooks) && isPlainObject(config.hooks.state) ? config.hooks.state : {};
  const hookPaths = spellings(hooksPath);
  const hookPathKeys = hookPaths.map((p) => pathKey(p, platform));
  const stateEntries = Object.entries(states).map(([key, value]) => {
    const m = HOOK_KEY_RE.exec(key);
    return m ? { key, path: m[1], event: m[2], group: Number(m[3]), handler: Number(m[4]), value } : null;
  }).filter((e) => e && hookPathKeys.includes(pathKey(e.path, platform)));

  lines.push(`Hooks: ${hooksPath}`);
  let count = 0;
  const notTrusted = [];
  const stale = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const event = EVENTS[eventName];
    const label = event ? event.label : eventName;
    groups.forEach((group, g) => {
      const handlers = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
      handlers.forEach((handler, h) => {
        count++;
        const id = `${label}:${g}:${h}`;
        const what = `${id} (matcher ${JSON.stringify(group.matcher === undefined ? null : group.matcher)}${hookScript(handler)})`;
        const matches = stateEntries.filter((e) => e.event === label && e.group === g && e.handler === h);
        const exact = matches.find((e) => hookPaths.includes(e.path));
        const entry = exact || matches[0];
        if (entry && isPlainObject(entry.value) && entry.value.enabled === false) {
          action(`Codex hook ${what} is disabled in ${configPath}. Enable it in /hooks.`);
          return;
        }
        if (!entry || !isPlainObject(entry.value) || typeof entry.value.trusted_hash !== 'string') {
          notTrusted.push(what);
          return;
        }
        const expected = codexHookHash(eventName, group.matcher, handler, { platform });
        const spelling = exact ? '' : ` Note: the entry is recorded under "${entry.path}"; Codex compares this key exactly, so it applies only when Codex starts in the project spelled that way.`;
        if (expected === null) {
          lines.push(`trusted entry found: ${what} - the entry exists, but whether it was re-trusted after the definition changed cannot be confirmed.${spelling}`);
        } else if (expected !== entry.value.trusted_hash) {
          stale.push(what);
        } else {
          lines.push(`trusted: ${what}${spelling}`);
        }
      });
    });
  }
  if (count === 0) lines.push('(no hooks registered in this hooks.json)');
  if (notTrusted.length) {
    action(`Codex hooks are not trusted: ${notTrusted.join(', ')}. Codex skips them without a warning. Open /hooks in Codex in this project and trust them.`);
  }
  if (stale.length) {
    action(`Codex hooks changed since trusted (stale trust): ${stale.join(', ')}. Codex skips them until they are trusted again. Open /hooks in Codex in this project and trust them again. (The hash is computed the way Codex 0.156.1 does; if /hooks already shows them trusted, your Codex version hashes differently - go by /hooks.)`);
  }
  lines.push(actionRequired ? 'Result: ACTION REQUIRED' : 'Result: ok');
  return { exitCode: actionRequired ? 1 : 0, lines, configPath };
}

function hookScript(handler) {
  const command = isPlainObject(handler) && typeof handler.command === 'string' ? handler.command : '';
  const m = /([A-Za-z0-9._-]+\.cjs)/.exec(command);
  return m ? `, ${m[1]}` : '';
}

module.exports = { checkCodexTrust, codexHookHash, resolveCodexHome };
