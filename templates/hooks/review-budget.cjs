#!/usr/bin/env node
'use strict';

// Portable, dependency-free admission controller. This is an accidental-loop
// guard, not a security boundary against editing state or disabling hooks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const PHASES = ['requirements', 'design', 'plan', 'quality', 'production', 'mutation'];
// Phases whose limit waits for the owner: the final quality reviews, and the reviews before the design approval.
const OWNER_STOP_PHASES = ['quality', 'production', 'design', 'requirements'];
const BRANCH_PHASES = ['requirements', 'design', 'plan', 'production']; // reservations are per branch, so not on the trunk
// The final quality review and the production review: the full review and one check of the high fixes (3.6.0, #213).
// A first --limit cannot raise them; only extend, after the owner approved, goes past it.
const REVIEW_LIMIT = { quality: 2, production: 2 };
const SPECIALISTS = ['security-engineer', 'requirements-analyst', 'performance-engineer'];
// 3.7.0 (from MovieMarketer's MM-REVIEW-PATCH 1): parallel PreToolUse / PostToolUse calls share the lock, so a caller
// waits up to 2 s for its owner instead of failing at once. Only EEXIST is waited on; a lock is never deleted.
const LOCK_WAIT_MS = 2000;
const KEEP_ENTRIES = 500; // receipts / agents kept per branch state
const TOKEN = /^HELM_REVIEW:([a-f0-9]{32}):([a-z-]+)[ \t]*(?:\r?\n|$)/; // first line of the prompt/message only
const DISPATCH = /^(Agent|Task|spawn_agent)$/;
const FOLLOWUP = /^(followup_task|send_message|send_input|resume_agent|SendMessage)$/;
// Role names without a review word, plus review words (reviewer, designReviewer, レビュー, ...).
const REVIEW_ROLE_NAME = /(?:^|[\s_/:.-])(?:falsification-qa|security-engineer|requirements-analyst|performance-engineer)(?:$|[\s_/:.-])/i;
const REVIEW_WORD = /\breview(?:er|ers|ing)?\b|[a-z]Review(?:er)?\b|レビュ[ーア]/;
// A description is a review when it starts or ends with a review word. Fixing review findings and review-named artifacts are not.
const REVIEW_ARTIFACT = /^(?:review(?:[-_]|(?=[A-Z]))(?:budget|feature|hook|tool|ui|page|screen|logic|module|service|api|settings)|review\s+(?:fix(?:es)?|follow-?ups?|comments?|findings?|feedback)\b|レビュー(?:[\s_-]?(?:機能|基盤|予算|フック|画面|ツール|ロジック|設定|コメント|結果)|の?[\s_-]?(?:指摘|対応|反映|修正)))/i;
const FIX_LEAD = /^(?:fix(?:es|ed)?|address(?:ed|ing)?|apply|resolve[sd]?|handle|incorporate)\b/i; // acting on review output, not dispatching a reviewer
const REVIEW_START = /^(?:(?:code|design|plan|requirements|verification|visual|integrated)[ -])?(?:review(?:er|ing)?\b|レビュ[ーア])|^(?:コード|設計|計画|要件|検証|デザイン|統合)レビュー/i;
const REVIEW_END = /(?:\breview(?:er|ing)?|レビュー|レビュア)[\s.。]*$/i;
// 3.7.0 (from MM-REVIEW-PATCH 3): Codex names agents with underscores (integrated_reviewer); read them like hyphens.
const isReviewName = (name) => {
  const separated = name.replace(/_/g, '-');
  return REVIEW_ROLE_NAME.test(separated) || REVIEW_WORD.test(separated);
};
function isReviewDescription(text) {
  const d = String(text || '').trim();
  if (!d) return false;
  if (FIX_LEAD.test(d)) return false;
  const rest = d.replace(/^(?:(?:code|design|plan|requirements|verification|visual|integrated|quality)[ -]|(?:コード|設計|計画|要件|検証|デザイン|統合|品質))/i, '');
  return (REVIEW_START.test(d) && !REVIEW_ARTIFACT.test(rest)) || REVIEW_END.test(d);
}
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

