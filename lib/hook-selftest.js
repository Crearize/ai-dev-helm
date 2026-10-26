'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CASES_FILE = path.join(__dirname, '..', 'templates', 'hooks', 'selftest-cases.json');
const HOOK_FILES = { 'quality-gate': 'quality-gate.cjs', 'review-budget': 'review-budget.cjs' };

function decide(stdout) {
  try {
    const out = JSON.parse(stdout);
    if (out.decision === 'block' || (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny')) return 'deny';
  } catch { /* empty or non-JSON stdout means no objection */ }
  return 'allow';
}

// A throwaway repo on a feature branch with a code commit and an origin/main ref, so the
// gates see an ordinary unreviewed feature branch (no .quality-check-passed flag).
// 3.7.1 (D6): main is one commit ahead of origin/main, so "push to main" has something to send - a declared gate that
// judges what a push sends (platform's) decides it as a real push. The distributed hook decides the same either way.
function makeScratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-hook-selftest-'));
  const g = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'app.js'), '1\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(dir, 'main.js'), '2\n');
  g('add', '.');
  g('commit', '-q', '-m', 'main ahead of origin/main');
  g('checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(dir, 'code.js'), 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'code');
  return dir;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const lf = (buf) => buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/**
 * 3.7.0 (C3e): the install itself - (1) each harness hook registered once in .claude/settings.json, (2) Codex's gate
 * and review-budget registered once and running a file that exists, (3) the hook copies equal to this release's
 * (when the product records this release), (4) multiple copies of a skill tree (skillTargets) equal to each other.
 * Replaces the products' own checks of the same things. Returns failure lines; 3.7.1 (D6): each check that passed
 * is added to `passed` ("ok install: ..."), so the output shows what was checked.
 */
function checkInstall(projectDir, passed = []) {
  const { calledHook, calledPath, declaredHooks, distributedCopiesCalled, matcherReaches, HANDOFF_EVENTS, HANDOFF_FILE } = require('./runtime-hooks');
  const failures = [];
  const manifest = readJson(path.join(projectDir, '.ai-dev-helm.json')) || {};
  // C3h: gate.script / reviewBudgetScript - the registrations of the declared file count as that hook's, and the
  // distributed copy is not compared for it.
  const { declared, errors } = declaredHooks(manifest);
  for (const error of errors) failures.push(`FAIL install: .ai-dev-helm.json ${error}`);
  const count = (json, event, name) => ((json && json.hooks && json.hooks[event]) || [])
    .flatMap((entry) => (entry && Array.isArray(entry.hooks) ? entry.hooks : []))
    .map((hook) => calledHook(hook && hook.command, declared)).filter((c) => c && c.file === name);
  // ...and under a matcher that reaches the tools it guards (a registration under "NoSuchTool" runs nothing).
  const reaching = (json, event, name, tools) => ((json && json.hooks && json.hooks[event]) || [])
    .filter((entry) => (tools.any ? tools.any.some((tool) => matcherReaches(entry && entry.matcher, tool)) : tools.every((tool) => matcherReaches(entry && entry.matcher, tool))))
    .flatMap((entry) => (entry && Array.isArray(entry.hooks) ? entry.hooks : []))
    .map((hook) => calledHook(hook && hook.command, declared)).filter((c) => c && c.file === name).length;
  const once = (label, json, event, name, tools) => {
    const n = count(json, event, name).length;
    if (n !== 1) failures.push(`FAIL install: ${label} ${event} runs ${name} ${n} time(s), expected 1`);
    else if (tools && reaching(json, event, name, tools) !== 1) failures.push(`FAIL install: ${label} ${event} ${name}: its matcher does not reach ${(tools.any || tools).join(tools.any ? ' or ' : ' and ')}`);
    else passed.push(`ok install: ${label} ${event} runs ${name} once${tools ? ` (its matcher reaches ${(tools.any || tools).join(tools.any ? ' or ' : ' and ')})` : ''}`);
  };
  const claude = readJson(path.join(projectDir, '.claude', 'settings.json'));
  if (claude) {
    once('.claude/settings.json', claude, 'PreToolUse', 'quality-gate.cjs', ['Bash', 'PowerShell']);
    once('.claude/settings.json', claude, 'PreToolUse', 'review-budget.cjs', { any: ['Agent', 'Task'] });
    once('.claude/settings.json', claude, 'PostToolUse', 'review-budget.cjs');
    for (const { event } of HANDOFF_EVENTS) once('.claude/settings.json', claude, event, HANDOFF_FILE);
  }
  const codex = readJson(path.join(projectDir, '.codex', 'hooks.json'));
  if (codex) {
    once('.codex/hooks.json', codex, 'PreToolUse', 'quality-gate.cjs', ['Bash']);
    once('.codex/hooks.json', codex, 'PreToolUse', 'review-budget.cjs', { any: ['spawn_agent', 'collaboration'] });
    once('.codex/hooks.json', codex, 'PostToolUse', 'review-budget.cjs');
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const name of ['quality-gate.cjs', 'review-budget.cjs']) {
        for (const c of count(codex, event, name)) {
          if (!fs.existsSync(path.join(projectDir, ...calledPath(c).split('/')))) failures.push(`FAIL install: .codex/hooks.json runs ${calledPath(c)}, which does not exist`);
          else passed.push(`ok install: .codex/hooks.json ${event} runs ${calledPath(c)}, which exists`);
        }
      }
    }
  }
  const copiesCalled = distributedCopiesCalled({ claude, codex }, declared);
  const version = require('../package.json').version;
  if (manifest.version === version) {
    for (const runtime of ['.claude', '.codex']) {
      for (const file of ['quality-gate.cjs', 'review-budget.cjs', HANDOFF_FILE]) {
        // A declared hook's distributed copy is compared only while a registration still runs it (cycle 1).
        if (declared[file] && !copiesCalled.has(`${runtime}/hooks/${file}`)) continue;
        const copy = path.join(projectDir, runtime, 'hooks', file);
        if (!fs.existsSync(copy)) continue;
        if (lf(fs.readFileSync(copy)) !== lf(fs.readFileSync(path.join(__dirname, '..', 'templates', 'hooks', file)))) {
          failures.push(`FAIL install: ${runtime}/hooks/${file} differs from ${version}'s copy (upgrade, or resolve the pending conflict)`);
        } else passed.push(`ok install: ${runtime}/hooks/${file} equals ${version}'s copy`);
      }
    }
  }
  const targets = manifest.skillTargets && typeof manifest.skillTargets === 'object' ? manifest.skillTargets : {};
  for (const [tree, list] of Object.entries(targets)) {
    if (!Array.isArray(list) || list.length < 2) continue;
    const listing = (root) => {
      const out = new Map();
      const walk = (d, rel) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(path.join(d, e.name), r);
          else if (e.isFile()) out.set(r, lf(fs.readFileSync(path.join(d, e.name))));
        }
      };
      walk(path.join(projectDir, root), '');
      return out;
    };
    const [first, ...rest] = list.map(listing);
    rest.forEach((other, i) => {
      const differ = [...new Set([...first.keys(), ...other.keys()])].filter((k) => first.get(k) !== other.get(k));
      if (differ.length) failures.push(`FAIL install: skill copies of "${tree}" differ between ${list[0]} and ${list[i + 1]} (${differ.slice(0, 3).join(', ')}${differ.length > 3 ? ', ...' : ''})`);
      else passed.push(`ok install: skill copies of "${tree}" are the same in ${list[0]} and ${list[i + 1]}`);
    });
  }
  return failures;
}

