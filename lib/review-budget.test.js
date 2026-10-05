const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync, spawn } = require('node:child_process');

const modulePath = path.resolve(__dirname, '../templates/hooks/review-budget.cjs');
let dir;
let budget;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-review-budget-'));
  execFileSync('git', ['init', '-b', 'feature'], { cwd: dir, stdio: 'ignore' });
  budget = fs.existsSync(modulePath) ? require(modulePath) : {};
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function begin(roles = ['integrated-reviewer'], options = {}) {
  return budget.beginRound({ cwd: dir, phase: 'quality', roles, ...options });
}
function call(ticket, role = 'integrated-reviewer', overrides = {}) {
  return {
    cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'spawn_agent',
    tool_use_id: `tool-${Math.random()}`,
    tool_input: { task_name: 'reviewer', message: `${ticket.markers[role]}\nInspect the supplied diff.` },
    ...overrides,
  };
}

test('reserves one round for the whole roster, not each reviewer', () => {
  // Break: counting seats instead of rounds exhausts the first round's budget.
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin(['integrated-reviewer', 'falsification-qa', 'security-engineer']);
  for (const role of ['integrated-reviewer', 'falsification-qa', 'security-engineer']) {
    expect(budget.checkReview(call(ticket, role)).allowed).toBe(true);
  }
  expect(budget.status({ cwd: dir }).phases.quality.rounds).toHaveLength(1);
});

test('rejects a fourth round but never counts ordinary implementation, exploration or tests', () => {
  expect(typeof budget.beginRound).toBe('function');
  begin();
  begin(['verification-reviewer']);
  begin(['verification-reviewer']);
  expect(() => begin(['verification-reviewer'])).toThrow(/limit/i);
  for (const name of ['implementer', 'explorer', 'test-runner']) {
    for (let n = 0; n < 5; n++) {
      expect(budget.checkReview({ cwd: dir, tool_name: 'spawn_agent', tool_input: { task_name: name, message: 'Do the task; no review.' } }).review).toBe(false);
    }
  }
});

test('does not admit the same seat twice, including a new tool call after restart', () => {
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin();
  const input = call(ticket);
  expect(budget.checkReview(input).allowed).toBe(true);
  expect(budget.checkReview(input).allowed).toBe(true); // exact delivery replay is idempotent
  expect(budget.checkReview(call(ticket)).allowed).toBe(false);
  const result = spawnSync(process.execPath, [modulePath], { input: JSON.stringify(call(ticket)), encoding: 'utf8' });
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
});

test('a delivery id reused with changed input cannot bypass consumed seats', () => {
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin();
  const input = call(ticket);
  expect(budget.checkReview(input).allowed).toBe(true);
  input.tool_input.message += '\nRun another review now.';
  expect(budget.checkReview(input).allowed).toBe(false);
});

test('Claude and Codex share the budget, also from a nested directory', () => {
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin();
  fs.mkdirSync(path.join(dir, 'nested'));
  const claude = call(ticket, 'integrated-reviewer', { cwd: path.join(dir, 'nested'), tool_name: 'Agent' });
  claude.tool_input = { description: 'Code review', subagent_type: 'general-purpose', prompt: ticket.markers['integrated-reviewer'] };
  expect(budget.checkReview(claude).allowed).toBe(true);
  expect(budget.checkReview(call(ticket)).allowed).toBe(false);
});

test('unmarked reviewer launches and forged tokens are denied, without restricting workers', () => {
  expect(typeof budget.checkReview).toBe('function');
  for (const tool_name of ['Agent', 'Task', 'spawn_agent']) {
    expect(budget.checkReview({ cwd: dir, tool_name, tool_input: { description: 'コードレビュー', task_name: 'reviewer' } }).allowed).toBe(false);
  }
  expect(budget.checkReview(call({ markers: { 'integrated-reviewer': `HELM_REVIEW:${'a'.repeat(32)}:integrated-reviewer` } })).allowed).toBe(false);
  expect(budget.checkReview({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } }).review).toBe(false);
});