function ceiling(group, extensions, phase) {
  return group.limit + extensions.filter((x) => x.phase === phase).reduce((sum, x) => sum + x.rounds, 0);
}

function validExtensions(list) {
  return Array.isArray(list) && list.every((x) => x && typeof x === 'object' && PHASES.includes(x.phase) && x.phase !== 'mutation' &&
    Number.isInteger(x.rounds) && x.rounds >= 1 && x.rounds <= 3 && typeof x.reason === 'string' && x.reason.trim().length >= 10 &&
    x.reason.length <= 500 && typeof x.at === 'string');
}

function validState(state, branch) {
  if (!state || state.version !== 1 || state.branch !== branch || !state.phases || !state.agents || !state.receipts) return false;
  if ([state.phases, state.agents, state.receipts].some((x) => typeof x !== 'object' || Array.isArray(x))) return false;
  if (state.extensions !== undefined && !validExtensions(state.extensions)) return false;
  const extensions = state.extensions || [];
  for (const [phase, group] of Object.entries(state.phases)) {
    if (!PHASES.includes(phase) || !group || !Number.isInteger(group.limit) || group.limit < 1 || group.limit > 3 ||
        (phase === 'mutation' && group.limit !== 1) ||
        !Array.isArray(group.rounds) || group.rounds.length > ceiling(group, extensions, phase)) return false;
    for (const [index, round] of group.rounds.entries()) {
      if (!round || !/^[a-f0-9]{32}$/.test(round.token) || !Array.isArray(round.roles) ||
          !round.used || typeof round.used !== 'object' || Array.isArray(round.used)) return false;
      try { validateRoles(phase, round.roles, index + 1); } catch { return false; }
      if (Object.keys(round.used).some((role) => !round.roles.includes(role))) return false;
    }
  }
  return true;
}

// 3.7.0 (from MM-REVIEW-PATCH 5, MovieMarketer #2027): a lock is never reclaimed by its age. A timestamp cannot prove
// that a lock is abandoned, and stat -> rename can remove a successor's fresh lock. A held lock is waited on for up to
// LOCK_WAIT_MS (MM-REVIEW-PATCH 1), then the call fails closed.
function acquireLock(lock) {
  const deadline = performance.now() + LOCK_WAIT_MS;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      const remaining = deadline - performance.now();
      if (error.code === 'EEXIST' && remaining > 0) {
        Atomics.wait(signal, 0, 0, Math.min(25, remaining));
        continue;
      }
      throw new Error(`Review budget lock ${lock} is held by another process; do not delete or edit it and do not work around it. ` +
        'Locks are not reclaimed by age. If it persists, report the lock path and whether the pid it records still runs to the owner, and wait (harness-runtime: only after the owner approves it in the conversation is that .lock removed). ' + error.code);
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return fd;
    } catch (error) {
      fs.closeSync(fd); // the public name stays: a failed acquisition is no ground to unlink it
      throw error;
    }
  }
}

// Keeps the newest KEEP_ENTRIES keys (insertion order) so receipts / agents do not grow for the life of a branch.
// A follow-up to a reviewer pruned out of agents is then no longer counted; accepted for branches past 500 entries.
function prune(map) {
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_ENTRIES))) delete map[key];
}

