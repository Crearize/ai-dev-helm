'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REVIEW_MATCHER = '^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent)$';

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
  const source = `const{execFileSync,spawnSync}=require('node:child_process');const p=require('node:path');const r=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const child=spawnSync(process.execPath,[p.join(r,'.${tool}','hooks','${file}')],{stdio:'inherit'});process.exit(child.status??1)`;
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
  const old = oldGateCommands(tool);
  const managed = new Set([...old, quality, review]);
  const hooks = parsed.hooks || {};
  const pre = removeManagedHooks(hooks.PreToolUse || [], managed);
  const post = removeManagedHooks(hooks.PostToolUse || [], new Set([review]));
  pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command: quality, timeout: 30 }] });
  pre.push({ matcher: REVIEW_MATCHER, hooks: [{ type: 'command', command: review, timeout: 30 }] });
  post.push({ matcher: REVIEW_MATCHER, hooks: [{ type: 'command', command: review, timeout: 30 }] });
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