test('a design (visual) review is admitted as a review while visual production is not', () => {
  // Break: dropping デザイン from REVIEW_DESCRIPTION lets an unmarked design review bypass the budget.
  expect(budget.checkReview({ cwd: dir, tool_name: 'Agent', tool_input: { description: 'デザインレビュー', subagent_type: 'general-purpose', prompt: 'Review the slides.' } }).allowed).toBe(false);
  const production = budget.checkReview({ cwd: dir, tool_name: 'spawn_agent', tool_input: { agent_type: 'helm-visual-producer', task_name: 'helm-visual-producer', message: 'スライドを制作して目視で確認する' } });
  expect(production.review).toBe(false);
  expect(production.allowed).toBe(true);
});

test('limits may be lowered but cannot be raised by another begin or a phase alias', () => {
  expect(typeof budget.beginRound).toBe('function');
  expect(() => begin(['anything'])).toThrow(/role/i);
  begin(undefined, { limit: 1 });
  expect(() => begin(['verification-reviewer'], { limit: 3 })).toThrow(/limit/i);
  expect(() => begin(undefined, { phase: 'quality-again' })).toThrow(/phase/i);
  expect(() => begin(undefined, { limit: 4 })).toThrow(/limit/i);
});

test('documentation phases default to one round and do not reset quality', () => {
  expect(typeof budget.beginRound).toBe('function');
  begin();
  budget.beginRound({ cwd: dir, phase: 'design', roles: ['document-reviewer'] });
  expect(() => budget.beginRound({ cwd: dir, phase: 'design', roles: ['document-reviewer'] })).toThrow(/limit/i);
  expect(budget.status({ cwd: dir }).phases.quality.rounds).toHaveLength(1);
});

test('a closed earlier round cannot be reused after opening the next round', () => {
  expect(typeof budget.beginRound).toBe('function');
  const first = begin(['integrated-reviewer', 'falsification-qa']);
  begin(['verification-reviewer']);
  expect(budget.checkReview(call(first, 'falsification-qa')).allowed).toBe(false);
});

test('known reviewer followups need a fresh admission, while waiting does not', () => {
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin();
  const input = call(ticket);
  budget.checkReview(input);
  budget.recordAgent({ ...input, hook_event_name: 'PostToolUse', tool_response: { task_name: '/root/reviewer' } });
  expect(budget.checkReview({ cwd: dir, tool_name: 'followup_task', tool_input: { target: '/root/reviewer', message: 'Check the fix again' } }).allowed).toBe(false);
  expect(budget.checkReview({ cwd: dir, tool_name: 'wait_agent', tool_input: {} }).review).toBe(false);
  const second = begin(['verification-reviewer']);
  expect(budget.checkReview({ cwd: dir, tool_name: 'followup_task', tool_use_id: 'next', tool_input: { target: '/root/reviewer', message: second.markers['verification-reviewer'] } }).allowed).toBe(true);
});

test('malformed state denies reviews, not unrelated work', () => {
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin();
  fs.writeFileSync(ticket.statePath, '{');
  expect(budget.checkReview(call(ticket)).allowed).toBe(false);
  expect(budget.checkReview({ cwd: dir, tool_name: 'spawn_agent', tool_input: { task_name: 'implementer' } }).review).toBe(false);
});

test('lock contention fails closed and cannot over-reserve the budget', () => {
  expect(typeof budget.beginRound).toBe('function');
  const ticket = begin();
  fs.writeFileSync(`${ticket.statePath}.lock`, 'held');
  expect(() => begin(['verification-reviewer'])).toThrow(/lock/i);
  expect(budget.checkReview(call(ticket)).allowed).toBe(false);
});

