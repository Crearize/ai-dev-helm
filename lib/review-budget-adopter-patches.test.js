const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

// 3.7.0 (C3i): MovieMarketer's local review-budget patches, taken into the distributed hook, with the regression
// cases moved from its .claude/hooks/review-budget.test.cjs:
//   MM-REVIEW-PATCH 1 - parallel Pre/PostToolUse calls wait up to 2 s for the lock instead of failing at once;
//   MM-REVIEW-PATCH 3 - Codex's agent_name, underscore-separated names, and the code-mode bridge's collaboration*
//                       tools with the token / role in task_name (helm_review_<token>_<role>);
//   MM-REVIEW-PATCH 5 - the owned lock is renamed before its file is deleted, and no lock is reclaimed by age (#2027).
// MM-REVIEW-PATCH 4 (the seat / agent binding and resultAdmitted) is not taken in: it served the quality receipt that
// 3.7.0 removes (design C3l).

const modulePath = path.resolve(__dirname, '../templates/hooks/review-budget.cjs');
const budget = require(modulePath);
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm review budget patches '));
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: dir, stdio: 'ignore' });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const reserve = (roles = ['integrated-reviewer'], phase = 'quality') => budget.beginRound({ cwd: dir, phase, roles });
const tokenOf = (ticket, role = 'integrated-reviewer') => ticket.markers[role].split(':')[1];
let delivery = 0;
const request = (ticket, role = 'integrated-reviewer') => ({
  cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `delivery-${++delivery}`,
  tool_input: { description: 'Code review', name: `${role}-reviewer`, prompt: ticket.markers[role] },
});
const runHook = (payload) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [modulePath], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0 || stderr) reject(new Error(`hook failed (${code}): ${stderr}`));
    else resolve(stdout.trim() ? JSON.parse(stdout) : null);
  });
  child.stdin.end(JSON.stringify(payload));
});
const usedRoles = () => Object.keys(budget.status({ cwd: dir }).phases.quality.rounds.at(-1).used);

describe('MM-REVIEW-PATCH 1: a held lock is waited on briefly', () => {
  test('temporary contention waits for the owner; a lock that stays still fails closed and is kept', async () => {
    // Break: failing at once on EEXIST denies a reserved review whenever Pre/PostToolUse calls overlap.
    const ticket = reserve();
    const lock = `${ticket.statePath}.lock`;
    const holder = spawn(process.execPath, ['-e',
      "const f=require('node:fs');const p=process.argv[1];const fd=f.openSync(p,'wx');process.stdout.write('ready');setTimeout(()=>{f.closeSync(fd);f.unlinkSync(p)},1000)", lock],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        holder.once('error', reject);
        holder.stdout.once('data', resolve);
        holder.once('exit', (code) => { if (code !== 0) reject(new Error(`lock holder exited ${code}`)); });
      });
      expect(budget.checkReview(request(ticket)).allowed).toBe(true);
    } finally {
      if (holder.exitCode === null) holder.kill();
    }
    fs.writeFileSync(lock, 'persistent test lock');
    const blocked = budget.checkReview(request(ticket, 'integrated-reviewer'));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/lock/i);
    expect(fs.readFileSync(lock, 'utf8')).toBe('persistent test lock');
  });

  test('parallel hook processes admit every reserved seat and record every reviewer id', async () => {
    const roles = ['integrated-reviewer', 'falsification-qa', 'security-engineer'];
    const ticket = reserve(roles);
    const inputs = roles.map((role) => request(ticket, role));
    expect(await Promise.all(inputs.map((input) => runHook(input)))).toEqual([null, null, null]);
    expect(await Promise.all(inputs.map((input, i) => runHook({ ...input, hook_event_name: 'PostToolUse', tool_response: { agentId: `opaque-${i}` } }))))
      .toEqual([null, null, null]);
    expect(usedRoles().sort()).toEqual([...roles].sort());
    for (let i = 0; i < 3; i++) {
      // Every id was recorded, so resuming any of them without a new reservation is a review that is refused.
      expect(budget.checkReview({ cwd: dir, tool_name: 'Agent', tool_input: { resume: `opaque-${i}`, prompt: 'Check the fix' } }).allowed).toBe(false);
    }
    expect(budget.status({ cwd: dir }).phases.quality.rounds).toHaveLength(1);
  }, 60000);

  test('an error other than EEXIST is not retried and changes nothing', () => {
    const ticket = reserve();
    const lock = `${ticket.statePath}.lock`;
    const before = fs.readFileSync(ticket.statePath, 'utf8');
    const original = fs.openSync;
    let attempts = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      if (file === lock && flags === 'wx') {
        attempts++;
        throw Object.assign(new Error('permanent permission denial'), { code: 'EPERM' });
      }
      return original(file, flags, ...args);
    });
    const denied = budget.checkReview(request(ticket));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/EPERM/);
    expect(attempts).toBe(1);
    expect(fs.readFileSync(ticket.statePath, 'utf8')).toBe(before);
  });
});

