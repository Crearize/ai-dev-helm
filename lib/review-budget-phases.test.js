const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const budget = require('../templates/hooks/review-budget.cjs');
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-review-phases-'));
  execFileSync('git', ['init', '-b', 'feature'], { cwd: dir, stdio: 'ignore' });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function begin(roles = ['integrated-reviewer'], options = {}) {
  return budget.beginRound({ cwd: dir, phase: 'quality', roles, ...options });
}
function call(ticket, role = 'integrated-reviewer') {
  return {
    cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_use_id: `tool-${Math.random()}`,
    tool_input: { task_name: 'reviewer', message: `${ticket.markers[role]}\nInspect the supplied diff.` },
  };
}
const agent = (tool_input, tool_name = 'Agent') => ({ cwd: dir, tool_name, tool_input });
const isReview = (tool_input, tool_name) => budget.checkReview(agent(tool_input, tool_name)).review;

test('descriptions that are reviews are refused without a reservation, while production and fixes are not (#141)', () => {
  const reviews = ['スライドのデザインレビュー', 'デザインのレビュー', 'Visual design review', '統合レビュー', 'Reviewing docs',
    'レビュー画面のデザインレビュー', 'review-budget フック修正のレビュー', 'レビュー指摘の反映後の再レビュー',
    'Review hook fix', 'Review API implementation', 'Review settings update', 'コードレビュー'];
  for (const description of reviews) expect([description, isReview({ description, prompt: 'x' })]).toEqual([description, true]);
  const work = ['デザイン制作', 'スライド制作', 'Review fixes', 'レビュー指摘の反映', 'レビュー指摘の修正', 'レビュー機能を実装する',
    'Implement review budget', 'Add review feature', 'Fix reviewBudget hook', 'review-budget フックの修正', 'Implement task 3', 'Preview the page'];
  for (const description of work) expect([description, isReview({ description, prompt: 'x' })]).toEqual([description, false]);
});

test('names that are reviews are refused, including roles without a review word', () => {
  for (const name of ['designReviewer', 'ux-レビュアー', 'helm-doc-reviewer', 'falsification-qa', 'security-engineer', 'requirements-analyst',
    'performance-engineer', 'integrated-reviewer', 'verification-reviewer']) {
    expect([name, isReview({ description: 'Task 3', subagent_type: name })]).toEqual([name, true]);
  }
  expect(isReview({ description: 'Task 3', subagent_type: 'preview-builder' })).toBe(false);
  expect(isReview({ agent_type: 'helm-implementer', message: 'Implement it' }, 'spawn_agent')).toBe(false);
});

test('a HELM_REVIEW quotation outside the first line is not a marker (#141)', () => {
  const quoted = `HELM_REVIEW:${'0'.repeat(32)}:integrated-reviewer`;
  expect(budget.checkReview(agent({ description: 'Implement task 3', prompt: 'Edit TOKEN so it matches HELM_REVIEW: lines' })).allowed).toBe(true);
  expect(budget.checkReview(agent({ description: 'Implement task 3', prompt: `do the work\n${quoted}\nmore` })).allowed).toBe(true);
  const misplaced = budget.checkReview(agent({ description: '統合レビュー', prompt: `Check this\n${quoted}` }));
  expect(misplaced.allowed).toBe(false);
  expect(misplaced.reason).toMatch(/first line/);
  expect(budget.checkReview(agent({ description: 'Implement task 3', prompt: `${quoted}\nwork` })).allowed).toBe(false);
});

test('SendMessage to a reviewer needs a reservation; to a worker it does not', () => {
  const ticket = begin();
  expect(budget.checkReview(agent({ to: 'document-reviewer', message: 'もう一度見て' }, 'SendMessage')).allowed).toBe(false);
  expect(budget.checkReview(agent({ to: 'worker-7', message: 'continue' }, 'SendMessage')).review).toBe(false);
  const send = agent({ to: 'document-reviewer', message: `${ticket.markers['integrated-reviewer']}\nAgain` }, 'SendMessage');
  expect(budget.checkReview(send).allowed).toBe(true);
});

test('production reviews use the quality roster without specialists and keep quality untouched', () => {
  const run = (roles) => budget.beginRound({ cwd: dir, phase: 'production', roles });
  run(['integrated-reviewer', 'falsification-qa']);
  expect(() => run(['integrated-reviewer'])).toThrow(/Production review roles/);
  run(['verification-reviewer']);
  expect(() => run(['verification-reviewer', 'security-engineer'])).toThrow(/Production review roles/);
  run(['verification-reviewer', 'falsification-qa']);
  expect(() => run(['verification-reviewer'])).toThrow(/limit/i);
  expect(budget.status({ cwd: dir }).phases.quality).toBeUndefined();
  begin();
  expect(budget.status({ cwd: dir }).phases.quality.rounds).toHaveLength(1);
});

