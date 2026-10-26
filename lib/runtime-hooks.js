'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REVIEW_MATCHER = '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent)$';
// Claude Code's SendMessage reaches an existing reviewer. Codex has no such tool, and changing its matcher would void the hook trust.
const reviewMatcher = (tool) => (tool === 'claude' ? REVIEW_MATCHER.replace('resume_agent)', 'resume_agent|SendMessage)') : REVIEW_MATCHER);
// Claude Code runs shell commands through Bash and PowerShell tools; the gate reads both. Codex keeps 'Bash': changing its matcher would void the hook trust.
const gateMatcher = (tool) => (tool === 'claude' ? '^(Bash|PowerShell)$' : 'Bash');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configFile(projectDir, tool) {
  if (!['codex', 'claude'].includes(tool)) throw new Error(`Unknown hook tool: ${tool}`);
  return path.join(projectDir, `.${tool}`, tool === 'codex' ? 'hooks.json' : 'settings.json');
}

function hookCommand(tool, script) {
  if (!['codex', 'claude'].includes(tool)) throw new Error(`Unknown hook tool: ${tool}`);
  const file = String(script).replace(/\\/g, '/').replace(/^\.?(?:codex|claude)\/hooks\//, '');
  if (!/^[A-Za-z0-9._-]+\.cjs$/.test(file)) throw new Error(`Unsafe hook script: ${script}`);
  return tool === 'claude' ? claudeWrapper(file) : gitWrapper(tool, file);
}

// The 3.3.0 wrapper, kept byte-identical for Codex: a changed hooks.json command voids Codex's hook trust.
// It fails open (exit 1) when git is missing or hangs; harness-runtime.md records that as a residual risk.
function gitWrapper(tool, file) {
  return gitWrapperAt(`'.${tool}','hooks','${file}'`);
}
function gitWrapperAt(joinArgs) {
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,${joinArgs})],{stdio:'inherit'});process.exit(child.status??1)`;
  return `node -e "${source}"`;
}

// 3.7.0 (C3h): a product may run its own gate or review-budget instead of the distributed one - `gate.script` and
// `reviewBudgetScript` in .ai-dev-helm.json (platform). The declared file is registered in the same wrapper (found
// under CLAUDE_PROJECT_DIR, then the git root), the distributed body is not copied, and a registration that runs the
// declared file counts as the managed registration of that hook. A path is relative to the repository root, in
// POSIX form, with plain segments only (it is written into the wrapper source).
const DECLARED_KEYS = { 'quality-gate.cjs': 'gate.script', 'review-budget.cjs': 'reviewBudgetScript' };
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const SCRIPT_EXT_RE = /\.(?:cjs|mjs|js)$/;
function declaredPathError(value) {
  if (typeof value !== 'string' || !value) return 'is not a non-empty string';
  const segments = value.replace(/^\.\//, '').split('/');
  if (segments.some((s) => !SAFE_SEGMENT_RE.test(s) || s === '.' || s === '..')) return 'is not a relative POSIX path of plain segments (letters, digits, . _ -)';
  if (!SCRIPT_EXT_RE.test(value)) return 'does not name a .cjs, .mjs or .js file';
  return null;
}
/**
 * The hooks a manifest declares: { declared: { 'quality-gate.cjs': 'scripts/x.mjs', ... }, errors: [] }.
 * `manifest` is the parsed .ai-dev-helm.json (or null).
 */
function declaredHooks(manifest) {
  const declared = {};
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { declared, errors };
  if (manifest.gate !== undefined && !isPlainObject(manifest.gate)) errors.push('gate is not an object');
  const values = {
    'quality-gate.cjs': isPlainObject(manifest.gate) ? manifest.gate.script : undefined,
    'review-budget.cjs': manifest.reviewBudgetScript,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const why = declaredPathError(value);
    if (why) errors.push(`${DECLARED_KEYS[name]} "${value}" ${why}`);
    else declared[name] = value.replace(/^\.\//, '');
  }
  return { declared, errors };
}
function readManifestDeclarations(projectDir) {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(projectDir, '.ai-dev-helm.json'), 'utf8')); } catch { return { declared: {}, errors: [] }; }
  return declaredHooks(manifest);
}
const joinArgsOf = (rel) => rel.split('/').map((s) => `'${s}'`).join(',');
/** The registration command of a declared hook file (`name` is the hook it replaces). */
function declaredCommand(tool, name, rel) {
  if (!['codex', 'claude'].includes(tool)) throw new Error(`Unknown hook tool: ${tool}`);
  const why = declaredPathError(rel);
  if (why) throw new Error(`Unsafe declared hook script: ${rel} ${why}`);
  if (tool === 'codex') return gitWrapperAt(joinArgsOf(rel));
  const notice = `ai-dev-helm: ${rel} (${DECLARED_KEYS[name]} in .ai-dev-helm.json) was not found under CLAUDE_PROJECT_DIR or the git root, so this hook is not running. Restore the file, or remove the declaration and run npx @crearize/ai-dev-helm upgrade.`;
  return claudeWrapperAt(joinArgsOf(rel), notice);
}

// Claude Code: find the hook under CLAUDE_PROJECT_DIR first, then under the git root (5 s timeout), so a missing or
// hanging git still reaches the hook body and its own fail-closed checks. A signal-killed hook exits 2 (block).
// With no hook file anywhere, the call goes through (exit 0) with a notice: exit 2 would block every Bash /
// PowerShell / Agent call with no way back for the agent. The source must stay free of double quotes.
// 3.7.0: when CLAUDE_PROJECT_DIR is set and has no hook, the git root's copy runs only when it is the root of
// CLAUDE_PROJECT_DIR's own repository (CLAUDE_PROJECT_DIR itself, or a directory inside that repository) - never
// another repository's hook (a session that moved into a sibling repository).
const sameRootSource = `const real=(x)=>{let v;try{v=fs.realpathSync(x)}catch{v=p.resolve(x)}return process.platform==='win32'?v.toLowerCase():v};` +
  `const same=(r,d)=>{if(real(r)===real(d))return true;try{return real(execFileSync('git',['-C',d,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim())===real(r)}catch{return false}};`;
function claudeWrapper(file) {
  const notice = `ai-dev-helm: .claude/hooks/${file} was not found under CLAUDE_PROJECT_DIR or the git root, so this hook is not running. Restore it with npx @crearize/ai-dev-helm upgrade.`;
  return claudeWrapperAt(`'.claude','hooks','${file}'`, notice);
}

// The same wrapper for any path below the repository root: `joinArgs` is the p.join argument list after the root.
function claudeWrapperAt(joinArgs, notice) {
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');` + sameRootSource +
    `const find=(r)=>{const s=p.join(r,${joinArgs});return fs.existsSync(s)?s:''};` +
    `const d=process.env.CLAUDE_PROJECT_DIR;let s=d?find(d):'';` +
    `let g='';if(!s)try{const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();if(!d||same(r,d))s=find(r);else g=' (the git root '+r+' is another repository than CLAUDE_PROJECT_DIR, so its hook is not run)'}catch{g=' (git could not find the repository root, so the hook may exist but was not located)'}` +
    `if(s){const child=spawnSync(process.execPath,[s],{stdio:'inherit'});process.exit(child.status??2)}` +
    `let e;try{e=JSON.parse(fs.readFileSync(0,'utf8')).hook_event_name}catch{}` +
    `const m='${notice}'+g;const o={systemMessage:m};` +
    `if(['PreToolUse','PostToolUse'].includes(e))o.hookSpecificOutput={hookEventName:e,additionalContext:m};` +
    `process.stdout.write(JSON.stringify(o))`;
  return `node -e "${source}"`;
}

// The Claude wrapper as shipped in 3.4.1-3.6.0, kept byte-identical so a re-run replaces it instead of running both.
function claudeWrapper341(file) {
  const notice = `ai-dev-helm: .claude/hooks/${file} was not found under CLAUDE_PROJECT_DIR or the git root, so this hook is not running. Reinstall it with npx @crearize/ai-dev-helm init.`;
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');` +
    `const find=(r)=>{const s=p.join(r,'.claude','hooks','${file}');return fs.existsSync(s)?s:''};` +
    `let s=process.env.CLAUDE_PROJECT_DIR?find(process.env.CLAUDE_PROJECT_DIR):'';` +
    `let g='';if(!s)try{s=find(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim())}catch{g=' (git could not find the repository root, so the hook may exist but was not located)'}` +
    `if(s){const child=spawnSync(process.execPath,[s],{stdio:'inherit'});process.exit(child.status??2)}` +
    `let e;try{e=JSON.parse(fs.readFileSync(0,'utf8')).hook_event_name}catch{}` +
    `const m='${notice}'+g;const o={systemMessage:m};` +
    `if(['PreToolUse','PostToolUse'].includes(e))o.hookSpecificOutput={hookEventName:e,additionalContext:m};` +
    `process.stdout.write(JSON.stringify(o))`;
  return `node -e "${source}"`;
}

// context-handoff saves and restores a record around /compact and /clear. It never blocks, so its Claude wrapper
// fails open: a missing or crashed hook exits 0 (exit 2 would stop compaction on PreCompact and keep the turn
// going on Stop). A missing hook is reported once per SessionStart. The source must stay free of double quotes.
// Removal matches this exact command: a release that changes the wrapper text must also remove the old text (as
// oldGateCommands / gitWrapper do for the gate), or both registrations would run.
const HANDOFF_FILE = 'context-handoff.cjs';
const HANDOFF_EVENTS = [
  { event: 'PreCompact', timeout: 60 },
  { event: 'SessionStart', matcher: 'compact|clear', timeout: 60 },
  // SessionEnd hooks share a 1.5 s budget unless a hook sets a longer timeout.
  { event: 'SessionEnd', matcher: 'clear', timeout: 30 },
  { event: 'Stop', timeout: 10 },
];
// 3.7.1 (D5): Codex gets context-handoff on three events (its SessionEnd cannot tell /clear apart; Stop marks the
// latest session instead). The registration is the 3.3.0 git wrapper (gitWrapper) with these matchers and timeouts,
// and must never change: Codex trusts a hook by a hash of its registration. A missing body or git makes the wrapper
// exit 1, which Codex reports as a failed hook and does not act on (only a Stop hook's exit 2 continues the turn).
// Each one is appended at the end of its event's array, so the trust keys (event:group:handler) of the hooks
// already there do not move.
const CODEX_HANDOFF_EVENTS = [
  { event: 'PreCompact', timeout: 60 },
  { event: 'SessionStart', matcher: 'compact|clear', timeout: 60 },
  { event: 'Stop', timeout: 10 },
];

function handoffCommand() {
  const notice = `ai-dev-helm: .claude/hooks/${HANDOFF_FILE} was not found under CLAUDE_PROJECT_DIR or the git root, so the conversation record is not kept across /compact and /clear. Restore it with npx @crearize/ai-dev-helm upgrade.`;
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');` + sameRootSource +
    `const find=(r)=>{const s=p.join(r,'.claude','hooks','${HANDOFF_FILE}');return fs.existsSync(s)?s:''};` +
    `const d=process.env.CLAUDE_PROJECT_DIR;let s=d?find(d):'';` +
    `if(!s)try{const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();if(!d||same(r,d))s=find(r)}catch{}` +
    `if(s){spawnSync(process.execPath,[s],{stdio:'inherit'});process.exit(0)}` +
    `let e;try{e=JSON.parse(fs.readFileSync(0,'utf8')).hook_event_name}catch{}` +
    `if(e==='SessionStart')process.stdout.write(JSON.stringify({systemMessage:'${notice}'}));` +
    `process.exit(0)`;
  return `node -e "${source}"`;
}

// The context-handoff command as shipped in 3.5.0-3.6.0, kept byte-identical for its removal on re-run.
function handoffCommand350() {
  const notice = `ai-dev-helm: .claude/hooks/${HANDOFF_FILE} was not found under CLAUDE_PROJECT_DIR or the git root, so the conversation record is not kept across /compact and /clear. Reinstall it with npx @crearize/ai-dev-helm init.`;
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');` +
    `const find=(r)=>{const s=p.join(r,'.claude','hooks','${HANDOFF_FILE}');return fs.existsSync(s)?s:''};` +
    `let s=process.env.CLAUDE_PROJECT_DIR?find(process.env.CLAUDE_PROJECT_DIR):'';` +
    `if(!s)try{s=find(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim())}catch{}` +
    `if(s){spawnSync(process.execPath,[s],{stdio:'inherit'});process.exit(0)}` +
    `let e;try{e=JSON.parse(fs.readFileSync(0,'utf8')).hook_event_name}catch{}` +
    `if(e==='SessionStart')process.stdout.write(JSON.stringify({systemMessage:'${notice}'}));` +
    `process.exit(0)`;
  return `node -e "${source}"`;
}

function oldGateCommands(tool) {
  const relative = `.${tool}/hooks/quality-gate.cjs`;
  return new Set([`node ${relative}`, `node "${relative}"`, `node '${relative}'`]);
}

function eventArrayIsValid(entries) {
  return Array.isArray(entries) && entries.every((entry) =>
    isPlainObject(entry) && Array.isArray(entry.hooks) && entry.hooks.every(isPlainObject)
  );
}

function validateConfig(value, tool) {
  if (!isPlainObject(value)) return 'the JSON root is not an object';
  if (value.hooks !== undefined && !isPlainObject(value.hooks)) return 'the hooks field is not an object';
  if (!value.hooks) return null;
  // The events the harness registers on; other events are not checked (an odd SessionEnd in Codex does not block it).
  const handoff = (tool === 'claude' ? HANDOFF_EVENTS : CODEX_HANDOFF_EVENTS).map((item) => item.event);
  const events = ['PreToolUse', 'PostToolUse', ...handoff];
  for (const event of events) {
    if (value.hooks[event] !== undefined && !eventArrayIsValid(value.hooks[event])) {
      return `hooks.${event} is not a valid hook event array`;
    }
  }
  return null;
}

function backup(file) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  fs.copyFileSync(file, `${file}.backup.${timestamp}`);
}

