#!/usr/bin/env node
'use strict';

// Portable, dependency-free admission controller. This is an accidental-loop
// guard, not a security boundary against editing state or disabling hooks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const PHASES = ['requirements', 'design', 'plan', 'quality'];
const SPECIALISTS = ['security-engineer', 'requirements-analyst', 'performance-engineer'];
const TOKEN = /^HELM_REVIEW:([a-f0-9]{32}):([a-z-]+)\s*$/m;
const DISPATCH = /^(Agent|Task|spawn_agent)$/;
const FOLLOWUP = /^(followup_task|send_message|send_input|resume_agent)$/;
const REVIEW_NAME = /(?:^|[\s_/:.-])(?:review(?:er)?|code-reviewer|document-reviewer|falsification-qa|security-engineer|requirements-analyst|performance-engineer)(?:$|[\s_/:.-])|レビュー/i;
const REVIEW_DESCRIPTION = /^(?:(?:code|design|plan|requirements|verification)[ -])?review\b|^(?:コード|設計|計画|要件|検証)?レビュー/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

function location(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const common = fs.realpathSync(path.resolve(cwd, git(['rev-parse', '--git-common-dir'])));
  const branch = git(['symbolic-ref', '--quiet', 'HEAD']); // detached HEAD must not silently get a fresh budget
  const root = path.join(common, 'ai-dev-helm-reviews');
  return { root, branch, file: path.join(root, `${digest(branch)}.json`) };
}

function assertRegular(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe review state file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function validState(state, branch) {
  if (!state || state.version !== 1 || state.branch !== branch || !state.phases || !state.agents || !state.receipts) return false;
  if ([state.phases, state.agents, state.receipts].some((x) => typeof x !== 'object' || Array.isArray(x))) return false;
  for (const [phase, group] of Object.entries(state.phases)) {
    if (!PHASES.includes(phase) || !group || !Number.isInteger(group.limit) || group.limit < 1 || group.limit > 3 ||
        !Array.isArray(group.rounds) || group.rounds.length > group.limit) return false;
    for (const [index, round] of group.rounds.entries()) {
      if (!round || !/^[a-f0-9]{32}$/.test(round.token) || !Array.isArray(round.roles) ||
          !round.used || typeof round.used !== 'object' || Array.isArray(round.used)) return false;
      try { validateRoles(phase, round.roles, index + 1); } catch { return false; }
      if (Object.keys(round.used).some((role) => !round.roles.includes(role))) return false;
    }
  }
  return true;
}

function transact(cwd, mutate, fn) {
  const loc = location(cwd);
  if (!fs.existsSync(loc.root)) {
    if (!mutate) return fn({ version: 1, branch: loc.branch, phases: {}, agents: {}, receipts: {} }, loc);
    fs.mkdirSync(loc.root, { mode: 0o700 });
  }
  if (!fs.lstatSync(loc.root).isDirectory() || fs.lstatSync(loc.root).isSymbolicLink()) throw new Error('Unsafe review state directory');
  const lock = `${loc.file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { throw new Error(`Review budget lock unavailable; do not retry a review until resolved: ${error.code}`); }
  let temp;
  try {
    assertRegular(loc.file);
    const state = fs.existsSync(loc.file) ? JSON.parse(fs.readFileSync(loc.file, 'utf8')) :
      { version: 1, branch: loc.branch, phases: {}, agents: {}, receipts: {} };
    if (!validState(state, loc.branch)) throw new Error('Invalid review budget state; ask the user to inspect it');
    const result = fn(state, loc);
    if (mutate) {
      temp = `${loc.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, loc.file);
      temp = undefined;
    }
    return result;
  } finally {
    if (temp) fs.unlinkSync(temp);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function validateRoles(phase, roles, round) {
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length) throw new Error('A unique review role roster is required');
  if (phase !== 'quality') {
    if (roles.length !== 1 || roles[0] !== 'document-reviewer') throw new Error('Document review role must be document-reviewer');
  } else if (round === 1) {
    if (!roles.includes('integrated-reviewer') || roles.some((r) => !['integrated-reviewer', 'falsification-qa', ...SPECIALISTS].includes(r)) ||
        roles.filter((r) => SPECIALISTS.includes(r)).length > 1) throw new Error('Invalid first-round review role roster');
  } else if (!roles.includes('verification-reviewer') || roles.some((r) => !['verification-reviewer', 'falsification-qa'].includes(r))) {
    throw new Error('Later review roles must be verification-reviewer and optional falsification-qa');
  }
}

function beginRound({ cwd = process.cwd(), phase, roles, limit }) {
  if (!PHASES.includes(phase)) throw new Error('Unknown review phase');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 3)) throw new Error('Review limit must be an integer from 1 to 3');
  return transact(cwd, true, (state, loc) => {
    const group = state.phases[phase] || { limit: limit ?? (phase === 'quality' ? 3 : 1), rounds: [] };
    if (limit !== undefined && limit > group.limit) throw new Error('Review limit cannot be raised automatically');
    const effectiveLimit = Math.min(group.limit, limit ?? group.limit);
    if (group.rounds.length >= effectiveLimit) throw new Error(`Review limit reached (${group.rounds.length}/${effectiveLimit}); report remaining findings and ask the user`);
    validateRoles(phase, roles, group.rounds.length + 1);
    group.limit = effectiveLimit;
    const round = { token: crypto.randomBytes(16).toString('hex'), roles, used: {}, reservedAt: new Date().toISOString() };
    group.rounds.push(round);
    state.phases[phase] = group;
    return { phase, round: group.rounds.length, limit: group.limit, statePath: loc.file,
      markers: Object.fromEntries(roles.map((role) => [role, `HELM_REVIEW:${round.token}:${role}`])) };
  });
}

