const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { PACKAGE_ROOT } = require('./utils');
const { classify } = require('../templates/hooks/quality-gate.cjs');

// 3.3.0 P8' / P10' (#162, #163): the flag is bound to the commit the trunk
// receives (H-11), trunk rewrites without a gate word (H-13, H-19(c)), another
// repository's gh call (H-19(a)), a push whose @{push} is the trunk (H-19(d)),
// the harness exemption limited to documents (H-47, H-48, H-21), the
// pull-request hint, and a shell call with no readable command (H-52(5)).

const MAIN = '1111111111111111111111111111111111111111';
const FEAT = '2222222222222222222222222222222222222222';
const OLD = '3333333333333333333333333333333333333333';
const ORIGIN = '4444444444444444444444444444444444444444';

// A stub ctx: main at MAIN, feature at FEAT one commit ahead of it (with a
// code change), origin/main at ORIGIN behind main, and OLD a branch main has
// already merged. Every value is a lazy getter, like the real ctx.
const stub = (over = {}) => {
  const commits = { HEAD: over.head || FEAT, main: MAIN, 'refs/heads/main': MAIN, feature: FEAT, old: OLD, 'origin/main': ORIGIN, 'refs/remotes/origin/main': ORIGIN, ...(over.commits || {}) };
  // a is an ancestor of b.
  const order = over.order || [[ORIGIN, MAIN], [ORIGIN, FEAT], [MAIN, FEAT], [OLD, MAIN], [OLD, FEAT], [ORIGIN, OLD]];
  const values = {
    branch: 'main',
    head: MAIN,
    flag: null,
    isAncestor: false,
    diffSinceFlag: { files: ['src/app.js'], overrideChanged: false },
    diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
    fullRef: (name) => (name.startsWith('refs/') ? name : `refs/remotes/${name}`),
    resolveCommit: (ref) => commits[ref] || null,
    ancestor: (a, b) => order.some(([x, y]) => x === a && y === b),
    diffRange: () => ({ files: over.gained || ['src/app.js'], overrideChanged: false }),
    ...over,
  };
  delete values.commits;
  delete values.order;
  delete values.gained;
  const ctx = {};
  for (const key of Object.keys(values)) Object.defineProperty(ctx, key, { get: () => values[key], enumerable: true });
  return ctx;
};
const flagOn = (commit) => ({ flag: { commit } });
const allowed = (command, ctx) => expect(classify(command, ctx), command).toEqual({ decision: 'allow' });
const blocked = (command, ctx, rule, reason) => {
  const verdict = classify(command, ctx);
  expect(verdict.decision, command).toBe('block');
  if (rule) expect(verdict.rule, command).toBe(rule);
  if (reason) expect(verdict.reason, command).toMatch(reason);
  return verdict;
};

