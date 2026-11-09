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
    'Implement review budget', 'Add review feature', 'Fix reviewBudget hook', 'review-budget フックの修正', 'Implement task 3', 'Preview the page',
    'コードレビュー指摘の修正', '統合レビュー指摘の修正', '設計レビューの指摘を反映', 'レビュー対応', 'レビュー反映', 'レビュー修正',
    'Fix issues from code review', 'Review follow-up fixes'];
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
  expect(() => run(['verification-reviewer', 'security-engineer'])).toThrow(/Production review roles/);
  run(['verification-reviewer', 'falsification-qa']);
  // 3.6.0 (#213): production has the same two-round ceiling as quality.
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
  const fill = () => { begin(); begin(['verification-reviewer']); }; // the two-round quality limit (3.6.0, #213)

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
    expect(extend({ reason: `${reason}\nsecond line` }).limit).toBe(3);
    let state = budget.status({ cwd: dir });
    expect(state.phases.quality.limit).toBe(2);
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
    expect(state.phases.quality.limit).toBe(2);
    expect(state.phases.quality.rounds).toHaveLength(5);
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

  test('only quality, production, design and requirements limits stop for the owner; plan and mutation record and continue (#188)', () => {
    const limitFor = (phase, roles) => {
      budget.beginRound({ cwd: dir, phase, roles });
      try { budget.beginRound({ cwd: dir, phase, roles }); } catch (error) { return error.message; }
      return '';
    };
    const plan = limitFor('plan', ['document-reviewer']);
    expect(plan).toMatch(/do not stop for the owner/);
    expect(plan).toMatch(/record the remaining findings/);
    expect(plan).toMatch(/run extend yourself/);
    const mutation = limitFor('mutation', ['falsification-qa']);
    expect(mutation).toMatch(/do not stop for the owner/);
    expect(mutation).toMatch(/cannot be extended/);
    expect(mutation).not.toMatch(/run extend/);
    for (const phase of ['design', 'requirements']) {
      expect(limitFor(phase, ['document-reviewer'])).toMatch(/report the remaining findings to the owner/);
    }
    budget.beginRound({ cwd: dir, phase: 'production', roles: ['integrated-reviewer'] });
    budget.beginRound({ cwd: dir, phase: 'production', roles: ['verification-reviewer'] });
    let production = '';
    try { budget.beginRound({ cwd: dir, phase: 'production', roles: ['verification-reviewer'] }); } catch (error) { production = error.message; }
    expect(production).toMatch(/report the remaining findings to the owner/);
    fill();
    let quality = '';
    try { begin(['verification-reviewer']); } catch (error) { quality = error.message; }
    expect(quality).toMatch(/report the remaining findings to the owner/);
    expect(quality).not.toMatch(/do not stop/);
  });
});

