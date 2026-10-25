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
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,'.${tool}','hooks','${file}')],{stdio:'inherit'});process.exit(child.status??1)`;
  return `node -e "${source}"`;
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
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');` + sameRootSource +
    `const find=(r)=>{const s=p.join(r,'.claude','hooks','${file}');return fs.existsSync(s)?s:''};` +
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

// context-handoff (Claude Code only) saves and restores a record around /compact and /clear. It never blocks, so its
// wrapper fails open: a missing or crashed hook exits 0 (exit 2 would stop compaction on PreCompact and keep the turn
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
  // Codex gets no context-handoff, so its other events are not checked (an odd Stop there must not block its update).
  const events = tool === 'claude' ? ['PreToolUse', 'PostToolUse', ...HANDOFF_EVENTS.map((item) => item.event)] : ['PreToolUse', 'PostToolUse'];
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

// 3.7.0 (C3e): the hook a registration runs, read from the command instead of comparing whole strings - the
// wrappers' p.join(r,'.claude','hooks','<file>') form and a direct node <path>/.claude/hooks/<file> form. A command
// that only mentions the file (echo, cat, a comment) is not a call. Returns { dir: 'claude' | 'codex', file } or null.
const WRAPPER_CALL_RE = /p\.join\(\w+,'\.(claude|codex)','hooks','([A-Za-z0-9._-]+\.(?:cjs|mjs|js))'\)/;
const DIRECT_CALL_RE = /^\s*(?:"[^"]*node(?:\.exe)?"|'[^']*node(?:\.exe)?'|(?:\S*[\\/])?node(?:\.exe)?)\s+(?:"[^"]*[\\/]|'[^']*[\\/]|(?:[^"'\s]*[\\/])?)\.(claude|codex)[\\/]hooks[\\/]([A-Za-z0-9._-]+\.(?:cjs|mjs|js))["']?(?:\s|$)/;
function calledHook(command) {
  if (typeof command !== 'string') return null;
  const direct = DIRECT_CALL_RE.exec(command);
  if (direct) return { dir: direct[1], file: direct[2] };
  if (/^\s*node(?:\.exe)?\s+-e\s/.test(command)) {
    const wrapped = WRAPPER_CALL_RE.exec(command);
    if (wrapped) return { dir: wrapped[1], file: wrapped[2] };
  }
  return null;
}

const KNOWN_KEYS = new Set(['type', 'command', 'timeout']);
// Removes the registrations that run one of `files` (or are one of `commands`). Keys an adopter added to a removed
// registration (statusMessage ...) are collected per file in `extras` so the replacement keeps them (MasterPlan);
// the template's placeholder registration is not a source of them. `replaced` collects commands that were neither
// the current nor a released form (hand-edited registrations).
function removeManagedHooks(entries, commands, { files = new Set(), keep = new Set(), extras = {}, known = null, replaced = [], placeholder = new Set() } = {}) {
  const result = [];
  for (const entry of entries) {
    const hooks = entry.hooks.filter((hook) => {
      const called = calledHook(hook.command);
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
 * true), report (receives { replaced: [commands] }).
 */
function setupRuntimeHooks(projectDir, tool, { dryRun = false, copyScripts = true, keep = new Set(), backup: takeBackup = true, report = {} } = {}) {
  const file = configFile(projectDir, tool);
  const warnings = [];
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

  const quality = hookCommand(tool, 'quality-gate.cjs');
  const review = hookCommand(tool, 'review-budget.cjs');
  const hooks = parsed.hooks || {};
  const next = { ...parsed, hooks: { ...hooks } };
  const replaced = [];
  if (tool === 'codex') {
    // Codex: a registration string is never rewritten (a changed hooks.json voids Codex's hook trust). Each of the
    // three registrations is added only when no registration runs that hook yet - whatever its matcher, and
    // whichever copy it runs (.codex/hooks or .claude/hooks) - so a product's own matcher and command stay (C3e).
    const runs = (entries, name) => entries.some((entry) => entry.hooks.some((hook) => {
      const called = calledHook(hook.command);
      return (called && called.file === name) || hook.command === hookCommand('codex', name);
    }));
    // The 3.2.x direct command is replaced by the 3.3.0 wrapper, as before.
    const pre = removeManagedHooks(hooks.PreToolUse || [], oldGateCommands(tool));
    const post = [...(hooks.PostToolUse || [])];
    if (!runs(pre, 'quality-gate.cjs') && !keep.has('quality-gate.cjs')) pre.push({ matcher: gateMatcher(tool), hooks: [{ type: 'command', command: quality, timeout: 30 }] });
    if (!runs(pre, 'review-budget.cjs') && !keep.has('review-budget.cjs')) pre.push({ matcher: reviewMatcher(tool), hooks: [{ type: 'command', command: review, timeout: 30 }] });
    if (!runs(post, 'review-budget.cjs') && !keep.has('review-budget.cjs')) post.push({ matcher: reviewMatcher(tool), hooks: [{ type: 'command', command: review, timeout: 30 }] });
    next.hooks.PreToolUse = pre;
    next.hooks.PostToolUse = post;
  } else {
    // Claude Code: every registration that runs a harness hook - any released wrapper, a hand-edited one, a direct
    // path - is removed and the current one added once, so a changed wrapper text never leaves two (C3e).
    const legacy = [gitWrapper(tool, 'quality-gate.cjs'), gitWrapper(tool, 'review-budget.cjs'),
      claudeWrapper341('quality-gate.cjs'), claudeWrapper341('review-budget.cjs')];
    const known = new Set([...legacy, quality, review, handoffCommand(), handoffCommand350()]);
    const placeholder = oldGateCommands(tool);
    const extras = {};
    const common = { keep, extras, known, replaced, placeholder };
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
  const scripts = tool === 'claude' ? ['review-budget.cjs', HANDOFF_FILE] : ['review-budget.cjs'];
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

module.exports = { setupRuntimeHooks, hookCommand, handoffCommand, calledHook, gateMatcher, reviewMatcher, HANDOFF_FILE, HANDOFF_EVENTS, LEGACY_CLAUDE_COMMANDS };