function transact(cwd, mutate, fn) {
  const loc = location(cwd);
  if (!fs.existsSync(loc.root)) {
    if (!mutate) return fn({ version: 1, branch: loc.branch, phases: {}, agents: {}, receipts: {} }, loc);
    fs.mkdirSync(loc.root, { mode: 0o700 });
  }
  if (!fs.lstatSync(loc.root).isDirectory() || fs.lstatSync(loc.root).isSymbolicLink()) throw new Error('Unsafe review state directory');
  const lock = `${loc.file}.lock`;
  const fd = acquireLock(lock);
  let temp;
  try {
    assertRegular(loc.file);
    const state = fs.existsSync(loc.file) ? JSON.parse(fs.readFileSync(loc.file, 'utf8')) :
      { version: 1, branch: loc.branch, phases: {}, agents: {}, receipts: {} };
    if (!validState(state, loc.branch)) throw new Error(`Invalid review budget state in ${loc.file}. Do not delete or edit it; report it with the output of status to the owner and wait for the owner's decision.`);
    const result = fn(state, loc);
    if (mutate) {
      prune(state.receipts);
      prune(state.agents);
      temp = `${loc.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, loc.file);
      temp = undefined;
    }
    return result;
  } finally {
    // 3.7.0 (MM-REVIEW-PATCH 5): the owned lock is renamed to a private name before its file is deleted, so a
    // delete-pending name on Windows cannot deny the next owner, and the deletion never reaches the next owner's lock.
    try {
      if (temp) fs.unlinkSync(temp);
    } finally {
      const retired = `${lock}.released-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      try {
        fs.renameSync(lock, retired);
      } finally {
        fs.closeSync(fd);
      }
      fs.unlinkSync(retired);
    }
  }
}

function validateRoles(phase, roles, round) {
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length) throw new Error('A unique review role roster is required');
  if (phase === 'mutation') {
    if (roles.length !== 1 || roles[0] !== 'falsification-qa') throw new Error('Mutation review role must be falsification-qa');
  } else if (phase === 'production') {
    // Same shape as quality, without specialist seats.
    const required = round === 1 ? 'integrated-reviewer' : 'verification-reviewer';
    if (!roles.includes(required) || roles.some((r) => ![required, 'falsification-qa'].includes(r))) {
      throw new Error('Production review roles must be integrated-reviewer (first round) or verification-reviewer (later rounds), plus optional falsification-qa');
    }
  } else if (phase !== 'quality') {
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
  if (phase === 'mutation' && limit !== undefined && limit !== 1) throw new Error('The mutation review limit is fixed at 1');
  if (own(REVIEW_LIMIT, phase) && limit !== undefined && limit > REVIEW_LIMIT[phase]) {
    throw new Error(`The ${phase} review limit cannot exceed ${REVIEW_LIMIT[phase]}; go past it only with extend, after the owner approves`);
  }
  return transact(cwd, true, (state, loc) => {
    if (BRANCH_PHASES.includes(phase) && /^refs\/heads\/(main|master)$/.test(loc.branch)) {
      throw new Error(`Create a task branch before reserving a ${phase} review (reservations are per branch)`);
    }
    const extensions = state.extensions || [];
    const group = state.phases[phase] || { limit: limit ?? (own(REVIEW_LIMIT, phase) ? REVIEW_LIMIT[phase] : 1), rounds: [] };
    if (limit !== undefined && limit > group.limit) throw new Error('Review limit cannot be raised automatically');
    const effectiveLimit = Math.min(group.limit, limit ?? group.limit);
    const allowed = ceiling({ limit: effectiveLimit }, extensions, phase);
    if (group.rounds.length >= allowed) {
      const extend = `run extend yourself (extend --phase ${phase} --rounds <1-3> --reason "<the owner's approval, quoted>") and then reserve again`;
      // OWNER_STOP_PHASES wait for the owner; plan and mutation record the rest and continue (development-policy §1.0).
      if (OWNER_STOP_PHASES.includes(phase)) {
        throw new Error(`Review limit reached (${group.rounds.length}/${allowed}); report the remaining findings to the owner. If the owner approves another round, ${extend}`);
      }
      const more = phase === 'mutation' ? 'The mutation limit cannot be extended.' : `Only if the owner has already approved another round, ${extend}`;
      throw new Error(`Review limit reached (${group.rounds.length}/${allowed}); do not stop for the owner: record the remaining findings and how you handle them, and continue. ${more}`);
    }
    validateRoles(phase, roles, group.rounds.length + 1);
    group.limit = effectiveLimit;
    const round = { token: crypto.randomBytes(16).toString('hex'), roles, used: {}, reservedAt: new Date().toISOString() };
    group.rounds.push(round);
    state.phases[phase] = group;
    return { phase, round: group.rounds.length, limit: allowed, statePath: loc.file,
      markers: Object.fromEntries(roles.map((role) => [role, `HELM_REVIEW:${round.token}:${role}`])) };
  });
}