// 3.7.2 (#234, owner's decision 2026-11-09): extend --full names the first added round a full review (round 1's roster).
describe('extend --full (the owner names the next round a full review)', () => {
  const reason = 'オーナー決定 2026-11-09: 「次の 1 巡は全員のレビュー（統合・QA・専門家 1 体まで）で回す」';
  const fill = () => { begin(['integrated-reviewer', 'falsification-qa', 'security-engineer']); begin(['verification-reviewer']); };
  const extendFull = (options = {}) => budget.extendLimit({ cwd: dir, phase: 'quality', rounds: 1, reason, full: true, ...options });

  test('only the first round the extend adds takes round 1\'s roster; the rounds after it keep the verification roster', () => {
    fill();
    expect(extendFull({ rounds: 2 })).toMatchObject({ phase: 'quality', used: 2, limit: 4, fullRound: 3 });
    expect(budget.status({ cwd: dir }).extensions).toEqual([expect.objectContaining({ phase: 'quality', rounds: 2, reason, fullRound: 3 })]);
    // Round 3: integrated-reviewer, optional falsification-qa, at most one specialist - nothing else.
    expect(() => begin(['verification-reviewer'])).toThrow(/Invalid full-round review role roster/);
    expect(() => begin(['falsification-qa'])).toThrow(/Invalid full-round/);
    expect(() => begin(['integrated-reviewer', 'security-engineer', 'performance-engineer'])).toThrow(/Invalid full-round/);
    expect(() => begin(['integrated-reviewer', 'verification-reviewer'])).toThrow(/Invalid full-round/);
    const full = begin(['integrated-reviewer', 'falsification-qa', 'requirements-analyst']);
    expect(full).toMatchObject({ round: 3, limit: 4, full: true });
    expect(Object.keys(full.markers)).toEqual(['integrated-reviewer', 'falsification-qa', 'requirements-analyst']);
    for (const role of Object.keys(full.markers)) expect(budget.checkReview(call(full, role)).allowed).toBe(true);
    // Round 4 (the second round of the same extend) is a verification round again.
    expect(() => begin(['integrated-reviewer'])).toThrow(/Later review roles must be verification-reviewer.*extend --full/);
    const after = begin(['verification-reviewer', 'falsification-qa']);
    expect(after.round).toBe(4);
    expect(after).not.toHaveProperty('full');
    expect(() => begin(['verification-reviewer'])).toThrow(/limit reached/i);
    expect(() => budget.status({ cwd: dir })).not.toThrow();
  });

  test('an extend without --full adds verification rounds only, and round 1 does not report full', () => {
    const first = begin();
    expect(first).not.toHaveProperty('full');
    begin(['verification-reviewer']);
    const plain = budget.extendLimit({ cwd: dir, phase: 'quality', rounds: 1, reason });
    expect(plain).not.toHaveProperty('fullRound');
    expect(budget.status({ cwd: dir }).extensions[0]).not.toHaveProperty('fullRound');
    expect(() => begin(['integrated-reviewer'])).toThrow(/Later review roles/);
    begin(['verification-reviewer']);
    // A later --full extend: its first round (4) is the full one.
    expect(extendFull().fullRound).toBe(4);
    expect(begin(['integrated-reviewer']).full).toBe(true);
  });

  test('production: the full round is its round-1 shape (integrated-reviewer and optional falsification-qa, no specialist)', () => {
    budget.beginRound({ cwd: dir, phase: 'production', roles: ['integrated-reviewer'] });
    budget.beginRound({ cwd: dir, phase: 'production', roles: ['verification-reviewer'] });
    expect(extendFull({ phase: 'production' }).fullRound).toBe(3);
    const prod = (roles) => budget.beginRound({ cwd: dir, phase: 'production', roles });
    expect(() => prod(['integrated-reviewer', 'security-engineer'])).toThrow(/Production review roles/);
    expect(() => prod(['verification-reviewer'])).toThrow(/Production review roles/);
    expect(prod(['integrated-reviewer', 'falsification-qa'])).toMatchObject({ round: 3, full: true });
    // quality is untouched by production's extend.
    begin();
    expect(() => begin(['integrated-reviewer'])).toThrow(/Later review roles/);
  });

  test('refused for the document phases and mutation, with a value, without a reason, or below the limit - the state stays', () => {
    fill();
    for (const phase of ['design', 'requirements', 'plan']) {
      budget.beginRound({ cwd: dir, phase, roles: ['document-reviewer'] });
      expect(() => extendFull({ phase })).toThrow(/--full is only for the quality and production reviews/);
    }
    expect(() => extendFull({ phase: 'mutation' })).toThrow(/can be extended/);
    const file = budget.status({ cwd: dir }).statePath;
    const before = fs.readFileSync(file, 'utf8');
    for (const bad of ['true', 1, null]) expect(() => extendFull({ full: bad })).toThrow(/--full takes no value/);
    for (const bad of [undefined, '', 'too short']) expect(() => extendFull({ reason: bad })).toThrow(/--reason is required.*for --full/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    budget.beginRound({ cwd: dir, phase: 'production', roles: ['integrated-reviewer'] });
    const reserved = fs.readFileSync(file, 'utf8');
    expect(() => extendFull({ phase: 'production' })).toThrow(/not reached/);
    expect(fs.readFileSync(file, 'utf8')).toBe(reserved);
  });

  test('a full round outside its extend, on a document phase, or a full roster without the record makes the state invalid', () => {
    fill();
    extendFull({ rounds: 2 });
    begin(['integrated-reviewer', 'falsification-qa']);
    const file = budget.status({ cwd: dir }).statePath;
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (mutate) => { const copy = structuredClone(good); mutate(copy); fs.writeFileSync(file, JSON.stringify(copy)); };
    for (const mutate of [
      (s) => { delete s.extensions[0].fullRound; }, // round 3's full roster without the owner's --full
      (s) => { s.extensions[0].fullRound = 4; }, // the record moved off round 3
      (s) => { s.extensions[0].fullRound = 2; }, // within the phase's own limit
      (s) => { s.phases.quality.rounds.splice(1); s.extensions[0].fullRound = 2; }, // ...even before round 2 is reserved
      (s) => { s.extensions[0].fullRound = 1; },
      (s) => { s.extensions[0].fullRound = 9; }, // past the ceiling
      (s) => { s.extensions[0].fullRound = '3'; },
      (s) => { s.extensions.push({ phase: 'design', rounds: 1, reason, at: s.extensions[0].at, fullRound: 2 }); },
    ]) {
      write(mutate);
      expect(() => budget.status({ cwd: dir })).toThrow(/Invalid review budget state/);
    }
    fs.writeFileSync(file, JSON.stringify(good));
    expect(() => budget.status({ cwd: dir })).not.toThrow();
  });

  test('a second loss of a full round below the limit names the verification roster for the next round', () => {
    const lost = 'the session ended before the full round returned';
    fill();
    extendFull({ rounds: 2 });
    const full = begin(['integrated-reviewer', 'falsification-qa']);
    expect(budget.checkReview(call(full)).allowed).toBe(true);
    budget.retakeRound({ cwd: dir, phase: 'quality', round: 3, reason: lost });
    expect(() => budget.retakeRound({ cwd: dir, phase: 'quality', round: 3, reason: lost }))
      .toThrow(/reserve the next round with begin \(it is within the limit\).*its roster is verification-reviewer and optional falsification-qa/);
  });

  test('when the next round is itself a full round (a second extend --full), the second loss does not name the verification roster', () => {
    const lost = 'the session ended before the full round returned';
    fill();
    extendFull();
    const full = begin(['integrated-reviewer']);
    expect(budget.checkReview(call(full)).allowed).toBe(true);
    budget.retakeRound({ cwd: dir, phase: 'quality', round: 3, reason: lost });
    // At the limit (3/3): the limit's rule - the owner decides; they approve another full round.
    expect(() => budget.retakeRound({ cwd: dir, phase: 'quality', round: 3, reason: lost })).toThrow(/report the remaining findings to the owner/);
    expect(extendFull().fullRound).toBe(4);
    let message = '';
    try { budget.retakeRound({ cwd: dir, phase: 'quality', round: 3, reason: lost }); } catch (error) { message = error.message; }
    expect(message).toMatch(/reserve the next round with begin \(it is within the limit\)/);
    expect(message).not.toMatch(/its roster is verification-reviewer/);
    expect(begin(['integrated-reviewer', 'falsification-qa'])).toMatchObject({ round: 4, full: true });
  });

  test('runCommand reads --full as a flag of extend only, once', () => {
    fill();
    expect(() => budget.runCommand(['extend', '--phase', 'quality', '--rounds', '1', '--full', 'yes', '--reason', reason], dir)).toThrow(/Usage/);
    expect(() => budget.runCommand(['extend', '--full', '--full', '--phase', 'quality', '--rounds', '1', '--reason', reason], dir)).toThrow(/Usage/);
    expect(() => budget.runCommand(['begin', '--phase', 'quality', '--roles', 'integrated-reviewer', '--full'], dir)).toThrow(/Usage/);
    expect(() => budget.runCommand(['retake', '--full', '--phase', 'quality', '--round', '2', '--reason', reason], dir)).toThrow(/Usage/);
    expect(budget.status({ cwd: dir }).extensions).toBeUndefined();
    expect(budget.runCommand(['extend', '--phase', 'quality', '--full', '--rounds', '1', '--reason', reason], dir)).toMatchObject({ limit: 3, fullRound: 3 });
    expect(budget.runCommand(['begin', '--phase', 'quality', '--roles', 'integrated-reviewer,security-engineer'], dir)).toMatchObject({ round: 3, full: true });
  });
});

describe('lock recovery (3.7.0: never by age)', () => {
  const lockFor = () => `${begin().statePath}.lock`;

  const age = (lock, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(lock, t, t); };

  test('an old lock is not reclaimed by its age: the reservation stops and the lock and the state stay', () => {
    // Until 3.6.0 a lock older than 10 minutes was renamed away and removed. 3.7.0 takes in MovieMarketer's
    // MM-REVIEW-PATCH 5 (#2027): a timestamp cannot prove a lock is abandoned, and stat -> rename can remove a
    // successor's fresh lock. Break: the age-based reclamation coming back lets this reservation through.
    const lock = lockFor();
    const before = fs.readFileSync(lock.replace(/\.lock$/, ''), 'utf8');
    fs.writeFileSync(lock, '');
    age(lock, 60 * 60 * 1000);
    expect(() => begin(['verification-reviewer'])).toThrow(/not reclaimed by age/);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock.replace(/\.lock$/, ''), 'utf8')).toBe(before);
  });

  test('a held lock still stops the reservation', () => {
    const lock = lockFor();
    for (const content of ['', 'held', JSON.stringify({ pid: process.pid, at: Date.now() })]) {
      fs.writeFileSync(lock, content);
      expect(() => begin(['verification-reviewer'])).toThrow(/lock/i);
      expect(fs.existsSync(lock)).toBe(true);
    }
  });
});

