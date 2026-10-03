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
//     for the cwd, then the project root, then the repository root (the first
//     that has an entry decides), compared with ASCII case folded on Windows
//     and nothing else normalized (config/src/loader/mod.rs);
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
//   - a linked git worktree: Codex reads the hooks of the MAIN checkout's
//     matching directory, `<main root>/<path in the worktree>/.codex/hooks.json`
//     (only when the worktree's own directory has a `.codex/`), and keys their
//     trust by that path (config/src/loader/mod.rs
//     `root_checkout_hooks_folder_for_dir`).
//   - hooks.json is parsed strictly (config/src/hook_config.rs `HooksFile`):
//     a top-level key other than `description` / `hooks`, a value of the wrong
//     type, an unknown handler `type` or a byte order mark makes Codex skip the
//     whole file; an unknown event name is ignored.
//
// Limits of this check: the config is parsed with @iarna/toml (TOML 0.5), so
// a TOML 1.0 array that mixes value types is reported as unreadable (exit 2),
// the safe side. A config.toml or hooks.json over 1 MB is not read (exit 2).
// A parse error is reported by kind and position only - never with the
// file's text, which may hold secrets.

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


// --codex-home > CODEX_HOME > ~/.codex (USERPROFILE on Windows). An empty
// --codex-home is an error, not "not given".
function resolveCodexHome({ codexHome, env = process.env, platform = process.platform } = {}) {
  if (codexHome !== undefined && codexHome !== null) {
    if (String(codexHome).trim() === '') return { dir: null, source: '--codex-home', error: '--codex-home was given an empty path' };
    return { dir: path.resolve(codexHome), source: '--codex-home' };
  }
  if (env.CODEX_HOME) return { dir: path.resolve(env.CODEX_HOME), source: 'CODEX_HOME' };
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  return { dir: path.join(home, '.codex'), source: 'default' };
}

// The key Codex compares: ASCII case folded on Windows, nothing else.
const strictKey = (p, platform) => (platform === 'win32' ? p.replace(/[A-Z]/g, (c) => c.toLowerCase()) : p);
// Also folds separators, a trailing separator and the `\\?\` prefix: finds an
// entry recorded under another spelling, which Codex does NOT match.
function looseKey(p, platform) {
  if (platform !== 'win32') return p.replace(/\/+$/, '') || '/';
  return p.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// The canonical spelling first, as Codex looks them up.
function spellings(p) {
  const out = [];
  try {
    out.push(fs.realpathSync.native(p));
  } catch {
    // A path that does not resolve keeps its given spelling only.
  }
  const resolved = path.resolve(p);
  if (!out.includes(resolved)) out.push(resolved);
  return out;
}

// The git toplevel of `dir` and the main checkout's root (the parent of the
// common git directory), or nulls outside a repository.
function gitLayout(dir) {
  try {
    const [toplevel, commonDir] = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).split(/\r?\n/).filter(Boolean);
    return {
      toplevel: toplevel ? path.resolve(toplevel) : null,
      mainRoot: commonDir && path.basename(commonDir) === '.git' ? path.resolve(path.dirname(commonDir)) : null,
    };
  } catch {
    return { toplevel: null, mainRoot: null }; // Not a git repository (or git missing).
  }
}

const sameDir = (a, b) => looseKey(spellings(a)[0], process.platform) === looseKey(spellings(b)[0], process.platform);

// Codex's project trust lookup: the cwd, then the project root, then the
// repository root; for each, an exact key, then a case-folded one (the
// first in sort order). An entry without `trust_level` is passed over, as
// Codex does. The first directory with an entry decides; the result is
// [key, entry, index of the directory group].
const hasTrustLevel = (entry) => isPlainObject(entry) && entry.trust_level !== undefined;
function findProjectEntry(projects, dirGroups, platform) {
  const keys = Object.keys(projects).filter((k) => hasTrustLevel(projects[k]));
  for (let g = 0; g < dirGroups.length; g++) {
    for (const dir of dirGroups[g]) {
      const key = strictKey(dir, platform);
      if (keys.includes(key)) return [key, projects[key], g];
      const match = keys.filter((k) => strictKey(k, platform) === key).sort()[0];
      if (match !== undefined) return [match, projects[match], g];
    }
  }
  return null;
}