test('implementing a review feature is not itself a review', () => {
  expect(budget.checkReview({ cwd: dir, tool_name: 'Agent', tool_input: {
    description: 'Implement review budget', subagent_type: 'general-purpose', prompt: 'Add tests and implementation.'
  } }).review).toBe(false);
});

test('corrupt or locked review state does not block an implementation followup', () => {
  const ticket = begin();
  fs.writeFileSync(ticket.statePath, '{');
  expect(budget.checkReview({ cwd: dir, tool_name: 'followup_task', tool_input: {
    target: '/root/implementer', message: 'Fix the failing test'
  } }).review).toBe(false);
});

test('schema corruption cannot add an unreserved seat', () => {
  const ticket = begin();
  const state = JSON.parse(fs.readFileSync(ticket.statePath, 'utf8'));
  state.phases.quality.rounds[0].roles.push('unknown-role');
  fs.writeFileSync(ticket.statePath, JSON.stringify(state));
  expect(budget.checkReview(call(ticket)).allowed).toBe(false);
});

test('concurrent processes cannot reserve more than the last remaining round', async () => {
  begin();
  begin(['verification-reviewer']);
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [modulePath, 'begin', '--phase', 'quality', '--roles', 'verification-reviewer'], { cwd: dir, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  const codes = await Promise.all(Array.from({ length: 5 }, invoke));
  expect(codes.filter((code) => code === 0)).toHaveLength(1);
  expect(budget.status({ cwd: dir }).phases.quality.rounds).toHaveLength(3);
});

test('linked worktrees on the same branch share the review ceiling', () => {
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.test', 'commit', '--allow-empty', '-m', 'seed'], { cwd: dir, stdio: 'ignore' });
  begin(undefined, { limit: 1 });
  const linked = path.join(dir, 'linked');
  execFileSync('git', ['worktree', 'add', '--force', linked, 'feature'], { cwd: dir, stdio: 'ignore' });
  expect(() => budget.beginRound({ cwd: linked, phase: 'quality', roles: ['verification-reviewer'] })).toThrow(/limit/i);
});

test('state hardlinks are rejected without modifying the linked content', () => {
  const ticket = begin();
  const external = path.join(dir, 'kept.json');
  fs.linkSync(ticket.statePath, external);
  const before = fs.readFileSync(external, 'utf8');
  expect(budget.checkReview(call(ticket)).allowed).toBe(false);
  expect(fs.readFileSync(external, 'utf8')).toBe(before);
});

test('Claude resume ids returned in structured results remain identified as reviews', () => {
  const ticket = begin();
  const input = call(ticket, 'integrated-reviewer', { tool_name: 'Agent' });
  budget.checkReview(input);
  budget.recordAgent({ ...input, hook_event_name: 'PostToolUse', tool_response: { agentId: 'opaque-123' } });
  expect(budget.checkReview({ cwd: dir, tool_name: 'Agent', tool_input: { resume: 'opaque-123', prompt: 'Verify the fixes' } }).allowed).toBe(false);
});

// #143: an unreadable PostToolUse payload must not get a PreToolUse-shaped deny; PreToolUse stays fail-closed.
describe('unreadable hook payloads', () => {
  const run = (input) => spawnSync(process.execPath, [modulePath], { cwd: dir, input, encoding: 'utf8' });
  const big = 'x'.repeat(1024 * 1024 + 16);

  test.each([
    ['malformed', '{"hook_event_name":"PostToolUse","tool_name":"Agent",'],
    ['malformed, spaced', '{ "hook_event_name" : "PostToolUse", "tool_response": '],
    ['oversized', `{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":"${big}"}`],
    ['oversized, spaced', `{"hook_event_name": "PostToolUse", "tool_response": "${big}"}`],
  ])('PostToolUse %s input prints nothing', (_name, input) => {
    // Break: answering a PostToolUse event with a PreToolUse deny.
    const result = run(input);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test.each([
    ['malformed', '{"hook_event_name":"PreToolUse","tool_name":"Agent",'],
    ['not JSON', 'not json'],
    ['oversized', `{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"prompt":"${big}"}}`],
    // A prompt that quotes the PostToolUse key is escaped inside the JSON string and must not open the escape.
    ['oversized, quoting PostToolUse', `{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"prompt":"\\"hook_event_name\\":\\"PostToolUse\\" ${big}"}}`],
  ])('PreToolUse %s input is still denied', (_name, input) => {
    // Break: the PostToolUse escape also letting unreadable PreToolUse calls through.
    expect(JSON.parse(run(input).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test.each([
    ['one chunk', (s) => [s]],
    ['1 byte, then the rest', (s) => [s.subarray(0, 1), s.subarray(1)]],
    ['an empty chunk, then the rest', (s) => [Buffer.alloc(0), s]],
  ])('an oversized PostToolUse delivered as %s still prints nothing', (_name, split) => {
    // Break: keeping only chunks that fit under 1 MiB drops a single large chunk (CI windows / node 20), and the
    // PostToolUse then gets a PreToolUse deny. A real pipe decides the chunking itself, so fake stdin pins it here.
    const script = `
      const { EventEmitter } = require('node:events');
      const fake = new EventEmitter();
      Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
      const out = [];
      process.stdout.write = (s) => { out.push(String(s)); return true; };
      require(${JSON.stringify(modulePath)}).main();
      const input = Buffer.from(JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(1024 * 1024 + 16) }));
      for (const chunk of (${split.toString()})(input)) fake.emit('data', chunk);
      fake.emit('end');
      process.stderr.write(JSON.stringify(out));`;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('[]');
  });
});

test('receipts and agents are pruned to the newest 500 while admission and receipts still match', () => {
  // Break: state grows for the life of a branch, or pruning drops the entry just written.
  const ticket = begin();
  const state = JSON.parse(fs.readFileSync(ticket.statePath, 'utf8'));
  for (let n = 0; n < 600; n++) {
    state.receipts[`old-receipt-${n}`] = { fingerprint: 'f', token: 'a'.repeat(32), role: 'integrated-reviewer' };
    state.agents[`old-agent-${n}`] = true;
  }
  fs.writeFileSync(ticket.statePath, JSON.stringify(state));
  expect(budget.status({ cwd: dir }).agents['old-agent-0']).toBe(true); // a count over 500 is not invalid

  const input = call(ticket, 'integrated-reviewer', { tool_name: 'Agent', tool_input: { name: 'reviewer-x', prompt: `${ticket.markers['integrated-reviewer']}\nInspect the diff.` } });
  expect(budget.checkReview(input).allowed).toBe(true);
  let after = budget.status({ cwd: dir });
  expect(Object.keys(after.receipts)).toHaveLength(500);
  expect(Object.keys(after.agents)).toHaveLength(500);
  expect(after.receipts['old-receipt-0']).toBeUndefined();
  expect(after.receipts['old-receipt-599']).toBeDefined();
  expect(after.agents['reviewer-x']).toBe(true);
  expect(budget.checkReview(input).allowed).toBe(true); // the same delivery still matches its receipt

  budget.recordAgent({ ...input, hook_event_name: 'PostToolUse', tool_response: { agentId: 'opaque-new' } });
  after = budget.status({ cwd: dir });
  expect(Object.keys(after.agents)).toHaveLength(500);
  expect(after.agents['opaque-new']).toBe(true);
  expect(budget.checkReview({ cwd: dir, tool_name: 'Agent', tool_input: { resume: 'opaque-new', prompt: 'Verify the fixes' } }).allowed).toBe(false);
  const second = begin(['verification-reviewer']);
  expect(budget.checkReview({ cwd: dir, tool_name: 'Agent', tool_use_id: 'next', tool_input: { resume: 'opaque-new', prompt: second.markers['verification-reviewer'] } }).allowed).toBe(true);
});