function runHookSelftest({ dir = process.cwd() } = {}) {
  const projectDir = path.resolve(dir);
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  const lines = [];
  let failed = 0;
  let ran = 0;
  const scratch = makeScratchRepo();
  try {
    // C3h: a hook the manifest declares (gate.script / reviewBudgetScript) gets the same decision table.
    const hooks = require('./runtime-hooks');
    const { declared } = hooks.declaredHooks(readJson(path.join(projectDir, '.ai-dev-helm.json')));
    // ...and so does a distributed copy a registration still runs next to the declared file (cycle 1).
    const copiesCalled = hooks.distributedCopiesCalled({
      claude: readJson(path.join(projectDir, '.claude', 'settings.json')),
      codex: readJson(path.join(projectDir, '.codex', 'hooks.json')),
    }, declared);
    for (const [hook, file] of Object.entries(HOOK_FILES)) {
      const copies = ['.claude', '.codex']
        .map((runtime) => ({ runtime, label: `${runtime}/hooks/${file}`, script: path.join(projectDir, runtime, 'hooks', file) }))
        .filter((c) => fs.existsSync(c.script) && (!declared[file] || copiesCalled.has(c.label)));
      const installed = declared[file]
        ? [{ runtime: declared[file], label: declared[file], script: path.join(projectDir, ...declared[file].split('/')) }, ...copies]
        : copies;
      if (!installed.length) {
        lines.push(`${hook}: not installed (.claude/hooks/${file} or .codex/hooks/${file}); skipped`);
        continue;
      }
      if (declared[file] && !fs.existsSync(installed[0].script)) {
        lines.push(`FAIL ${declared[file]}: declared in .ai-dev-helm.json (${hook === 'quality-gate' ? 'gate.script' : 'reviewBudgetScript'}) but not found`);
        failed += 1;
        ran += 1;
        continue;
      }
      for (const { runtime, label, script } of installed) {
        let bad = 0;
        // 3.7.1 (D6): a case may also accept another decision from a declared file (`declaredAlso`): an unreadable
        // payload is fail-open in the distributed hook, and fail-closed is the safer side for a product's own gate.
        const isDeclared = Boolean(declared[file]) && label === declared[file];
        for (const c of cases[hook]) {
          const input = c.raw !== undefined ? c.raw : JSON.stringify({ cwd: scratch, hook_event_name: 'PreToolUse', ...(c.event || { tool_name: 'Bash', tool_input: { command: c.command } }) });
          const run = spawnSync(process.execPath, [script], { cwd: scratch, input, encoding: 'utf8', timeout: 30000 });
          const got = decide(run.stdout || '');
          ran += 1;
          if (got !== c.expect && !(isDeclared && c.declaredAlso === got)) {
            bad += 1;
            lines.push(`FAIL ${runtime}/${hook}: ${c.name} (expected ${c.expect}, got ${got}${run.error ? `; ${run.error.message}` : ''})`);
          }
        }
        failed += bad;
        lines.push(`${label}: ${cases[hook].length - bad}/${cases[hook].length} cases passed`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!ran) {
    lines.push(`ACTION REQUIRED: no installed hook found; run \`npx -y @crearize/ai-dev-helm@${require('../package.json').version} init\` (or harness-upgrade) first.`);
    return { lines, exitCode: 1, failed, ran };
  }
  const passed = [];
  const install = checkInstall(projectDir, passed);
  lines.push(...passed, ...install);
  failed += install.length;
  lines.push(failed ? `ACTION REQUIRED: ${failed} check(s) failed; the installed hooks differ from the distributed ones. Update them (npx @crearize/ai-dev-helm upgrade).` : 'hook-selftest: all cases passed');
  return { lines, exitCode: failed ? 1 : 0, failed, ran };
}

module.exports = { runHookSelftest, checkInstall };