// The spelling Codex would see for `dir` when started from `given`: the
// ancestor of `given` that is the same directory (Codex walks up from the
// directory it starts in), or null when `dir` is not one of its ancestors.
function givenSpellingOf(dir, given) {
  for (let d = given; ; d = path.dirname(d)) {
    if (sameDir(d, dir)) return d;
    if (path.dirname(d) === d) return null;
  }
}

const MAX_READ_BYTES = 1024 * 1024;
function readCapped(file) {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
  if (stat.size > MAX_READ_BYTES) throw Object.assign(new Error('too large'), { code: 'ETOOBIG' });
  return fs.readFileSync(file, 'utf8');
}
function readProblem(error) {
  if (error.code === 'ENOENT') return 'no such file';
  if (error.code === 'EISDIR') return 'it is a directory';
  if (error.code === 'ETOOBIG') return `larger than ${MAX_READ_BYTES / 1024 / 1024} MB, not read`;
  return error.code || error.name;
}
// The kind and position of a JSON syntax error - never the text around it.
function jsonProblem(error) {
  const m = /at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(String(error.message));
  if (!m) return error.name;
  return m[2] ? `${error.name} at line ${m[2]} column ${m[3]}` : `${error.name} at position ${m[1]}`;
}
function tomlProblem(error) {
  const first = String(error.message).split('\n')[0].replace(/:$/, '');
  const mixed = /Inline lists must be a single type/.test(first)
    ? ' - TOML 1.0 allows arrays of mixed types, but this check reads TOML 0.5 and stops here (the safe side); confirm in /hooks instead'
    : '';
  return `${first}${mixed}`;
}

const isUintOrNull = (v) => v === undefined || v === null || isUint(v);
const isStringOrNull = (v) => v === undefined || v === null || typeof v === 'string';
const HANDLER_TYPES = new Set(['command', 'mcp_tool', 'prompt', 'agent']);
const label = (s) => JSON.stringify(String(s).slice(0, 40));

// What makes Codex reject the whole hooks.json (serde: HooksFile and the
// types under it), and the notes for what it ignores.
function hooksFileProblems(file) {
  const fatal = [];
  const notes = [];
  if (!isPlainObject(file)) return { fatal: ['its top level is not an object'], notes };
  for (const key of Object.keys(file)) {
    if (key !== 'description' && key !== 'hooks') fatal.push(`unknown top-level key ${label(key)} (only "description" and "hooks" are allowed)`);
  }
  if (!isStringOrNull(file.description)) fatal.push('"description" is not a string');
  if (file.hooks === undefined) return { fatal, notes };
  if (!isPlainObject(file.hooks)) return { fatal: [...fatal, '"hooks" is not an object'], notes };
  for (const [eventName, groups] of Object.entries(file.hooks)) {
    if (!EVENTS[eventName]) {
      notes.push(`unknown event ${label(eventName)} in hooks.json: Codex ignores it, so its hooks never run.`);
      continue;
    }
    if (!Array.isArray(groups)) {
      fatal.push(`${eventName} is not an array`);
      continue;
    }
    groups.forEach((group, g) => {
      const where = `${eventName}[${g}]`;
      if (!isPlainObject(group)) return fatal.push(`${where} is not an object`);
      if (!isStringOrNull(group.matcher)) fatal.push(`${where}.matcher is not a string`);
      if (group.hooks === undefined) return undefined;
      if (!Array.isArray(group.hooks)) return fatal.push(`${where}.hooks is not an array`);
      group.hooks.forEach((h, i) => {
        const problem = handlerProblem(h);
        if (problem) fatal.push(`${where}.hooks[${i}] ${problem}`);
      });
      return undefined;
    });
  }
  return { fatal, notes };
}