describe('H-11: the flag is bound to the branch being merged', () => {
  it('allows a merge of the checked branch on main, the flag naming its tip', () => {
    for (const command of ['git merge feature', 'git merge --no-ff feature', 'git merge --no-ff -m "x" feature', 'git rebase feature']) {
      allowed(command, stub(flagOn(FEAT)));
    }
    // A short sha in the flag still names the tip.
    allowed('git merge feature', stub(flagOn(FEAT.slice(0, 7))));
  });

  it('refuses a merge when the flag left on main names another commit', () => {
    // Before 3.3.0 a flag equal to HEAD (main) let any branch in.
    blocked('git merge feature', stub(flagOn(MAIN)), '3', /does not cover feature/);
    blocked('git merge feature', stub({ hasRemote: false }), '3', /does not cover feature.*git push \. HEAD:main/);
    expect(classify('git merge feature', stub({ hasRemote: true })).reason).not.toMatch(/git push \. HEAD:main/);
    // D9 (3.4.3): a push-only remote (no <remote>/main) still gets the remote-less hint.
    const tracked = (value) => ({ trunkTracked: (trunk) => (trunk === 'main' ? value : true) });
    blocked('git merge feature', stub({ hasRemote: true, ...tracked(false) }), '3', /does not cover feature.*git push \. HEAD:main/);
    expect(classify('git merge feature', stub({ hasRemote: true, ...tracked(true) })).reason).not.toMatch(/git push \. HEAD:main/);
    expect(classify('git merge feature', stub({ hasRemote: true, ...tracked(null) })).reason).not.toMatch(/git push \. HEAD:main/);
    // E6: the write path (a trunk rewrite such as `git branch -f main <ref>`) follows the same rule.
    blocked('git branch -f main feature', stub({ branch: 'feat/x', head: FEAT, hasRemote: true, ...tracked(false) }), '3', /does not cover feature.*git push \. HEAD:main/);
    expect(classify('git branch -f main feature', stub({ branch: 'feat/x', head: FEAT, hasRemote: true, ...tracked(true) })).reason).not.toMatch(/git push \. HEAD:main/);
  });

  it('D9: which remote exists never changes a verdict, only the hint in the reason', () => {
    const commands = ['git merge feature', 'git merge --no-ff feature', 'git rebase feature', 'git branch -f main feature', 'git push origin HEAD:main', 'gh pr merge 1', 'git merge old', 'git pull'];
    const flags = [{}, flagOn(FEAT), flagOn(OLD), flagOn(MAIN)];
    for (const command of commands) {
      for (const flag of flags) {
        const verdicts = [
          { hasRemote: false }, { hasRemote: true },
          { hasRemote: true, trunkTracked: () => false }, { hasRemote: true, trunkTracked: () => true }, { hasRemote: true, trunkTracked: () => null },
        ].map((over) => classify(command, stub({ ...flag, ...over })));
        const shape = verdicts.map((v) => [v.decision, v.rule]);
        for (const s of shape) expect([command, s]).toEqual([command, shape[0]]);
      }
    }
  });

  it('reads a lone - as the previous branch, not as an option', () => {
    blocked('git merge -', stub({ ...flagOn(MAIN), commits: { '@{-1}': FEAT } }), '3', /does not cover @\{-1\}/);
    blocked('git rebase -', stub({ ...flagOn(MAIN), commits: { '@{-1}': FEAT } }), '3', /does not cover @\{-1\}/);
  });

  it('refuses when main has commits the branch lacks, and a merge of two sources', () => {
    const diverged = stub({ ...flagOn(FEAT), order: [[ORIGIN, MAIN], [ORIGIN, FEAT]] });
    blocked('git merge feature', diverged, '3', /main has commits that feature does not have/);
    blocked('git merge feature old', stub(flagOn(FEAT)), '2', /one branch at a time/);
    blocked('git rebase --onto feature old', stub(flagOn(FEAT)), '2', /one branch at a time/);
  });

  it('allows a no-op merge, a sync with origin and a harness-only fast-forward without a flag', () => {
    allowed('git merge old', stub());
    allowed('git merge --no-edit origin/main', stub());
    allowed('git merge feature', stub({ gained: ['CLAUDE.md', 'skills/project/branch-workflow/SKILL.md'] }));
    blocked('git merge feature', stub({ gained: ['.claude/scripts/x.sh'] }), '3');
  });

  it('refuses a pull of another branch on main, and keeps the sync forms', () => {
    blocked('git pull origin feature', stub(flagOn(MAIN)), '2', /git fetch/);
    allowed('git pull origin main', stub());
    allowed('git pull', stub());
    // A merge off the trunk is still not gated.
    allowed('git merge feature', stub({ branch: 'feat/x' }));
  });
});

describe('H-13 / H-19(c): rewriting the trunk ref is judged with the flag', () => {
  const feature = (over = {}) => stub({ branch: 'feat/x', head: FEAT, ...over });

  it('judges branch -f and fetch . x:main by the commit main receives', () => {
    for (const command of ['git branch -f main feature', 'git fetch . feature:main', 'git fetch . HEAD:refs/heads/main']) {
      blocked(command, feature(), '3', /does not cover/);
      allowed(command, feature(flagOn(FEAT)));
    }
    // The flag names main, not the commit main would move to.
    blocked('git branch -f main feature', feature(flagOn(MAIN)), '3');
  });

  it('allows a sync with origin, a rewind and every non-trunk or read-only branch command', () => {
    allowed('git branch -f main origin/main', feature());
    allowed('git branch -f main old', feature());
    for (const command of ['git branch -f tmp feature', 'git branch --merged main', 'git branch -a | grep main', 'git fetch origin main', 'git fetch origin main:main']) {
      allowed(command, feature());
    }
  });

  it('never allows deleting main or force-fetching into it, and refuses other remote sources', () => {
    blocked('git fetch origin +feature:main', feature(flagOn(FEAT)), '2', /never allowed/);
    blocked('git fetch origin feature:main', feature(flagOn(FEAT)), '2', /another remote branch/);
    blocked('git branch -f main feature && git push origin main', feature(flagOn(FEAT)), '2', /git branch/);
  });
});