describe('MM-REVIEW-PATCH 5: the owned lock is retired before deletion, and never reclaimed by age', () => {
  // #2027 oracle: Windows denies an exclusive open of a delete-pending name. Retiring one owner's file must not deny
  // or delete the next owner's lock.
  test('a successor can take the lock while the previous file deletion is pending', () => {
    const ticket = reserve();
    const lock = `${ticket.statePath}.lock`;
    const original = { open: fs.openSync, unlink: fs.unlinkSync, close: fs.closeSync };
    let pendingName;
    let ownerFd;
    let successorFd;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      if (file === pendingName && flags === 'wx') throw Object.assign(new Error('delete-pending name'), { code: 'EPERM' });
      const fd = original.open(file, flags, ...args);
      if (file === lock && flags === 'wx' && ownerFd === undefined) ownerFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      original.unlink(file);
      if (pendingName === undefined && String(file).startsWith(lock)) {
        expect(() => fs.fstatSync(ownerFd)).toThrow(expect.objectContaining({ code: 'EBADF' })); // closed before deletion
        pendingName = file;
        successorFd = fs.openSync(lock, 'wx', 0o600);
        fs.writeSync(successorFd, 'successor-owned-lock');
      }
    });
    try {
      expect(() => budget.status({ cwd: dir })).not.toThrow();
      expect(successorFd).not.toBeUndefined();
      expect(fs.readFileSync(lock, 'utf8')).toBe('successor-owned-lock');
      expect(fs.readdirSync(path.dirname(lock)).filter((name) => name.startsWith(path.basename(lock)))).toEqual([path.basename(lock)]);
    } finally {
      if (successorFd !== undefined) original.close(successorFd);
    }
  });

  test('a failed retirement closes its fd and keeps the public lock', () => {
    const ticket = reserve();
    const lock = `${ticket.statePath}.lock`;
    const before = fs.readFileSync(ticket.statePath, 'utf8');
    const original = { open: fs.openSync, rename: fs.renameSync };
    const failure = Object.assign(new Error('retirement denied'), { code: 'EACCES' });
    let ownerFd;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      const fd = original.open(file, flags, ...args);
      if (file === lock && flags === 'wx') ownerFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === lock) throw failure;
      return original.rename(from, to);
    });
    expect(() => budget.status({ cwd: dir })).toThrow(failure);
    expect(() => fs.fstatSync(ownerFd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(fs.existsSync(lock)).toBe(true); // never falls back to unlinking the public name
    expect(fs.readFileSync(ticket.statePath, 'utf8')).toBe(before);
  });

  test('a failed ownership record closes its fd without granting admission', () => {
    const ticket = reserve();
    const lock = `${ticket.statePath}.lock`;
    const before = fs.readFileSync(ticket.statePath, 'utf8');
    const original = { open: fs.openSync, write: fs.writeSync };
    const failure = Object.assign(new Error('ownership record write failed'), { code: 'EIO' });
    let ownerFd;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      const fd = original.open(file, flags, ...args);
      if (file === lock && flags === 'wx') ownerFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'writeSync').mockImplementation((fd, ...args) => {
      if (fd === ownerFd) throw failure;
      return original.write(fd, ...args);
    });
    try {
      expect(() => budget.status({ cwd: dir })).toThrow(failure);
      expect(() => fs.fstatSync(ownerFd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
      expect(fs.existsSync(lock)).toBe(true); // a failed acquisition is no ground to unlink a public lock
      expect(fs.readFileSync(ticket.statePath, 'utf8')).toBe(before);
    } finally {
      vi.restoreAllMocks();
      try { fs.closeSync(ownerFd); } catch (error) { if (error.code !== 'EBADF') throw error; }
    }
  });

  test('a failed cleanup of the temporary state still releases the owned fd and the public name', () => {
    const ticket = reserve();
    const lock = `${ticket.statePath}.lock`;
    const before = fs.readFileSync(ticket.statePath, 'utf8');
    const original = { open: fs.openSync, rename: fs.renameSync, unlink: fs.unlinkSync };
    const cleanupFailure = Object.assign(new Error('temporary state cleanup denied'), { code: 'EPERM' });
    let ownerFd;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      const fd = original.open(file, flags, ...args);
      if (file === lock && flags === 'wx') ownerFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === ticket.statePath) throw Object.assign(new Error('state publication failed'), { code: 'EIO' });
      return original.rename(from, to);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file).startsWith(ticket.statePath) && String(file).endsWith('.tmp')) throw cleanupFailure;
      return original.unlink(file);
    });
    try {
      expect(() => reserve(['verification-reviewer'])).toThrow(cleanupFailure);
      expect(() => fs.fstatSync(ownerFd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readFileSync(ticket.statePath, 'utf8')).toBe(before); // a failed publication consumes no round
    } finally {
      vi.restoreAllMocks();
      for (const name of fs.readdirSync(path.dirname(lock)).filter((n) => n.endsWith('.tmp'))) fs.rmSync(path.join(path.dirname(lock), name), { force: true });
    }
  });

  test('an old lock does not let competing callers reclaim it', () => {
    const roles = ['integrated-reviewer', 'falsification-qa'];
    const ticket = reserve(roles);
    const lock = `${ticket.statePath}.lock`;
    const before = fs.readFileSync(ticket.statePath, 'utf8');
    const owner = 'still-owned-even-if-its-clock-is-old';
    const held = fs.openSync(lock, 'wx', 0o600);
    let closed = false;
    try {
      fs.writeSync(held, owner);
      const old = new Date(Date.now() - 11 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      expect(roles.map((role) => budget.checkReview(request(ticket, role)).allowed)).toEqual([false, false]);
      expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
      expect(fs.readFileSync(ticket.statePath, 'utf8')).toBe(before);
      fs.closeSync(held);
      closed = true;
      fs.unlinkSync(lock); // only this test's owner releases its own fixture
      expect(budget.checkReview(request(ticket)).allowed).toBe(true); // the refused attempts consumed no seat
    } finally {
      if (!closed) fs.closeSync(held);
    }
  });
});