function request(payload) {
  const tool = String(payload.tool_name || '').replace(/^.*\./, '');
  const input = payload.tool_input || {};
  const text = [input.prompt, input.message].filter((x) => typeof x === 'string').join('\n');
  const marker = text.match(TOKEN);
  const names = [input.task_name, input.subagent_type, input.agent_type, input.name].filter((x) => typeof x === 'string');
  const target = input.target || input.id || input.agent_id || input.resume;
  return { tool, input, marker, names, target, candidate: DISPATCH.test(tool) || FOLLOWUP.test(tool),
    named: names.some((x) => REVIEW_NAME.test(x)) || REVIEW_DESCRIPTION.test(input.description || '') || (typeof target === 'string' && REVIEW_NAME.test(target)),
    marked: text.includes('HELM_REVIEW:') };
}

function checkReview(payload) {
  const req = request(payload);
  if (!req.candidate) return { review: false, allowed: true };
  const cwd = payload.cwd || process.cwd();
  let known = false;
  // Workers with no resume target must remain usable even if review state is broken.
  if (!req.named && !req.marked && !req.target) return { review: false, allowed: true };
  try {
    if (req.target) known = transact(cwd, false, (state) => own(state.agents, req.target));
    if (!req.named && !req.marked && !known) return { review: false, allowed: true };
    if (!req.marker) return { review: true, allowed: false, reason: 'Review admission required. Reserve a review-budget round; do not relabel a reviewer as a worker.' };
    return transact(cwd, true, (state) => {
      const [, token, role] = req.marker;
      const fingerprint = digest(JSON.stringify({ tool: req.tool, input: req.input }));
      const receiptId = typeof payload.tool_use_id === 'string' ? digest(`${payload.session_id || ''}:${payload.tool_use_id}`) : null;
      if (receiptId && own(state.receipts, receiptId)) {
        if (state.receipts[receiptId].fingerprint !== fingerprint) throw new Error('Review delivery id was reused with different input');
        return { review: true, allowed: true };
      }
      let round;
      for (const group of Object.values(state.phases)) {
        const last = group.rounds.at(-1);
        if (last && last.token === token) round = last;
      }
      if (!round || !round.roles.includes(role)) throw new Error('Unknown or closed review admission');
      if (own(round.used, role)) throw new Error('Review seat already used; another pass requires a new round');
      round.used[role] = { admittedAt: new Date().toISOString(), receiptId };
      if (receiptId) state.receipts[receiptId] = { fingerprint, token, role };
      for (const alias of [req.input.task_name, req.input.name, req.target]) {
        if (typeof alias === 'string' && alias && alias !== '__proto__') state.agents[alias] = true;
      }
      return { review: true, allowed: true };
    });
  } catch (error) {
    // An unknown opaque target cannot be classified when its tracking state is
    // unavailable. Don't turn a review guard into a blanket worker limit.
    // Named reviewers and marked admissions remain fail-closed.
    if (!req.named && !req.marked && !known) return { review: false, allowed: true, warning: error.message };
    return { review: true, allowed: false, reason: `Review budget: ${error.message}` };
  }
}

function recordAgent(payload) {
  const req = request(payload);
  if (!req.candidate || !req.marker) return;
  const response = payload.tool_response;
  const aliases = [];
  function collect(value, depth = 0) {
    if (!value || depth > 4) return;
    if (typeof value === 'string') {
      try { collect(JSON.parse(value), depth + 1); } catch { /* Non-JSON tool text isn't a stable identifier. */ }
    } else if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (['agent_id', 'agentId', 'task_name'].includes(key) && typeof item === 'string') aliases.push(item);
        else if (['content', 'text', 'result', 'structuredContent'].includes(key) || Array.isArray(value)) collect(item, depth + 1);
      }
    }
  }
  collect(response);
  if (!aliases.length) return;
  transact(payload.cwd || process.cwd(), true, (state) => {
    const [, token, role] = req.marker;
    const admitted = Object.values(state.phases).some((g) => g.rounds.some((r) => r.token === token && own(r.used, role)));
    if (!admitted) throw new Error('No admitted review to record');
    for (const alias of aliases) if (alias !== '__proto__') state.agents[alias] = true;
  });
}

function status({ cwd = process.cwd() } = {}) {
  return transact(cwd, false, (state, loc) => ({ ...state, statePath: loc.file }));
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}

function main() {
  if (['begin', 'status'].includes(process.argv[2])) {
    try {
      const args = process.argv.slice(3);
      const values = {};
      for (let n = 0; n < args.length; n += 2) {
        if (!['--phase', '--roles', '--limit'].includes(args[n]) || args[n + 1] === undefined) throw new Error('Usage: review-budget.cjs begin --phase quality --roles integrated-reviewer [--limit 1]');
        values[args[n].slice(2)] = args[n + 1];
      }
      const result = process.argv[2] === 'status' ? status() : beginRound({ phase: values.phase, roles: values.roles?.split(','), limit: values.limit === undefined ? undefined : Number(values.limit) });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
    return;
  }
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (chunk) => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); });
  process.stdin.on('end', () => {
    try {
      if (size > 1024 * 1024) throw new Error('Review hook payload too large');
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
      if (!payload || typeof payload !== 'object') throw new Error('Invalid review hook payload');
      if (payload.hook_event_name === 'PostToolUse') {
        try { recordAgent(payload); } catch (error) { process.stderr.write(`Review agent tracking failed: ${error.message}\n`); }
      } else {
        const result = checkReview(payload);
        if (!result.allowed) deny(result.reason);
      }
    } catch (error) { deny(error.message); }
  });
}

module.exports = { beginRound, checkReview, recordAgent, status, main };
if (require.main === module) main();