test('production refuses a first round without integrated-reviewer and specialists', () => {
  expect(() => budget.beginRound({ cwd: dir, phase: 'production', roles: ['security-engineer'] })).toThrow();
  expect(() => budget.beginRound({ cwd: dir, phase: 'production', roles: ['integrated-reviewer', 'security-engineer'] })).toThrow();
});

test('mutation allows one falsification-qa round and nothing else', () => {
  const run = (roles, limit) => budget.beginRound({ cwd: dir, phase: 'mutation', roles, limit });
  expect(() => run(['integrated-reviewer'])).toThrow(/falsification-qa/);
  expect(() => run(['falsification-qa'], 2)).toThrow(/fixed at 1/);
  const ticket = run(['falsification-qa']);
  expect(budget.checkReview(call(ticket, 'falsification-qa')).allowed).toBe(true);
  expect(() => run(['falsification-qa'])).toThrow(/limit/i);
  expect(() => budget.extendLimit({ cwd: dir, phase: 'mutation', rounds: 1, reason: 'owner approved one more' })).toThrow(/extended/);
});

test('requirements, design, plan and production reservations are refused on main; quality is not', () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-review-main-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: main, stdio: 'ignore' });
    for (const [phase, roles] of [['design', ['document-reviewer']], ['plan', ['document-reviewer']], ['requirements', ['document-reviewer']], ['production', ['integrated-reviewer']]]) {
      expect(() => budget.beginRound({ cwd: main, phase, roles })).toThrow(/Create a task branch/);
    }
    expect(budget.beginRound({ cwd: main, phase: 'quality', roles: ['integrated-reviewer'] }).round).toBe(1);
  } finally { fs.rmSync(main, { recursive: true, force: true }); }
  expect(budget.beginRound({ cwd: dir, phase: 'design', roles: ['document-reviewer'] }).round).toBe(1);
});

describe('extend (owner-approved increase of a limit)', () => {
  const reason = '2026-10-03 owner: one more round is fine';
  const extend = (options = {}) => budget.extendLimit({ cwd: dir, phase: 'quality', rounds: 1, reason, ...options });
  const fill = () => { begin(); begin(['verification-reviewer']); begin(['verification-reviewer']); };

  test('is refused without a usable reason, outside 1-3 rounds, for unknown or unreached phases, and leaves the state alone', () => {
    fill();
    const file = budget.status({ cwd: dir }).statePath;
    const before = fs.readFileSync(file, 'utf8');
    for (const bad of [undefined, '', '   ', 'too short', 'x'.repeat(501)]) expect(() => extend({ reason: bad })).toThrow(/reason/);
    for (const rounds of [0, 4, 1.5]) expect(() => extend({ rounds })).toThrow(/rounds/);
    expect(() => extend({ phase: 'design' })).toThrow(/No design review/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    budget.beginRound({ cwd: dir, phase: 'production', roles: ['integrated-reviewer'] });
    expect(() => extend({ phase: 'production' })).toThrow(/not reached/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).extensions).toBeUndefined();
  });

  test('adds to the ceiling without rewriting group.limit, keeps earlier records, and the state stays valid', () => {
    fill();
    expect(() => begin(['verification-reviewer'])).toThrow(/extend/);
    const file = budget.status({ cwd: dir }).statePath;
    const roundsBefore = JSON.parse(fs.readFileSync(file, 'utf8')).phases.quality.rounds;
    expect(extend({ reason: `${reason}\nsecond line` }).limit).toBe(4);
    let state = budget.status({ cwd: dir });
    expect(state.phases.quality.limit).toBe(3);
    expect(state.phases.quality.rounds).toEqual(roundsBefore);
    expect(state.extensions).toHaveLength(1);
    expect(state.extensions[0]).toMatchObject({ phase: 'quality', rounds: 1, reason: `${reason} second line` });
    begin(['verification-reviewer']);
    expect(() => begin(['verification-reviewer'])).toThrow(/limit/i);
    extend({ rounds: 2 });
    begin(['verification-reviewer']);
    begin(['verification-reviewer']);
    state = budget.status({ cwd: dir });
    expect(state.extensions).toHaveLength(2);
    expect(state.extensions[0].reason).toContain('second line');
    expect(state.phases.quality.limit).toBe(3);
    expect(state.phases.quality.rounds).toHaveLength(6);
    expect(() => begin(['verification-reviewer'])).toThrow(/limit/i);
  });

  test('a state with more rounds than limit plus extensions, or a bad extension, is invalid', () => {
    fill();
    extend();
    const file = budget.status({ cwd: dir }).statePath;
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (mutate) => { const copy = structuredClone(good); mutate(copy); fs.writeFileSync(file, JSON.stringify(copy)); };
    write((s) => { s.extensions = []; s.phases.quality.rounds.push(s.phases.quality.rounds[0]); });
    expect(() => budget.status({ cwd: dir })).toThrow(/Invalid review budget state/);
    write((s) => { s.extensions[0].rounds = 9; });
    expect(() => budget.status({ cwd: dir })).toThrow(/Invalid review budget state/);
    write((s) => { s.extensions[0].reason = ''; });
    expect(() => budget.status({ cwd: dir })).toThrow(/Invalid review budget state/);
    fs.writeFileSync(file, JSON.stringify(good));
    expect(() => budget.status({ cwd: dir })).not.toThrow();
  });

  test('messages ask for a report to the owner and never for the user to run commands', () => {
    fill();
    let limitMessage = '';
    try { begin(['verification-reviewer']); } catch (error) { limitMessage = error.message; }
    expect(limitMessage).toMatch(/owner/);
    expect(limitMessage).not.toMatch(/ask the user/i);
    fs.writeFileSync(budget.status({ cwd: dir }).statePath, '{}');
    let invalid = '';
    try { budget.status({ cwd: dir }); } catch (error) { invalid = error.message; }
    expect(invalid).toMatch(/Do not delete or edit/);
    expect(invalid).not.toMatch(/ask the user|inspect it/i);
  });
});