// Raise the ceiling of a phase after the owner approved exceeding it. Appends to state.extensions; group.limit is never rewritten.
function extendLimit({ cwd = process.cwd(), phase, rounds, reason }) {
  if (!PHASES.includes(phase) || phase === 'mutation') throw new Error('Only the requirements, design, plan, quality and production limits can be extended');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('--rounds must be an integer from 1 to 3');
  const text = String(reason ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (text.length < 10 || text.length > 500) throw new Error("--reason is required: quote the owner's approval in 10 to 500 characters");
  return transact(cwd, true, (state, loc) => {
    const group = state.phases[phase];
    if (!group) throw new Error(`No ${phase} review is recorded on this branch; extend only after its limit is reached`);
    state.extensions = state.extensions || [];
    const before = ceiling(group, state.extensions, phase);
    if (group.rounds.length < before) throw new Error(`The ${phase} limit is not reached yet (${group.rounds.length}/${before}); extend only after reaching it and getting the owner's approval`);
    state.extensions.push({ phase, rounds, reason: text, at: new Date().toISOString() });
    return { phase, used: group.rounds.length, limit: before + rounds, statePath: loc.file };
  });
}

// 3.7.0 (from MovieMarketer's MM-REVIEW-PATCH 3): Codex builds read `agent_name` as well as `task_name`, and the
// code-mode bridge names its tools `collaboration<tool>` (collaborationspawn_agent ...) and may hide `message` from
// hooks; there the reserved token / role ride in task_name as helm_review_<token>_<role_with_underscores> - the same
// marker, no new grant. When both forms are visible they must agree. The distributed Codex matcher does not reach the
// collaboration* names (it is not changed, to keep Codex's hook trust); a product registers its own matcher for them
// (harness-runtime.md).
const BRIDGED_TOOL = /^collaboration(?:spawn_agent|followup_task|send_message|send_input|resume_agent)$/;
const BRIDGE_TICKET = /^helm_review_([a-f0-9]{32})_([a-z]+(?:_[a-z]+)*)$/;
function request(payload) {
  const rawTool = String(payload.tool_name || '').replace(/^.*\./, '');
  const bridged = BRIDGED_TOOL.test(rawTool);
  const tool = bridged ? rawTool.slice('collaboration'.length) : rawTool;
  const input = payload.tool_input || {};
  const fields = [input.prompt, input.message].filter((x) => typeof x === 'string');
  const textMarker = fields.map((x) => x.match(TOKEN)).find(Boolean) || null;
  const ticket = bridged && typeof input.task_name === 'string' ? BRIDGE_TICKET.exec(input.task_name) : null;
  const bridgeMarker = ticket ? [ticket[0], ticket[1], ticket[2].replace(/_/g, '-')] : null;
  const conflicting = textMarker && bridgeMarker && (textMarker[1] !== bridgeMarker[1] || textMarker[2] !== bridgeMarker[2]);
  const misplacedText = !textMarker && fields.some((value) => value.includes('HELM_REVIEW:'));
  const marker = conflicting || misplacedText ? null : textMarker || bridgeMarker;
  const names = [input.task_name, input.agent_name, input.subagent_type, input.agent_type, input.name, input.to].filter((x) => typeof x === 'string');
  const target = input.target || input.id || input.agent_id || input.resume || input.to;
  return { tool, input, marker, names, target, candidate: DISPATCH.test(tool) || FOLLOWUP.test(tool),
    named: names.some(isReviewName) || isReviewDescription(input.description) || (typeof target === 'string' && isReviewName(target)),
    marked: Boolean(marker), misplaced: !marker && fields.some((x) => x.includes('HELM_REVIEW:')) };
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
    if (!req.marker) {
      return { review: true, allowed: false, reason: req.misplaced ?
        'Review marker must be the first line of the prompt/message. Move the HELM_REVIEW line to the first line.' :
        'Review admission required. Reserve a review-budget round (begin) and put its marker on the first line. If this is not a review (production, fixes), leave review words out of the name and description.' };
    }
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
      for (const alias of [req.input.task_name, req.input.agent_name, req.input.name, req.target]) {
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
        if (['agent_id', 'agentId', 'task_name', 'agent_name'].includes(key) && typeof item === 'string') aliases.push(item);
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

const USAGE = 'Usage: review-budget.cjs begin --phase quality --roles integrated-reviewer [--limit 1] | extend --phase quality --rounds 1 --reason "<owner approval>" | status';

// Runs begin / status / extend from command-line words; returns the JSON result. Shared with the package CLI.
function runCommand(argv, cwd = process.cwd()) {
  const [action, ...args] = argv;
  const values = {};
  for (let n = 0; n < args.length; n += 2) {
    if (!['--phase', '--roles', '--limit', '--rounds', '--reason'].includes(args[n]) || args[n + 1] === undefined) throw new Error(USAGE);
    values[args[n].slice(2)] = args[n + 1];
  }
  const number = (x) => (x === undefined ? undefined : Number(x));
  if (action === 'status') return status({ cwd });
  if (action === 'extend') return extendLimit({ cwd, phase: values.phase, rounds: number(values.rounds), reason: values.reason });
  if (action === 'begin') return beginRound({ cwd, phase: values.phase, roles: values.roles?.split(','), limit: number(values.limit) });
  throw new Error(USAGE);
}

function main() {
  if (['begin', 'status', 'extend'].includes(process.argv[2])) {
    try { process.stdout.write(JSON.stringify(runCommand(process.argv.slice(2)), null, 2) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
    return;
  }
  const chunks = [];
  let size = 0;
  // Keep the first 1 MiB even when a single chunk is larger (Windows pipes can deliver the whole input at once),
  // so an oversized PostToolUse payload can still be recognised below.
  process.stdin.on('data', (chunk) => {
    const room = 1024 * 1024 - Math.min(size, 1024 * 1024);
    if (room > 0) chunks.push(chunk.subarray(0, room));
    size += chunk.length;
  });
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    let parsed = false;
    try {
      if (size > 1024 * 1024) throw new Error('Review hook payload too large');
      const payload = JSON.parse(raw);
      parsed = true;
      if (!payload || typeof payload !== 'object') throw new Error('Invalid review hook payload');
      if (payload.hook_event_name === 'PostToolUse') {
        try { recordAgent(payload); } catch (error) { process.stderr.write(`Review agent tracking failed: ${error.message}\n`); }
      } else {
        const result = checkReview(payload);
        if (!result.allowed) deny(result.reason);
      }
    } catch (error) {
      // An unreadable PostToolUse payload (most often an oversized Agent response) gets no PreToolUse-shaped deny.
      // Only unreadable or oversized input is looked at, and only the part read (the first 1 MiB): Claude Code puts
      // hook_event_name near the top. A parsed PreToolUse payload that fails later is still denied.
      if (!parsed && /"hook_event_name"\s*:\s*"PostToolUse"/.test(raw)) return;
      deny(error.message);
    }
  });
}

module.exports = { beginRound, extendLimit, runCommand, checkReview, recordAgent, status, main };
if (require.main === module) main();