// 3.7.2 (#234): a round whose reviewers' results were lost (the session ended before they returned) is retaken once,
// within the limit - the started seats get a new marker; no round is added.
describe('retake (a round whose reviewers\' results were lost)', () => {
  const reason = 'the session ended before integrated-reviewer returned';
  const retake = (options = {}) => budget.retakeRound({ cwd: dir, phase: 'quality', round: 1, reason, ...options });
  const admit = (ticket, role = 'integrated-reviewer') => budget.checkReview(call(ticket, role));

  test('gives the started seats of the latest round a new marker, once, without adding a round', () => {
    const first = begin(['integrated-reviewer', 'falsification-qa']);
    expect(admit(first).allowed).toBe(true);
    expect(admit(first, 'falsification-qa').allowed).toBe(true);
    const again = retake();
    expect(again).toMatchObject({ phase: 'quality', round: 1, retake: 1, limit: 2 });
    expect(Object.keys(again.markers)).toEqual(['integrated-reviewer', 'falsification-qa']);
    expect(again.markers['integrated-reviewer']).not.toBe(first.markers['integrated-reviewer']);
    // Each retaken seat once; the round's own seats stay used.
    expect(admit(again).allowed).toBe(true);
    expect(admit(again).reason).toMatch(/already used/);
    expect(admit(first).reason).toMatch(/already used/);
    const state = budget.status({ cwd: dir });
    expect(state.phases.quality.rounds).toHaveLength(1);
    expect(state.phases.quality.rounds[0].retakes).toEqual([expect.objectContaining({ roles: ['integrated-reviewer', 'falsification-qa'], reason, used: { 'integrated-reviewer': expect.any(Object) } })]);
    // Once per round: below the limit a second loss goes to the next round (no extend - it is refused below the limit).
    expect(() => retake()).toThrow(/already retaken once \(its results are lost again\); reserve the next round with begin \(it is within the limit\)/);
    expect(() => retake()).not.toThrow(/extend/);
    // C3-M1: round 1's seats (integrated-reviewer, a specialist) cannot be reserved again - the message says who looks.
    expect(() => retake()).toThrow(/its roster is verification-reviewer and optional falsification-qa: have them review the whole change from the lost seats' viewpoints$/);
    // The limit is the same: round 2 is the last one before extend.
    const second = begin(['verification-reviewer']);
    expect(() => begin(['verification-reviewer'])).toThrow(/limit reached/i);
    // At the limit a second loss is the limit's rule - in quality, the owner decides.
    expect(admit(second, 'verification-reviewer').allowed).toBe(true);
    retake({ round: 2 });
    expect(() => retake({ round: 2 })).toThrow(/Round 2 of quality was already retaken once \(its results are lost again\); report the remaining findings to the owner/);
  });

  // C4-M2: the roster note is for round 1 of quality and production only (later rounds there take the verification roster).
  test('a second loss below the limit names the verification roster only for round 1 of quality and production', () => {
    const owner = "オーナー承認 2026-11-08: 「延長を承認します」";
    const secondLoss = (phase, round) => {
      try { budget.retakeRound({ cwd: dir, phase, round, reason }); budget.retakeRound({ cwd: dir, phase, round, reason }); } catch (error) { return error.message; }
      return '';
    };
    const roster = /its roster is verification-reviewer and optional falsification-qa/;
    const below = /reserve the next round with begin \(it is within the limit\)/;
    const started = (ticket, role) => expect(budget.checkReview(call(ticket, role)).allowed).toBe(true);
    // production, round 1 (limit 2): the note.
    started(budget.beginRound({ cwd: dir, phase: 'production', roles: ['integrated-reviewer'] }), 'integrated-reviewer');
    const production = secondLoss('production', 1);
    expect(production).toMatch(below);
    expect(production).toMatch(roster);
    // quality, round 2 below the limit after extend: begin, without the note (round 2's roster is already that one).
    started(begin(['integrated-reviewer']), 'integrated-reviewer');
    started(begin(['verification-reviewer']), 'verification-reviewer');
    budget.extendLimit({ cwd: dir, phase: 'quality', rounds: 1, reason: owner });
    const quality = secondLoss('quality', 2);
    expect(quality).toMatch(below);
    expect(quality).not.toMatch(roster);
    // design, round 1 below the limit after extend: begin, without the note (one document-reviewer in every round).
    started(budget.beginRound({ cwd: dir, phase: 'design', roles: ['document-reviewer'] }), 'document-reviewer');
    budget.extendLimit({ cwd: dir, phase: 'design', rounds: 1, reason: owner });
    const design = secondLoss('design', 1);
    expect(design).toMatch(below);
    expect(design).not.toMatch(roster);
    // And each of those next rounds begins with the roster the message names.
    expect(budget.beginRound({ cwd: dir, phase: 'production', roles: ['verification-reviewer', 'falsification-qa'] }).round).toBe(2);
    expect(begin(['verification-reviewer']).round).toBe(3);
    expect(budget.beginRound({ cwd: dir, phase: 'design', roles: ['document-reviewer'] }).round).toBe(2);
  });

  test('a second loss in plan or mutation is handled as their limit is: recorded, without stopping for the owner', () => {
    // development-policy §1.0: plan and mutation do not wait for the owner at the limit; a lost retake is the same.
    for (const [phase, role, more] of [['plan', 'document-reviewer', /Only if the owner has already approved another round/], ['mutation', 'falsification-qa', /The mutation limit cannot be extended/]]) {
      const first = budget.beginRound({ cwd: dir, phase, roles: [role] });
      expect(budget.checkReview(call(first, role)).allowed).toBe(true);
      budget.retakeRound({ cwd: dir, phase, round: 1, reason });
      let message = '';
      try { budget.retakeRound({ cwd: dir, phase, round: 1, reason }); } catch (error) { message = error.message; }
      expect(message).toMatch(/already retaken once \(its results are lost again\); do not stop for the owner: record the remaining findings/);
      expect(message).toMatch(more);
      expect(message).not.toMatch(/report the remaining findings to the owner/);
    }
  });

  test('a subset of the started roles; a seat never started, an unknown role, an earlier round and a missing reason are refused', () => {
    const first = begin(['integrated-reviewer', 'falsification-qa']);
    expect(() => retake()).toThrow(/No reviewer of round 1 has started/);
    admit(first, 'falsification-qa');
    expect(() => retake({ roles: ['integrated-reviewer'] })).toThrow(/has not started; start it with the round's own marker/);
    expect(() => retake({ roles: ['verification-reviewer'] })).toThrow(/not a role of round 1/);
    expect(() => retake({ roles: ['falsification-qa', 'falsification-qa'] })).toThrow(/unique list/);
    for (const bad of [undefined, '', 'too short', 'x'.repeat(501)]) expect(() => retake({ reason: bad })).toThrow(/--reason is required/);
    for (const round of [0, 1.5, undefined]) expect(() => retake({ round })).toThrow(/--round/);
    expect(() => retake({ phase: 'design' })).toThrow(/No design review/);
    const qa = retake({ roles: ['falsification-qa'] });
    expect(Object.keys(qa.markers)).toEqual(['falsification-qa']);
    // The never-started seat still takes the round's own marker.
    expect(admit(first).allowed).toBe(true);
    const second = begin(['verification-reviewer']);
    // A later round closes the earlier round's retake, and only the latest round is retaken.
    expect(admit(qa, 'falsification-qa').reason).toMatch(/Unknown or closed/);
    expect(() => retake({ round: 1 })).toThrow(/Only the latest quality round \(2\) can be retaken/);
    admit(second, 'verification-reviewer');
    expect(retake({ round: 2 }).markers).toHaveProperty('verification-reviewer');
  });

  test('a follow-up to a retaken reviewer is counted, and a bad retake record makes the state invalid', () => {
    const first = begin();
    admit(first);
    const again = retake();
    expect(() => budget.recordAgent({ ...call(again), hook_event_name: 'PostToolUse', tool_response: { agent_id: 'agent-retaken' } })).toThrow(/No admitted review/);
    expect(admit(again).allowed).toBe(true);
    budget.recordAgent({ ...call(again), hook_event_name: 'PostToolUse', tool_response: { agent_id: 'agent-retaken' } });
    expect(budget.status({ cwd: dir }).agents['agent-retaken']).toBe(true);
    expect(budget.checkReview(agent({ to: 'agent-retaken', message: 'one more look' }, 'SendMessage')).allowed).toBe(false);
    const file = budget.status({ cwd: dir }).statePath;
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (mutate) => { const copy = structuredClone(good); mutate(copy); fs.writeFileSync(file, JSON.stringify(copy)); };
    for (const mutate of [
      (s) => { s.phases.quality.rounds[0].retakes.push(s.phases.quality.rounds[0].retakes[0]); },
      (s) => { s.phases.quality.rounds[0].retakes[0].roles = ['verification-reviewer']; },
      (s) => { s.phases.quality.rounds[0].retakes[0].reason = 'short'; },
      (s) => { s.phases.quality.rounds[0].retakes[0].token = 'x'; },
      (s) => { s.phases.quality.rounds[0].retakes = {}; },
    ]) {
      write(mutate);
      expect(() => budget.status({ cwd: dir })).toThrow(/Invalid review budget state/);
    }
    fs.writeFileSync(file, JSON.stringify(good));
    expect(() => budget.status({ cwd: dir })).not.toThrow();
  });
});

describe('CLI review-budget', () => {
  const cli = path.resolve(__dirname, '../bin/cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'review-budget', ...args], { cwd: dir, encoding: 'utf8' });

  test('delegates to the project script, in the order config, .claude, .codex', () => {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'));
    const stub = (file, name) => fs.writeFileSync(file, `/* function extendLimit */ process.stdout.write('${name}:' + process.argv.slice(2).join(' '));`);
    stub(path.join(dir, '.codex', 'hooks', 'review-budget.cjs'), 'codex');
    expect(run('status').stdout).toBe('codex:status');
    stub(path.join(dir, '.claude', 'hooks', 'review-budget.cjs'), 'claude');
    expect(run('status').stdout).toBe('claude:status');
    stub(path.join(dir, 'scripts', 'rb.cjs'), 'config');
    fs.writeFileSync(path.join(dir, '.ai-dev-helm.json'), JSON.stringify({ reviewBudgetScript: 'scripts/rb.cjs' }));
    const result = run('extend', '--phase', 'quality', '--rounds', '1', '--reason', 'owner approved');
    expect(result.stdout).toBe('config:extend --phase quality --rounds 1 --reason owner approved');
  });

  test('rebuilds arguments from parsed values so --phase=design works', () => {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'review-budget.cjs'), "/* function extendLimit */ process.stdout.write(process.argv.slice(2).join(' '));");
    expect(run('begin', '--phase=design', '--roles=document-reviewer').stdout).toBe('begin --phase design --roles document-reviewer');
  });

  test('a project hook without extend (3.2.x) gets a clear upgrade message and exit 1', () => {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'review-budget.cjs'), "process.stdin.resume(); process.stdout.write('old');");
    const result = run('extend', '--phase', 'quality', '--rounds', '1', '--reason', 'owner approved it');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/older.*harness-upgrade/);
    expect(result.stdout).toBe('');
  });

  test('retake: passed to the project script, and a project hook without retake (before 3.7.2) gets the upgrade message', () => {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    const file = path.join(dir, '.claude', 'hooks', 'review-budget.cjs');
    fs.writeFileSync(file, "/* function extendLimit */ process.stdout.write(process.argv.slice(2).join(' '));");
    const old = run('retake', '--phase', 'quality', '--round', '1', '--reason', 'the session ended early');
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/does not support retake.*harness-upgrade/);
    fs.writeFileSync(file, "/* function retakeRound */ process.stdout.write(process.argv.slice(2).join(' '));");
    expect(run('retake', '--phase', 'quality', '--round', '1', '--roles', 'falsification-qa', '--reason', 'the session ended early').stdout)
      .toBe('retake --phase quality --roles falsification-qa --round 1 --reason the session ended early');
  });

  // 3.7.2: extend --full is passed on as a flag; a project hook without it (before 3.7.2) gets the upgrade message.
  test('extend --full: passed to the project script; a project hook without --full gets the upgrade message, plain extend still runs', () => {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    const file = path.join(dir, '.claude', 'hooks', 'review-budget.cjs');
    fs.writeFileSync(file, "/* function extendLimit function retakeRound */ process.stdout.write(process.argv.slice(2).join(' '));");
    const old = run('extend', '--phase', 'quality', '--rounds', '1', '--full', '--reason', 'owner approved a full round');
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/does not support extend --full.*harness-upgrade/);
    expect(old.stdout).toBe('');
    expect(run('extend', '--phase', 'quality', '--rounds', '1', '--reason', 'owner approved one more').stdout)
      .toBe('extend --phase quality --rounds 1 --reason owner approved one more');
    fs.writeFileSync(file, "/* function extendLimit FULL_ROUND_PHASES */ process.stdout.write(process.argv.slice(2).join(' '));");
    expect(run('extend', '--phase', 'quality', '--rounds', '1', '--full', '--reason', 'owner approved a full round').stdout)
      .toBe('extend --phase quality --rounds 1 --reason owner approved a full round --full');
  });

  test('extend --full through the bundled hook: the next round takes round 1\'s roster', () => {
    const begin1 = run('begin', '--phase', 'quality', '--roles', 'integrated-reviewer');
    expect(begin1.status).toBe(0);
    expect(run('begin', '--phase', 'quality', '--roles', 'verification-reviewer').status).toBe(0);
    const extended = run('extend', '--phase', 'quality', '--rounds', '1', '--full', '--reason', 'owner approved a full round');
    expect(extended.status).toBe(0);
    expect(JSON.parse(extended.stdout)).toMatchObject({ limit: 3, fullRound: 3 });
    const full = run('begin', '--phase', 'quality', '--roles', 'integrated-reviewer,falsification-qa');
    expect(JSON.parse(full.stdout)).toMatchObject({ round: 3, full: true });
    expect(run('begin', '--phase', 'quality', '--full', '--roles', 'integrated-reviewer').status).toBe(1);
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