describe('H-19(a), (d) and the pull-request hint', () => {
  const feature = (over = {}) => stub({ branch: 'feat/x', head: FEAT, isAncestor: false, originRepo: 'me/app', ...over });

  it('refuses gh -R naming another repository, and judges this one as before', () => {
    blocked('gh pr merge 1 -R other/app', feature(flagOn(FEAT)), '2', /another repository \(other\/app\).*own directory/);
    blocked('gh pr merge 1 --repo=other/app', feature(flagOn(FEAT)), '2');
    blocked('gh pr merge 1 -R me/app', feature({ originRepo: null, ...flagOn(FEAT) }), '2', /origin \(none\)/);
    allowed('gh pr merge 1 -R me/app', feature(flagOn(FEAT)));
    allowed('gh pr merge 1 -R github.com/Me/App', feature(flagOn(FEAT)));
    allowed('gh pr view 1 -R other/app', feature());
  });

  it('treats a refspec-less push whose @{push} is main as a push to main', () => {
    const verdict = blocked('git push', feature({ pushTarget: 'origin/main' }), '3', /@\{push\}/);
    expect(verdict.reason).toMatch(/gh pr create/);
    allowed('git push', feature({ pushTarget: 'origin/main', ...flagOn(FEAT) }));
    allowed('git push', feature({ pushTarget: 'origin/feat/x' }));
    allowed('git push', feature({ pushTarget: null }));
    // An explicit HEAD lands on the branch's own name, not on @{push}.
    allowed('git push origin HEAD', feature({ pushTarget: 'origin/main' }));
    blocked('git add -A && git commit -m x && git push', feature({ pushTarget: 'origin/main', ...flagOn(FEAT) }), '2', /git commit/);
  });

  it('3.4.3: without a remote-tracking trunk (a push-only remote) the hint names the local integration, not a pull request', () => {
    const pushOnly = { hasRemote: true, trunkTracked: () => false };
    for (const [command, over] of [['git push origin HEAD:main', {}], ['git push', { pushTarget: 'origin/main' }]]) {
      const verdict = blocked(command, feature({ ...pushOnly, ...over }), '3');
      expect(verdict.reason).not.toContain('git push -u origin');
      expect(verdict.reason).not.toContain('gh pr create');
      expect(verdict.reason).toContain('there is no remote-tracking main here (a push-only remote at most), so integrate locally: re-run the quality-check skill in this worktree, then run `git push . HEAD:main`');
    }
    expect(blocked('git push origin HEAD:master', feature(pushOnly), '3').reason).toContain('`git push . HEAD:master`');
    // L4: the force-push and the push-from-another-branch refusals do not send a push-only project to a pull request either.
    for (const command of ['git push --force origin HEAD:main', 'git push origin other:main', 'git push origin --delete main']) {
      const local = classify(command, feature(pushOnly));
      const tracked = classify(command, feature({ hasRemote: true, trunkTracked: () => true }));
      expect([command, local.decision, local.rule]).toEqual([command, tracked.decision, tracked.rule]); // same verdict
      expect([command, /git push -u origin|pull request/.test(local.reason)]).toEqual([command, false]);
      expect([command, local.reason.includes('git push . HEAD:main')]).toEqual([command, true]);
      expect([command, /git push -u origin|pull request/.test(tracked.reason)]).toEqual([command, true]);
    }
    // L5: a repository whose trunk is master (origin/master tracked) has a pull request route, whatever the push names.
    expect(classify('git push origin HEAD:main', feature({ hasRemote: true, trunkTracked: (t) => t === 'master' })).reason).toContain('git push -u origin HEAD');
    // With origin/main, as before.
    expect(blocked('git push origin HEAD:main', feature({ hasRemote: true, trunkTracked: () => true }), '3').reason).toContain('git push -u origin HEAD');
    // The verdict itself never depends on it.
    for (const flagged of [{}, flagOn(FEAT)]) {
      const shape = (over) => { const v = classify('git push origin HEAD:main', feature({ ...flagged, ...over })); return [v.decision, v.rule]; };
      expect(shape(pushOnly)).toEqual(shape({ hasRemote: true, trunkTracked: () => true }));
    }
  });

  it('names the pull-request route when a trunk push from a branch lacks the flag', () => {
    blocked('git push origin HEAD:main', feature(), '3', /push the feature branch .*gh pr create/);
    expect(classify('gh pr merge 1', feature()).reason).not.toMatch(/gh pr create/); // The PR already exists.
    expect(classify('git push origin main', stub()).reason).not.toMatch(/gh pr create/);
  });

  // #199-6: the hint only; which merges pass is unchanged.
  const PR_MERGE_HINT = " Make the flag in the worktree of the pull request's branch: run the quality-check skill there and run gh pr merge from it. Do not make the flag on a main checkout.";
  it('tells a refused gh pr merge to make the flag in the PR branch worktree, not on main (#199-6)', () => {
    expect(blocked('gh pr merge 1', feature(), '3').reason).toBe(`Quality check not passed. Run the quality-check skill before merging into main.${PR_MERGE_HINT}`);
    expect(blocked('gh pr merge 1', stub(), '3').reason.endsWith(PR_MERGE_HINT)).toBe(true);
    expect(blocked('gh pr merge 1', feature({ ...flagOn(OLD), isAncestor: false }), '3').reason).toBe(`Code changed after the last quality check. Re-run the quality-check skill before merging into main.${PR_MERGE_HINT}`);
    // Unchanged verdicts: a flag on HEAD still passes, and only gh pr merge gets the hint.
    allowed('gh pr merge 1', feature(flagOn(FEAT)));
    allowed('gh pr merge 1', stub(flagOn(MAIN)));
    expect(blocked('git push origin HEAD:main', feature(), '3').reason).not.toContain(PR_MERGE_HINT);
    expect(blocked('gh pr merge 1 -R other/app', feature(flagOn(FEAT)), '2').reason).not.toContain(PR_MERGE_HINT);
  });
});