// 3.7.0 (C3e): the hook a registration runs, read from the command instead of comparing whole strings - a wrapper
// (`node -e "..."` whose source joins '.claude','hooks','<file>') or a direct `node [options] <path>/.claude/hooks/<file>
// [args]` (the path may be quoted, or start with "$CLAUDE_PROJECT_DIR"). Only a command that is nothing but that call
// counts: one chained with |, &, ;, <, > (`... || exit 0`, `... && node other.cjs`) is a product's own registration and
// is left alone. A command that only mentions the file (echo, cat, a comment) is not a call either.
// Returns { dir: 'claude' | 'codex', file } or null. With `declared` (declaredHooks(...).declared, C3h), a command
// that runs a declared file returns { dir: 'declared', file: <the hook it replaces>, path: <the declared path> }.
const WRAPPER_RE = /^\s*node(?:\.exe)?\s+-e\s+"([^"]*)"\s*$/;
const WRAPPER_CALL_RE = /p\.join\(\w+,'\.(claude|codex)','hooks','([A-Za-z0-9._-]+\.(?:cjs|mjs|js))'\)/;
const WRAPPER_JOIN_RE = /p\.join\(\w+,((?:'[A-Za-z0-9._-]+',)*'[A-Za-z0-9._-]+')\)/;
const WORD = `(?:"[^"]*"|'[^']*'|[^\\s"'|&;<>])+`;
const DIRECT_RE = new RegExp(`^\\s*(?:"[^"]*node(?:\\.exe)?"|'[^']*node(?:\\.exe)?'|(?:[^\\s"'|&;<>]*[\\\\/])?node(?:\\.exe)?)((?:\\s+-[^\\s"'|&;<>]+)*)\\s+(${WORD})((?:\\s+${WORD})*)\\s*$`);
const HOOK_PATH_RE = /(?:^|[\\/])\.(claude|codex)[\\/]hooks[\\/]([A-Za-z0-9._-]+\.(?:cjs|mjs|js))$/;
function declaredRole(rel, declared) {
  if (!declared) return null;
  const want = rel.replace(/\\/g, '/').replace(/^(?:\$\{?CLAUDE_PROJECT_DIR\}?\/|\.\/)/, '');
  for (const [file, value] of Object.entries(declared)) {
    if (want === value || want.endsWith(`/${value}`)) return { dir: 'declared', file, path: value };
  }
  return null;
}
function calledHook(command, declared = null) {
  if (typeof command !== 'string') return null;
  const wrapper = WRAPPER_RE.exec(command);
  if (wrapper) {
    const wrapped = WRAPPER_CALL_RE.exec(wrapper[1]);
    if (wrapped) return { dir: wrapped[1], file: wrapped[2] };
    const joined = declared ? WRAPPER_JOIN_RE.exec(wrapper[1]) : null;
    return joined ? declaredRole(joined[1].replace(/'/g, '').split(',').join('/'), declared) : null;
  }
  const direct = DIRECT_RE.exec(command);
  if (!direct) return null;
  const target = HOOK_PATH_RE.exec(direct[2].replace(/["']/g, ''));
  if (target) return { dir: target[1], file: target[2] };
  return declaredRole(direct[2].replace(/["']/g, ''), declared);
}
/** The file a called hook runs, relative to the repository root. */
const calledPath = (called) => (called.dir === 'declared' ? called.path : `.${called.dir}/hooks/${called.file}`);

/**
 * 3.7.0 (C3h, cycle 1): the distributed hook copies (`.claude/hooks/<f>`, `.codex/hooks/<f>`) a registration in
 * `jsons` ({ claude, codex } parsed settings / hooks.json) still runs. With gate.script / reviewBudgetScript declared,
 * such a copy is still a hook body to update and verify - Codex registrations are left as they are, so one may keep
 * running the distributed copy next to the declared file. `skip` leaves out a tool whose registrations upgrade
 * replaces with the declared file.
 */
function distributedCopiesCalled(jsons, declared = null, skip = []) {
  const out = new Set();
  for (const [tool, json] of Object.entries(jsons || {})) {
    if (skip.includes(tool) || !json || !json.hooks || typeof json.hooks !== 'object') continue;
    for (const entries of Object.values(json.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) for (const hook of (entry && Array.isArray(entry.hooks) ? entry.hooks : [])) {
        const called = calledHook(hook && hook.command, declared);
        if (called && called.dir !== 'declared') out.add(calledPath(called));
      }
    }
  }
  return out;
}

// Whether a hook-event matcher reaches tool calls named `tool` (unset, empty and "*" reach every tool).
function matcherReaches(matcher, tool) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  try { return new RegExp(matcher).test(tool); } catch { return matcher === tool; }
}

const KNOWN_KEYS = new Set(['type', 'command', 'timeout']);
// Removes the registrations that run one of `files` (or are one of `commands`). Keys an adopter added to a removed
// registration (statusMessage ...) are collected per file in `extras` so the replacement keeps them (MasterPlan);
// the template's placeholder registration is not a source of them. `replaced` collects commands that were neither
// the current nor a released form (hand-edited registrations).
function removeManagedHooks(entries, commands, { files = new Set(), keep = new Set(), extras = {}, known = null, replaced = [], placeholder = new Set(), declared = null } = {}) {
  const result = [];
  for (const entry of entries) {
    const hooks = entry.hooks.filter((hook) => {
      const called = calledHook(hook.command, declared);
      const managed = commands.has(hook.command) || Boolean(called && files.has(called.file));
      if (!managed || (called && keep.has(called.file))) return true;
      const file = called ? called.file : null;
      if (file && !placeholder.has(hook.command)) {
        for (const [key, value] of Object.entries(hook)) {
          if (!KNOWN_KEYS.has(key) && !(extras[file] && key in extras[file])) (extras[file] ||= {})[key] = value;
        }
      }
      if (known && !known.has(hook.command) && !placeholder.has(hook.command)) replaced.push(hook.command);
      return false;
    });
    if (hooks.length) result.push({ ...entry, hooks });
  }
  return result;
}

/**
 * Registers the harness hooks in .claude/settings.json or .codex/hooks.json. Options (3.7.0, for `upgrade`):
 * copyScripts (copy review-budget/context-handoff bodies; default true), keep (hook files whose registrations stay
 * as they are - a conflicted hook body keeps its registration), backup (back the file up before rewriting; default
 * true), report (receives { replaced: [commands] }), declared (declaredHooks(...).declared - read from the
 * project's .ai-dev-helm.json when not given; `upgrade` passes it for its scratch copy).
 */
function setupRuntimeHooks(projectDir, tool, { dryRun = false, copyScripts = true, keep = new Set(), backup: takeBackup = true, report = {}, preserveCodex = false, declared: given } = {}) {
  const file = configFile(projectDir, tool);
  const warnings = [];
  let declared = given;
  if (declared === undefined) {
    const read = readManifestDeclarations(projectDir);
    if (read.errors.length) {
      warnings.push(`ACTION REQUIRED: .ai-dev-helm.json: ${read.errors.join('; ')}; runtime review hooks were not changed.`);
      return warnings;
    }
    declared = read.declared;
  }
  declared = declared || {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    warnings.push(`ACTION REQUIRED: ${file} could not be read as JSON; runtime review hooks were not changed.`);
    return warnings;
  }
  const invalid = validateConfig(parsed, tool);
  if (invalid) {
    warnings.push(`ACTION REQUIRED: ${file} ${invalid}; runtime review hooks were not changed.`);
    return warnings;
  }

  // A declared hook (C3h) is registered from its declaration; the distributed one is neither registered nor copied.
  const commandOf = (name) => (declared[name] ? declaredCommand(tool, name, declared[name]) : hookCommand(tool, name));
  const quality = commandOf('quality-gate.cjs');
  const review = commandOf('review-budget.cjs');
  const hooks = parsed.hooks || {};
  const next = { ...parsed, hooks: { ...hooks } };
  const replaced = [];
  if (tool === 'codex') {
    // Codex: a registration string is never rewritten (a changed hooks.json voids Codex's hook trust). Each of the
    // three registrations is added only when no registration runs that hook yet - whatever its matcher, and
    // whichever copy it runs (.codex/hooks, .claude/hooks or the declared file) - so a product's own matcher and
    // command stay (C3e).
    const runs = (entries, name) => entries.some((entry) => entry.hooks.some((hook) => {
      const called = calledHook(hook.command, declared);
      return (called && called.file === name) || hook.command === commandOf(name);
    }));
    // init replaces the 3.2.x direct command by the 3.3.0 wrapper, as before. upgrade (preserveCodex) never touches a
    // registration that already runs the gate - a product's matcher (^(Bash|shell)$) and its trust stay.
    const pre = preserveCodex ? [...(hooks.PreToolUse || [])] : removeManagedHooks(hooks.PreToolUse || [], oldGateCommands(tool));
    const post = [...(hooks.PostToolUse || [])];
    if (!runs(pre, 'quality-gate.cjs') && !keep.has('quality-gate.cjs')) pre.push({ matcher: gateMatcher(tool), hooks: [{ type: 'command', command: quality, timeout: 30 }] });
    if (!runs(pre, 'review-budget.cjs') && !keep.has('review-budget.cjs')) pre.push({ matcher: reviewMatcher(tool), hooks: [{ type: 'command', command: review, timeout: 30 }] });
    if (!runs(post, 'review-budget.cjs') && !keep.has('review-budget.cjs')) post.push({ matcher: reviewMatcher(tool), hooks: [{ type: 'command', command: review, timeout: 30 }] });
    next.hooks.PreToolUse = pre;
    next.hooks.PostToolUse = post;
    // 3.7.1 (D5): context-handoff, added only to an event no registration of which runs it yet - at the end of that
    // event's array (created when missing), never in between or reordered.
    if (!keep.has(HANDOFF_FILE)) {
      const handoff = hookCommand(tool, HANDOFF_FILE);
      for (const { event, matcher, timeout } of CODEX_HANDOFF_EVENTS) {
        const entries = hooks[event] || [];
        if (runs(entries, HANDOFF_FILE)) continue;
        next.hooks[event] = [...entries, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: handoff, timeout }] }];
      }
    }
  } else {
    // Claude Code: every registration that runs a harness hook - any released wrapper, a hand-edited one, a direct
    // path - is removed and the current one added once, so a changed wrapper text never leaves two (C3e).
    const legacy = [gitWrapper(tool, 'quality-gate.cjs'), gitWrapper(tool, 'review-budget.cjs'),
      claudeWrapper341('quality-gate.cjs'), claudeWrapper341('review-budget.cjs')];
    const known = new Set([...legacy, hookCommand(tool, 'quality-gate.cjs'), hookCommand(tool, 'review-budget.cjs'), quality, review, handoffCommand(), handoffCommand350()]);
    const placeholder = oldGateCommands(tool);
    const extras = {};
    const common = { keep, extras, known, replaced, placeholder, declared };
    const pre = removeManagedHooks(hooks.PreToolUse || [], new Set([...placeholder, ...legacy, quality, review]), { ...common, files: new Set(['quality-gate.cjs', 'review-budget.cjs']) });
    const post = removeManagedHooks(hooks.PostToolUse || [], new Set([...legacy, review]), { ...common, files: new Set(['review-budget.cjs']) });
    const add = (entries, matcher, name, command, timeout) => {
      if (keep.has(name)) return;
      entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout, ...(extras[name] || {}) }] });
    };
    add(pre, gateMatcher(tool), 'quality-gate.cjs', quality, 30);
    add(pre, reviewMatcher(tool), 'review-budget.cjs', review, 30);
    add(post, reviewMatcher(tool), 'review-budget.cjs', review, 30);
    next.hooks.PreToolUse = pre;
    next.hooks.PostToolUse = post;
    const handoff = handoffCommand();
    for (const { event, matcher, timeout } of HANDOFF_EVENTS) {
      const entries = removeManagedHooks(hooks[event] || [], new Set([handoff, handoffCommand350()]), { ...common, files: new Set([HANDOFF_FILE]) });
      add(entries, matcher, HANDOFF_FILE, handoff, timeout);
      next.hooks[event] = entries;
    }
  }
  report.replaced = [...new Set(replaced)];
  const changed = JSON.stringify(parsed) !== JSON.stringify(next);
  if (dryRun) return warnings;

  if (changed) {
    if (takeBackup) backup(file);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  if (!copyScripts) return warnings;
  const scripts = ['review-budget.cjs', HANDOFF_FILE].filter((name) => !declared[name]);
  for (const script of scripts) {
    const destination = path.join(projectDir, `.${tool}`, 'hooks', script);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../templates/hooks', script), destination);
  }
  return warnings;
}

// The Claude commands earlier releases registered (3.3.0's git wrapper, 3.4.1-3.6.0's wrapper, 3.5.0-3.6.0's
// context-handoff) - what a re-run removes before adding the current ones.
const LEGACY_CLAUDE_COMMANDS = Object.freeze({
  'quality-gate.cjs': [gitWrapper('claude', 'quality-gate.cjs'), claudeWrapper341('quality-gate.cjs')],
  'review-budget.cjs': [gitWrapper('claude', 'review-budget.cjs'), claudeWrapper341('review-budget.cjs')],
  [HANDOFF_FILE]: [handoffCommand350()],
});

module.exports = { setupRuntimeHooks, hookCommand, handoffCommand, calledHook, calledPath, distributedCopiesCalled, declaredHooks, declaredCommand, matcherReaches, gateMatcher, reviewMatcher, HANDOFF_FILE, HANDOFF_EVENTS, CODEX_HANDOFF_EVENTS, LEGACY_CLAUDE_COMMANDS };