function handlerProblem(h) {
  if (!isPlainObject(h)) return 'is not an object';
  if (!HANDLER_TYPES.has(h.type)) return `has an unknown type ${label(h.type)}`;
  if (h.type === 'command') {
    if (typeof h.command !== 'string') return 'has no string "command"';
    if (!isStringOrNull(h.commandWindows) || !isStringOrNull(h.command_windows)) return 'has a "commandWindows" that is not a string';
    if (h.async !== undefined && typeof h.async !== 'boolean') return 'has an "async" that is not true or false';
    if (!isUintOrNull(h.additionalContextLimit)) return 'has an "additionalContextLimit" that is not a whole number';
  } else if (h.type === 'mcp_tool') {
    if (typeof h.server !== 'string' || typeof h.tool !== 'string') return 'has no string "server" and "tool"';
    if (h.input !== undefined && !isPlainObject(h.input)) return 'has an "input" that is not an object';
  }
  if (!isUintOrNull(h.timeout)) return 'has a "timeout" that is not a whole number';
  if (!isStringOrNull(h.statusMessage)) return 'has a "statusMessage" that is not a string';
  return null;
}

const HOOK_KEY_RE = /^(.*):([a-z_]+):(\d+):(\d+)$/;

function checkCodexTrust({ projectDir = process.cwd(), codexHome, env = process.env, platform = process.platform } = {}) {
  const lines = [];
  const home = resolveCodexHome({ codexHome, env, platform });
  const unreadable = (what, file, problem) => {
    lines.push(`UNREADABLE: could not read ${what}: ${file}${problem ? ` (${problem})` : ''}`);
    return { exitCode: 2, lines, configPath: home.dir ? path.join(home.dir, 'config.toml') : null };
  };
  if (home.error) {
    lines.push(`UNREADABLE: ${home.error}. Pass the Codex config directory, or leave --codex-home out to use CODEX_HOME or ~/.codex.`);
    return { exitCode: 2, lines, configPath: null };
  }
  const configPath = path.join(home.dir, 'config.toml');
  const sourceLabel = home.source === 'default' ? '~/.codex (default)' : home.source;
  lines.push(`Codex config read: ${configPath} (from ${sourceLabel})`);
  if (home.source === 'default') {
    lines.push('note: neither --codex-home nor CODEX_HOME was given, so ~/.codex was read. If you run Codex with another config location (an orca account, for example), pass it with --codex-home <dir>. Trust is recorded per config location, so check each one you use.');
  }
  let config;
  try {
    config = toml.parse(readCapped(configPath).replace(/^﻿/, ''));
  } catch (error) {
    return unreadable('the Codex config', configPath, error.code ? readProblem(error) : tomlProblem(error));
  }

  const project = path.resolve(projectDir);
  lines.push(`Project: ${project}`);
  const { toplevel, mainRoot } = gitLayout(project);
  // A linked worktree: Codex reads the main checkout's matching hooks.json.
  const linked = toplevel && mainRoot && !sameDir(toplevel, mainRoot);
  let hooksPath = path.join(project, '.codex', 'hooks.json');
  if (linked) {
    const relative = path.relative(spellings(toplevel)[0], spellings(project)[0]);
    if (!isOutside(relative) && !path.isAbsolute(relative)) {
      hooksPath = path.join(mainRoot, relative, '.codex', 'hooks.json');
    }
  }
  let hooksText;
  try {
    hooksText = readCapped(hooksPath);
  } catch (error) {
    return unreadable('the project hooks', hooksPath, readProblem(error));
  }
  let hooksFile;
  try {
    hooksFile = JSON.parse(hooksText.replace(/^﻿/, ''));
  } catch (error) {
    return unreadable('the project hooks', hooksPath, jsonProblem(error));
  }

  let actionRequired = false;
  const action = (message) => {
    actionRequired = true;
    lines.push(`ACTION REQUIRED: ${message}`);
  };
  const finish = () => {
    lines.push(actionRequired ? 'Result: ACTION REQUIRED' : 'Result: ok');
    return { exitCode: actionRequired ? 1 : 0, lines, configPath };
  };

  // Project trust: Codex reads the project's .codex/ only for a trusted project.
  const projects = isPlainObject(config.projects) ? config.projects : {};
  const dirs = [project, toplevel, mainRoot].filter(Boolean);
  const dirGroups = dirs.map(spellings);
  const projectEntry = findProjectEntry(projects, dirGroups, platform);
  // The directory as given (--dir, or the cwd as typed), or its ancestor
  // spelled the same way: what Codex compares when started from it.
  const given = projectEntry ? givenSpellingOf(dirs[projectEntry[2]], project) : null;
  if (!projectEntry) {
    const loose = new Set(dirGroups.flat().map((d) => looseKey(d, platform)));
    const other = Object.keys(projects).find((k) => hasTrustLevel(projects[k]) && loose.has(looseKey(k, platform)));
    if (other !== undefined) {
      action(`the project is trusted only under the spelling "${other}" in ${configPath}, which Codex does not match with ${project} (it compares the path as written, case aside). Launch Codex from exactly that path, or trust the project again from the current one when Codex asks on start-up.`);
    } else {
      action(`the project is not trusted in ${configPath}, so Codex does not read its .codex/ (hooks included). Trust the project when Codex asks on start-up.`);
    }
  } else if (!isPlainObject(projectEntry[1]) || projectEntry[1].trust_level !== 'trusted') {
    const level = isPlainObject(projectEntry[1]) ? projectEntry[1].trust_level : undefined;
    action(`the project entry "${projectEntry[0]}" has trust_level ${JSON.stringify(level)}, not "trusted", so Codex does not read its .codex/ (hooks included).`);
  } else if (given !== null && strictKey(projectEntry[0], platform) !== strictKey(given, platform)) {
    action(`the project is trusted as "${projectEntry[0]}", which is spelled differently from the path given, ${given} (it was matched through the real path). Codex looks trust up by the path it is started from, so it may not match. Launch Codex from exactly "${projectEntry[0]}", or check from that path; or trust the project again when Codex asks on start-up.`);
  } else {
    lines.push(`project trust: trusted ("${projectEntry[0]}")`);
  }

  lines.push(`Hooks: ${hooksPath}`);
  if (linked) {
    lines.push(`note: ${project} is in a linked git worktree, so Codex reads the main checkout's hooks.json above (not the worktree's own) and records their trust under that path.`);
    if (!fs.existsSync(path.join(project, '.codex'))) {
      action(`${path.join(project, '.codex')} does not exist in this worktree; Codex loads project hooks only for a directory that has .codex/, so none run here.`);
      return finish();
    }
  }
  if (hooksText.startsWith('﻿')) {
    action(`${hooksPath} starts with a byte order mark (BOM). Codex cannot parse it, so none of its hooks run. Save it as UTF-8 without a BOM.`);
    return finish();
  }
  const { fatal, notes } = hooksFileProblems(hooksFile);
  for (const note of notes) lines.push(`note: ${note}`);
  if (fatal.length) {
    action(`Codex cannot load ${hooksPath} (${fatal.join('; ')}), so none of its hooks run. Fix the file, then trust the hooks in /hooks.`);
    return finish();
  }

  // Hook trust, per handler. Codex compares the key exactly.
  const hooks = isPlainObject(hooksFile.hooks) ? hooksFile.hooks : {};
  const states = isPlainObject(config.hooks) && isPlainObject(config.hooks.state) ? config.hooks.state : {};
  const hookPaths = spellings(hooksPath);
  // Codex keys hook trust by the path as spelled from the directory it starts
  // in, so only the given spelling counts; in a linked worktree that path
  // comes from git, and its real path counts too.
  const keyPaths = linked ? hookPaths : [hooksPath];
  const hookPathKeys = hookPaths.map((p) => looseKey(p, platform));
  const stateEntries = Object.entries(states).map(([key, value]) => {
    const m = HOOK_KEY_RE.exec(key);
    return m ? { key, path: m[1], event: m[2], group: Number(m[3]), handler: Number(m[4]), value } : null;
  }).filter((e) => e && hookPathKeys.includes(looseKey(e.path, platform)));

  let count = 0;
  const notTrusted = [];
  const stale = [];
  const otherSpelling = [];
  const unconfirmed = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    const event = EVENTS[eventName];
    if (!event || !Array.isArray(groups)) continue;
    groups.forEach((group, g) => {
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      handlers.forEach((handler, h) => {
        count++;
        const id = `${event.label}:${g}:${h}`;
        const what = `${id} (matcher ${JSON.stringify(group.matcher === undefined ? null : group.matcher)}${hookScript(handler)})`;
        const matches = stateEntries.filter((e) => e.event === event.label && e.group === g && e.handler === h);
        const entry = matches.find((e) => keyPaths.includes(e.path));
        if (!entry) {
          if (matches.length) otherSpelling.push(`${what} as "${matches[0].path}"`);
          else notTrusted.push(what);
          return;
        }
        if (isPlainObject(entry.value) && entry.value.enabled === false) {
          action(`Codex hook ${what} is disabled in ${configPath}. Enable it in /hooks.`);
          return;
        }
        if (!isPlainObject(entry.value) || typeof entry.value.trusted_hash !== 'string') {
          notTrusted.push(what);
          return;
        }
        const expected = codexHookHash(eventName, group.matcher, handler, { platform });
        if (expected === null) unconfirmed.push(what);
        else if (expected !== entry.value.trusted_hash) stale.push(what);
        else lines.push(`trusted: ${what}`);
      });
    });
  }
  if (count === 0) lines.push('(no hooks registered in this hooks.json)');
  if (notTrusted.length) {
    action(`Codex hooks are not trusted: ${notTrusted.join(', ')}. Codex skips them without a warning. Open /hooks in Codex in this project and trust them.`);
  }
  if (otherSpelling.length) {
    action(`Codex hooks are trusted only under another spelling of the path: ${otherSpelling.join(', ')}. Codex compares this key exactly, so they do not run when Codex starts from ${path.dirname(path.dirname(hooksPath))}. Launch Codex from exactly the recorded path, or open /hooks from the current one and trust them again.`);
  }
  if (stale.length) {
    action(`Codex hooks changed since trusted (stale trust): ${stale.join(', ')}. Codex skips them until they are trusted again. Open /hooks in Codex in this project and trust them again. (The hash is computed the way Codex 0.156.1 does; if /hooks already shows them trusted, your Codex version hashes differently - go by /hooks.)`);
  }
  if (unconfirmed.length) {
    action(`Codex hooks have a trusted entry, but this check cannot compute their hash the way Codex does (not a command hook), so whether the trust is current cannot be confirmed: ${unconfirmed.join(', ')}. Check them in /hooks.`);
  }
  return finish();
}

function hookScript(handler) {
  const command = isPlainObject(handler) && typeof handler.command === 'string' ? handler.command : '';
  const m = /([A-Za-z0-9._-]+\.cjs)/.exec(command);
  return m ? `, ${m[1]}` : '';
}

// A relative path escapes its base only when it is `..` or starts with a `..` segment (`..cache` is a name).
function isOutside(rel) {
  return rel === '..' || rel.startsWith(`..${path.sep}`);
}

module.exports = { isOutside, checkCodexTrust, codexHookHash, resolveCodexHome };