describe('MM-REVIEW-PATCH 3: Codex agent names and the code-mode bridge', () => {
  test('a bridged collaborationspawn_agent with the ticket in task_name takes exactly that seat', () => {
    // Break: without the bridge the call is no review candidate, takes no seat, and a second launch is not refused.
    const ticket = reserve();
    const task = `helm_review_${tokenOf(ticket)}_integrated_reviewer`;
    const input = { cwd: dir, tool_name: 'collaborationspawn_agent', tool_use_id: 'bridge-seat', tool_input: { task_name: task, message: 'opaque' } };
    expect(budget.checkReview(input)).toEqual({ review: true, allowed: true });
    expect(usedRoles()).toEqual(['integrated-reviewer']);
    expect(budget.checkReview({ ...input, tool_use_id: 'bridge-seat-again' }).allowed).toBe(false); // the seat is used
    // The returned alias is tracked: a follow-up to it is a review that needs a new reservation.
    budget.recordAgent({ ...input, hook_event_name: 'PostToolUse', tool_response: { content: [{ text: JSON.stringify({ task_name: `/root/${task}` }) }] } });
    expect(budget.checkReview({ cwd: dir, tool_name: 'collaborationfollowup_task', tool_input: { target: `/root/${task}`, message: 'Check again' } }).allowed).toBe(false);
  });

  test('a bridged ticket that disagrees with the marker in the message is refused', () => {
    const ticket = reserve(['integrated-reviewer', 'falsification-qa']);
    const task = `helm_review_${tokenOf(ticket)}_integrated_reviewer`;
    const input = { cwd: dir, tool_name: 'collaborationspawn_agent', tool_input: { task_name: task, message: ticket.markers['falsification-qa'] } };
    expect(budget.checkReview(input).allowed).toBe(false);
    expect(budget.status({ cwd: dir }).phases.quality.rounds[0].used).toEqual({});
  });

  test('a ticket in task_name admits nothing outside the bridge tools', () => {
    const ticket = reserve();
    const task = `helm_review_${tokenOf(ticket)}_integrated_reviewer`;
    expect(budget.checkReview({ cwd: dir, tool_name: 'spawn_agent', tool_input: { task_name: task, message: 'no marker' } }).allowed).toBe(false);
    expect(budget.status({ cwd: dir }).phases.quality.rounds[0].used).toEqual({});
  });

  test('agent_name and underscore-separated names are read as reviewer names', () => {
    // Break: Codex 0.163's agent_name / integrated_reviewer slipped past as ordinary workers.
    for (const tool_input of [{ agent_name: 'integrated-reviewer', message: 'go' }, { task_name: 'falsification_qa', message: 'go' }, { agent_name: 'security_engineer', message: 'go' }]) {
      expect(budget.checkReview({ cwd: dir, tool_name: 'spawn_agent', tool_input }).allowed, JSON.stringify(tool_input)).toBe(false);
    }
    for (const tool_input of [{ agent_name: 'implementer', message: 'go' }, { task_name: 'test_runner', message: 'go' }]) {
      expect(budget.checkReview({ cwd: dir, tool_name: 'spawn_agent', tool_input }), JSON.stringify(tool_input)).toEqual({ review: false, allowed: true });
    }
  });

  test('an agent_name in the admission and in the returned response is tracked', () => {
    const ticket = reserve();
    const input = { cwd: dir, tool_name: 'spawn_agent', tool_use_id: 'named', tool_input: { agent_name: 'helper-one', message: ticket.markers['integrated-reviewer'] } };
    expect(budget.checkReview(input).allowed).toBe(true);
    budget.recordAgent({ ...input, hook_event_name: 'PostToolUse', tool_response: { agent_name: 'returned-two' } });
    for (const target of ['helper-one', 'returned-two']) {
      expect(budget.checkReview({ cwd: dir, tool_name: 'followup_task', tool_input: { target, message: 'Check again' } }).allowed, target).toBe(false);
    }
  });
});