describe('stale lock recovery', () => {
  const lockFor = () => `${begin().statePath}.lock`;
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

  test('an old lock whose process is gone is removed, and the state file is kept', () => {
    const lock = lockFor();
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: Date.now() - 11 * 60 * 1000 }));
    expect(begin(['verification-reviewer']).round).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('a recent lock, a live owner, or an unreadable lock still stops the reservation', () => {
    const lock = lockFor();
    const old = Date.now() - 11 * 60 * 1000;
    for (const content of [JSON.stringify({ pid: deadPid(), at: Date.now() }), JSON.stringify({ pid: process.pid, at: old }), 'held']) {
      fs.writeFileSync(lock, content);
      expect(() => begin(['verification-reviewer'])).toThrow(/lock/i);
      expect(fs.existsSync(lock)).toBe(true);
    }
  });
});

describe('CLI review-budget', () => {
  const cli = path.resolve(__dirname, '../bin/cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'review-budget', ...args], { cwd: dir, encoding: 'utf8' });

  test('delegates to the project script, in the order config, .claude, .codex', () => {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'));
    const stub = (file, name) => fs.writeFileSync(file, `process.stdout.write('${name}:' + process.argv.slice(2).join(' '));`);
    stub(path.join(dir, '.codex', 'hooks', 'review-budget.cjs'), 'codex');
    expect(run('status').stdout).toBe('codex:status');
    stub(path.join(dir, '.claude', 'hooks', 'review-budget.cjs'), 'claude');
    expect(run('status').stdout).toBe('claude:status');
    stub(path.join(dir, 'scripts', 'rb.cjs'), 'config');
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ reviewBudgetScript: 'scripts/rb.cjs' }));
    const result = run('extend', '--phase', 'quality', '--rounds', '1', '--reason', 'owner approved');
    expect(result.stdout).toBe('config:extend --phase quality --rounds 1 --reason owner approved');
  });

  test('falls back to the bundled hook with a warning when the project has none', () => {
    const result = run('begin', '--phase', 'quality', '--roles', 'integrated-reviewer');
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/using the bundled one/);
    expect(JSON.parse(result.stdout).round).toBe(1);
    expect(run('extend', '--phase', 'quality', '--rounds', '1', '--reason', 'short').status).toBe(1);
  });
});

test('docs and overlays never ask the user to operate the review state and point extend at the script in use', () => {
  const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const runtime = read('shared/documents/harness-runtime.md');
  expect(runtime).toMatch(/extend/);
  expect(runtime).not.toMatch(/ユーザー自身が/);
  expect(read('shared/documents/quality-policy.md')).not.toMatch(/手動管理/);
  for (const file of ['scripts/skill-overlays/brainstorming/SKILL.md', 'scripts/skill-overlays/executing-plans/SKILL.md',
    'skills/superpowers/brainstorming/SKILL.md', 'skills/superpowers/executing-plans/SKILL.md']) {
    const text = read(file);
    expect(text).not.toMatch(/review-budget\.cjs extend/);
    expect(text).toMatch(/same review-budget script used/);
  }
  expect(read('templates/cursorrules.template')).not.toMatch(/npx @crearize\/ai-dev-helm review-budget/);
});