describe('H-47 / H-48 / H-21: the harness exemption is documents only', () => {
  const pushWith = (files) => classify('git push origin HEAD:main', stub({ branch: 'feat/x', head: FEAT, diffSinceBase: { files, overrideChanged: false } }));

  it('exempts harness documents and refuses scripts, Design Gate skills and gate skills', () => {
    for (const files of [['skills/project/branch-workflow/SKILL.md'], ['.claude/skills/project/branch-workflow/SKILL.md'], ['documents/development/coding-rules/x.md', '.cursor/notes.mdc', 'CLAUDE.md', '.cursorrules']]) {
      expect(pushWith(files), files.join()).toEqual({ decision: 'allow' });
    }
    for (const files of [['.claude/scripts/x.sh'], ['skills/project/helm-sync/run.cjs']]) {
      expect(pushWith(files).reason, files.join()).toMatch(/Quality check not passed/);
    }
    for (const files of [['skills/superpowers/brainstorming/SKILL.md'], ['.claude/skills/superpowers/writing-plans/SKILL.md'], ['.claude/skills/project/quality-check/SKILL.md'], ['.claude/skills']]) {
      expect(pushWith(files).reason, files.join()).toMatch(/Gate control-plane changed/);
    }
  });
});

describe('quality-gate sources (integration)', () => {
  const hookScript = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-src-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
    '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const run = (dir, payload) => spawnSync('node', [hookScript], { cwd: dir, input: JSON.stringify({ cwd: dir, ...payload }), encoding: 'utf8' });
  const verdict = (dir, command) => {
    const out = run(dir, { tool_name: 'Bash', tool_input: { command } }).stdout;
    return out === '' ? 'allow' : JSON.parse(out).reason;
  };
  const commit = (g, dir, file, msg) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${msg}\n`);
    g('add', '-f', file);
    g('commit', '-q', '-m', msg);
  };
  const flag = (dir, sha) => fs.writeFileSync(path.join(dir, '.quality-check-passed'), JSON.stringify({ commit: sha }));
  // A repository without a remote: main with one commit, feature one code
  // commit ahead.
  const remoteless = () => {
    const g = gitIn(tmp);
    g('init', '-q', '-b', 'main');
    commit(g, tmp, 'app.js', 'init');
    g('checkout', '-q', '-b', 'feature');
    commit(g, tmp, 'code.js', 'code');
    return g;
  };

  it('H-11 [int] merges the checked branch on main without a remote, and not with a flag left on main', () => {
    const g = remoteless();
    flag(tmp, g('rev-parse', 'HEAD'));
    g('checkout', '-q', 'main');
    expect(verdict(tmp, 'git merge --no-ff feature')).toBe('allow');
    flag(tmp, g('rev-parse', 'HEAD'));
    expect(verdict(tmp, 'git merge --no-ff feature')).toMatch(/does not cover feature/);
  });

  it('H-12 [int] integrates from a separate worktree with main detached', () => {
    const g = remoteless();
    g('checkout', '-q', 'main');
    const wt = path.join(tmp, 'wt');
    g('worktree', 'add', '-q', wt, 'feature');
    const w = gitIn(wt);
    flag(wt, w('rev-parse', 'HEAD'));
    expect(verdict(tmp, 'git switch --detach')).toBe('allow');
    g('switch', '-q', '--detach');
    expect(verdict(wt, 'git push . HEAD:main')).toBe('allow');
    w('push', '-q', '.', 'HEAD:main');
    expect(g('rev-parse', 'main')).toBe(w('rev-parse', 'HEAD'));
    expect(verdict(tmp, 'git switch main')).toBe('allow');
  });

  // #199-3: without a usable `git push`, the merge runs where the flag is.
  it('H-12 [int] integrates by merging in the feature worktree with main detached, when git push cannot be used', () => {
    const g = remoteless();
    g('checkout', '-q', 'main');
    const wt = path.join(tmp, 'wt');
    g('worktree', 'add', '-q', wt, 'feature');
    const w = gitIn(wt);
    const tip = w('rev-parse', 'HEAD');
    flag(wt, tip);
    // In the main checkout there is no flag, so the merge is refused there, and
    // the reason names both remote-less routes (#199 L1).
    expect(verdict(tmp, 'git merge --no-ff feature')).toBe('The quality-check flag here does not cover feature: the flag must name the commit that main receives. Run the quality-check skill on feature in this checkout, then integrate it. From a separate worktree of the branch, run `git push . HEAD:main` there instead (if git push cannot be used, merge in the worktree that has the flag; see the branch-workflow skill).');
    g('switch', '-q', '--detach');
    expect(verdict(wt, 'git switch main')).toBe('allow');
    w('switch', '-q', 'main');
    expect(verdict(wt, 'git merge --no-ff feature')).toBe('allow');
    w('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    w('switch', '-q', 'feature');
    expect(verdict(tmp, 'git switch main')).toBe('allow');
    g('switch', '-q', 'main');
    expect(g('rev-parse', 'main^2')).toBe(tip);
  });

  // 3.4.3 (E1): the documented flow - integrate-check (read-only), then the gated git commands.
  it('H-12 [int] 3.4.3: integrate-check passes with unrelated untracked files, and the gated integration goes through', () => {
    const { integrateCheck } = require('./integrate-check');
    const g = remoteless();
    g('checkout', '-q', 'main');
    const wt = path.join(tmp, 'wt');
    g('worktree', 'add', '-q', wt, 'feature');
    const w = gitIn(wt);
    flag(wt, w('rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(tmp, 'customer-report.xlsx'), 'the user\'s own material\n');
    expect(integrateCheck({ dir: wt, main: tmp }).ok).toBe(true);
    expect(verdict(tmp, 'git switch --detach')).toBe('allow');
    g('switch', '-q', '--detach');
    expect(verdict(wt, 'git push . HEAD:main')).toBe('allow');
    w('push', '-q', '.', 'HEAD:main');
    expect(verdict(tmp, 'git switch main')).toBe('allow');
    g('switch', '-q', 'main');
    expect(g('rev-parse', 'HEAD')).toBe(w('rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(tmp, 'customer-report.xlsx'), 'utf8')).toBe('the user\'s own material\n');
  });

  it('D9 [int] a push-only remote without <remote>/main gets the remote-less hint; origin/main does not', () => {
    const g = remoteless();
    g('checkout', '-q', 'main');
    g('remote', 'add', 'origin', 'https://example.invalid/public-main.git'); // push-only: never fetched
    const hint = 'From a separate worktree of the branch, run `git push . HEAD:main` there instead';
    expect(verdict(tmp, 'git merge --no-ff feature')).toContain(hint);
    // origin/feature/main is not origin's main (exact refs/remotes/<remote>/<trunk>).
    g('update-ref', 'refs/remotes/origin/feature/main', 'main');
    expect(verdict(tmp, 'git merge --no-ff feature')).toContain(hint);
    g('update-ref', 'refs/remotes/origin/main', 'main');
    const tracked = verdict(tmp, 'git merge --no-ff feature');
    expect(tracked).not.toContain(hint);
    expect(tracked).toMatch(/does not cover feature/); // Still refused: only the hint changed.
  });

  it('H-13 [int] exempts a harness-only branch against the local main without a remote, and refuses branch -f main', () => {
    const g = remoteless();
    g('reset', '-q', '--hard', 'main');
    commit(g, tmp, 'skills/project/branch-workflow/SKILL.md', 'docs');
    expect(verdict(tmp, 'git push . HEAD:main')).toBe('allow');
    // With origin/main present it is the base, even when the local main is newer.
    g('update-ref', 'refs/remotes/origin/main', 'main');
    g('checkout', '-q', 'main');
    commit(g, tmp, 'more.js', 'more');
    g('checkout', '-q', 'feature');
    g('reset', '-q', '--hard', 'main');
    commit(g, tmp, 'skills/project/branch-workflow/SKILL.md', 'docs2');
    expect(verdict(tmp, 'git push . HEAD:main')).toMatch(/Quality check not passed/);
    // A code commit cannot reach main through branch -f.
    expect(verdict(tmp, 'git branch -f main more-missing')).toMatch(/Cannot verify/);
    g('checkout', '-q', '-b', 'code');
    commit(g, tmp, 'code2.js', 'code2');
    g('checkout', '-q', 'feature');
    expect(verdict(tmp, 'git branch -f main code')).toMatch(/does not cover code/);
  });

  it('H-19(d) [int] reads @{push} for a refspec-less push', () => {
    const g = remoteless();
    const bare = path.join(os.tmpdir(), `qgate-bare-${process.pid}-${Date.now()}`);
    try {
      execFileSync('git', ['init', '-q', '--bare', bare]);
      g('remote', 'add', 'origin', bare);
      g('push', '-q', 'origin', 'main');
      g('branch', '-q', '--set-upstream-to=origin/main');
      g('config', 'push.default', 'upstream');
      expect(verdict(tmp, 'git push')).toMatch(/@\{push\}.*gh pr create/);
      g('config', 'push.default', 'simple');
      expect(verdict(tmp, 'git push')).toBe('allow');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('H-52(5) [int] refuses a shell call with no readable command, and fails open elsewhere', () => {
    const g = remoteless();
    g('checkout', '-q', 'main');
    for (const payload of [{ tool_name: 'Bash', tool_input: {} }, { tool_name: 'PowerShell', tool_input: { command: 1 } }, { tool_name: 'Bash' }]) {
      const out = run(tmp, payload);
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, JSON.stringify(payload)).toBe('deny');
      expect(JSON.parse(out.stdout).reason).toMatch(/no readable command/);
    }
    for (const payload of [{ tool_name: 'Read', tool_input: {} }, { tool_input: {} }]) {
      const out = run(tmp, payload);
      expect(out.stdout, JSON.stringify(payload)).toBe('');
      expect(out.stderr).toMatch(/not gating/);
    }
  });
});
