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
function claudeWrapper(file) {
  const notice = `ai-dev-helm: .claude/hooks/${file} was not found under CLAUDE_PROJECT_DIR or the git root, so this hook is not running. Reinstall it with ai-dev-helm init.`;
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const fs=require('node:fs');const p=require('node:path');` +
    `const find=(r)=>{const s=p.join(r,'.claude','hooks','${file}');return fs.existsSync(s)?s:''};` +
    `let s=process.env.CLAUDE_PROJECT_DIR?find(process.env.CLAUDE_PROJECT_DIR):'';` +
    `if(!s)try{s=find(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000}).trim())}catch{}` +
    `if(s){const child=spawnSync(process.execPath,[s],{stdio:'inherit'});process.exit(child.status??2)}` +
    `let e;try{e=JSON.parse(fs.readFileSync(0,'utf8')).hook_event_name}catch{}` +
    `const m='${notice}';const o={systemMessage:m};` +
    `if(['PreToolUse','PostToolUse'].includes(e))o.hookSpecificOutput={hookEventName:e,additionalContext:m};` +
    `process.stdout.write(JSON.stringify(o))`;
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

function validateConfig(value) {
  if (!isPlainObject(value)) return 'the JSON root is not an object';
  if (value.hooks !== undefined && !isPlainObject(value.hooks)) return 'the hooks field is not an object';
  if (!value.hooks) return null;
  for (const event of ['PreToolUse', 'PostToolUse']) {
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

function removeManagedHooks(entries, commands) {
  const result = [];
  for (const entry of entries) {
    const hooks = entry.hooks.filter((hook) => !commands.has(hook.command));
    if (hooks.length) result.push({ ...entry, hooks });
  }
  return result;
}

function setupRuntimeHooks(projectDir, tool, { dryRun = false } = {}) {
  const file = configFile(projectDir, tool);
  const warnings = [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    warnings.push(`ACTION REQUIRED: ${file} could not be read as JSON; runtime review hooks were not changed.`);
    return warnings;
  }
  const invalid = validateConfig(parsed);
  if (invalid) {
    warnings.push(`ACTION REQUIRED: ${file} ${invalid}; runtime review hooks were not changed.`);
    return warnings;
  }

  const quality = hookCommand(tool, 'quality-gate.cjs');
  const review = hookCommand(tool, 'review-budget.cjs');
  // 3.3.0's Claude wrappers are replaced in both events, so re-running init does not duplicate them.
  const legacy = tool === 'claude' ? [gitWrapper(tool, 'quality-gate.cjs'), gitWrapper(tool, 'review-budget.cjs')] : [];
  const managed = new Set([...oldGateCommands(tool), ...legacy, quality, review]);
  const hooks = parsed.hooks || {};
  const pre = removeManagedHooks(hooks.PreToolUse || [], managed);
  const post = removeManagedHooks(hooks.PostToolUse || [], new Set([...legacy, review]));
  pre.push({ matcher: gateMatcher(tool), hooks: [{ type: 'command', command: quality, timeout: 30 }] });
  pre.push({ matcher: reviewMatcher(tool), hooks: [{ type: 'command', command: review, timeout: 30 }] });
  post.push({ matcher: reviewMatcher(tool), hooks: [{ type: 'command', command: review, timeout: 30 }] });
  const next = { ...parsed, hooks: { ...hooks, PreToolUse: pre, PostToolUse: post } };
  const changed = JSON.stringify(parsed) !== JSON.stringify(next);
  if (dryRun) return warnings;

  if (changed) {
    backup(file);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  const destination = path.join(projectDir, `.${tool}`, 'hooks', 'review-budget.cjs');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../templates/hooks/review-budget.cjs'), destination);
  return warnings;
}

module.exports = { setupRuntimeHooks, hookCommand };
