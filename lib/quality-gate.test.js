const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { PACKAGE_ROOT } = require('./utils');
const { classify, tokenizeLines } = require('../templates/hooks/quality-gate.cjs');

// Test-design memo: docs/superpowers/plans/
//   2026-09-03-harness-philosophy-alignment-test-design.md
//
// §4 oracle rows -> test names (unit unless marked [int]):
//   push origin main (feature, no flag)      -> S1 gates a push whose destination is exactly main
//   push feat/x, feature/main-nav            -> S2 leaves feature pushes alone without touching git
//   push origin main:feature-x               -> S3 ignores a refspec whose destination is a feature branch
//   push origin feat/x:main                  -> S4 blocks <x>:main refspecs from another branch
//   push origin HEAD:main / feat/x:main      -> S5 accepts HEAD:main and the current branch as the source
//   +main/--force/-f/--force-with-lease/...  -> S6 never exempts force, delete, --all or --mirror pushes
//   refs/heads/main / MAIN / master          -> S7 compares destinations after prefix removal, case-insensitively
//   same-line commit/checkout/fetch/reset    -> S8 blocks a mover on the same line as a gated operation
//   -C / --git-dir / -c / GIT_DIR= / cd / pushd -> S9 blocks relocation and per-call git configuration
//   cd sub && ls / cd sub && git push feat/x -> S10 does not gate a cd line without a gated candidate
//   $BR / backticks / braces / %BR% / $'git' -> S11 blocks shell expansion in a gated line
//   gh pr merge --subject "fix $x"           -> S12 does not inspect gh free-text option values
//   feature git push --all / --mirror origin -> S13 blocks --all and --mirror regardless of branch
//   feature cd sub && git push               -> S14 blocks a relocated refspec-less push with the relocation reason
//   main git pull --rebase (flag)            -> S15 treats --rebase as a flag, not a same-line rebase
//   main git pull --rebase (no flag)         -> S16 asks for the flag, not for a split, on git pull --rebase
//   git > /dev/null merge feat               -> S17 blocks a gate word hidden behind a redirection
//   git push origin main && gh pr merge 3    -> S18 blocks two gated operations on one line
//   main git pull / pull origin main / merge origin/main -> S19 allows the three sync forms without a flag
//   sync-form near misses / pull && push     -> S20 gates every near miss of the sync forms
//   feature merge/rebase/pull                -> S21 leaves merge, pull and rebase alone off main
//   main git merge --abort / --continue      -> S22 does not treat merge control flags as a merge
//   git stash push / merge-base / pushd      -> S23 matches subcommand words whole
//   gh api .../pulls/12/merge                -> S24 gates the gh api merge endpoint
//   gh pr merge 12 (flag == HEAD)            -> S25 [int] passes gh pr merge with a flag on HEAD
//   flag ancestor + harness-only diff         -> S26 [int] passes an ancestor flag with a harness-only diff
//   ... control-plane diff                   -> S27 [int] blocks a post-flag control-plane change (edit and rename)
//   ... CLAUDE.md mutation_budget_minutes    -> S28 blocks a harness diff that moves an override string
//   flag branch mismatch, commit == HEAD     -> S29 authorizes on commit alone and ignores the flag branch
//   origin/main...HEAD harness only, no flag -> S30 exempts a harness-only diff against origin/main
//   malformed payload / non-git directory    -> S31 [int] fails open on an unreadable payload and outside a repo
//   candidate + git failure                  -> S32 blocks when the repository state cannot be resolved (+ [int])
//
// §5 falsification items -> test names:
//   mixed case Git Push / GIT PUSH           -> F1 detects git and gh through case and path spellings
//   quoted "main" / 'main'                   -> F2 compares refspecs after quote removal
//   newline-separated lines                  -> F3 classifies each line of a multi-line command
//   git push --repo=origin main              -> F4 reads every positional as a refspec after --repo
//   git push origin main:main                -> F5 treats main:main as <x>:main
//   git push origin :main                    -> F6 treats :main as a delete refspec
//   .claude/Hooks/quality-gate.cjs           -> F7 matches control-plane paths case-insensitively
//   detached HEAD (branch null)              -> F8 blocks a candidate when the branch cannot be resolved
//   integration wall time                    -> the suite keeps real git to the eight integration tests
//
// Invariants: I1 (S6/S8), I2 (S2/S10/S23), I3 (S32), I4 (S31 + integration
// output shape), I5 (purity), I6 (S19/S20), I7 (S29).

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

describe('quality-gate classifier', () => {
  // ctx stub: every field is a lazy getter backed by a spy, so tests can
  // assert that a command with no rule-1 candidate never resolves anything.
  const makeCtx = (over = {}) => {
    const values = {
      branch: 'feat/x',
      head: HEAD_SHA,
      flag: null,
      isAncestor: false,
      diffSinceFlag: null,
      diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
      ...over,
    };
    const spies = {};
    const ctx = {};
    for (const key of Object.keys(values)) {
      spies[key] = vi.fn(() => values[key]);
      Object.defineProperty(ctx, key, { get: spies[key], enumerable: true });
    }
    Object.defineProperty(ctx, 'spies', { value: spies, enumerable: false });
    return ctx;
  };

  const onMain = (over = {}) => makeCtx({ branch: 'main', ...over });
  const withFlag = (over = {}) => ({ flag: { commit: HEAD_SHA }, head: HEAD_SHA, ...over });

  const expectAllow = (command, ctx = makeCtx()) => {
    const verdict = classify(command, ctx);
    expect(verdict, `${command} must be allowed (got ${verdict.reason})`).toMatchObject({
      decision: 'allow',
    });
    return verdict;
  };
  const expectBlock = (command, ctx = makeCtx()) => {
    const verdict = classify(command, ctx);
    expect(verdict.decision, `${command} must be blocked`).toBe('block');
    return verdict;
  };
  const expectUntouched = (ctx) => {
    for (const [name, spy] of Object.entries(ctx.spies)) {
      expect(spy, `ctx.${name} must not be resolved`).not.toHaveBeenCalled();
    }
  };

  // ---- rule 1: what is a candidate ------------------------------------

  it('S1 gates a push whose destination is exactly main', () => {
    expect(expectBlock('git push origin main').reason).toMatch(/quality-check skill/i);
  });

  it('S2 leaves feature pushes alone without touching git', () => {
    for (const command of ['git push origin feat/x', 'git push -u origin feature/main-nav']) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('S3 ignores a refspec whose destination is a feature branch', () => {
    const ctx = makeCtx();
    expectAllow('git push origin main:feature-x', ctx);
    expectUntouched(ctx);
  });

  it('S7 compares destinations after prefix removal, case-insensitively', () => {
    for (const ref of ['refs/heads/main', 'heads/main', 'MAIN', 'master', 'refs/heads/MASTER']) {
      expectBlock(`git push origin ${ref}`);
    }
    expectAllow('git push origin mainline');
    expectAllow('git push origin feature/main-nav');
  });

  it('S23 matches subcommand words whole', () => {
    for (const command of ['git stash push', 'git merge-base HEAD origin/main', 'git pushd', 'git pull-request']) {
      const ctx = onMain();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('S24 gates the gh api merge endpoint', () => {
    expect(expectBlock('gh api repos/o/r/pulls/12/merge -X PUT').rule).toBe('3');
    expectAllow('gh api repos/o/r/pulls/12/comments');
  });

  it('F1 detects git and gh through case and path spellings', () => {
    expectBlock('Git Push Origin Main');
    expectBlock('GIT PUSH', onMain());
    expectBlock('/usr/bin/git push origin main');
    expectBlock('"C:\\Program Files\\Git\\bin\\git.exe" push origin main');
  });

  it('F2 compares refspecs after quote removal', () => {
    expectBlock('git push origin "main"');
    expectBlock("git push origin 'main'");
  });

  it('F3 classifies each line of a multi-line command', () => {
    expectBlock('echo x\ngit push origin main');
    const ctx = makeCtx();
    expectAllow('echo x\ngit push origin feat/x', ctx);
    expectUntouched(ctx);
  });

  it('F4 reads every positional as a refspec after --repo', () => {
    expectBlock('git push --repo=origin main');
    expectBlock('git push --repo origin main');
  });

  // ---- rule 2: no exemption -------------------------------------------

  it('S6 never exempts force, delete, --all or --mirror pushes', () => {
    const ctx = onMain(withFlag());
    for (const command of [
      'git push origin +main',
      'git push --force origin main',
      'git push -f origin main',
      'git push --force-with-lease origin main',
      'git push --force-with-lease=main origin main',
      'git push origin --delete main',
      'git push -d origin main',
      'git push --mirror origin',
      'git push --all origin',
    ]) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/Force, delete, --all and --mirror/);
    }
  });

  it('S13 blocks --all and --mirror regardless of branch', () => {
    // No destination word to compare, so the branch cannot narrow them.
    expect(expectBlock('git push --all origin', makeCtx(withFlag())).rule).toBe('2');
    expect(expectBlock('git push --mirror origin', makeCtx(withFlag())).rule).toBe('2');
  });

  it('F6 treats :main as a delete refspec', () => {
    expect(expectBlock('git push origin :main', onMain(withFlag())).reason)
      .toMatch(/Force, delete/);
  });

  it('S8 blocks a mover on the same line as a gated operation', () => {
    const ctx = onMain(withFlag());
    const cases = [
      ['git commit -m x && git push origin main', 'commit'],
      ['git checkout main && git merge feat', 'checkout'],
      ['git switch main; git merge feat', 'switch'],
      ['git fetch && git merge', 'fetch'],
      ['git reset --hard && git push origin main', 'reset'],
      ['git update-ref refs/heads/main HEAD && git push origin main', 'update-ref'],
      ['git cherry-pick abc && git push origin main', 'cherry-pick'],
      ['git branch -f main abc && git push origin main', 'branch'],
      ['git stash pop && git push origin main', 'stash pop'],
    ];
    for (const [command, mover] of cases) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(new RegExp(`git ${mover}`));
    }
  });

  it('S15 treats --rebase as a flag, not a same-line rebase', () => {
    // The gated call never matches itself: `git pull --rebase` and
    // `git rebase origin/main` are one operation, not two.
    expectAllow('git pull --rebase', onMain(withFlag()));
    expectAllow('git rebase origin/main', onMain(withFlag()));
  });

  it('S16 asks for the flag, not for a split, on git pull --rebase', () => {
    const verdict = expectBlock('git pull --rebase', onMain());
    expect(verdict.rule).toBe('3');
    expect(verdict.reason).toMatch(/Quality check not passed/);
  });

  it('S9 blocks relocation and per-call git configuration', () => {
    const ctx = onMain(withFlag());
    for (const command of [
      'git -C ../other push origin main',
      'git --git-dir=x push',
      'git --work-tree=/w merge feat',
      'git -c user.name=x push origin main',
      'git --config-env=a=B push origin main',
      'GIT_DIR=x git push origin main',
      'cd ../w && git merge feat',
      'pushd w; git push origin main',
    ]) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/separate command/);
    }
  });

  it('S10 does not gate a cd line without a gated candidate', () => {
    for (const command of ['cd sub && ls', 'cd sub && git push origin feat/x']) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('S14 blocks a relocated refspec-less push with the relocation reason', () => {
    // Deliberate over-detection: the hook cannot tell what `git push` with no
    // refspec would push from another directory.
    const verdict = expectBlock('cd sub && git push', makeCtx(withFlag()));
    expect(verdict.reason).toMatch(/Run git from the target repository directory as a separate command/);
  });

  it('S11 blocks shell expansion in a gated line', () => {
    const ctx = onMain(withFlag());
    for (const command of [
      'git push origin $BR',
      '`git push origin main`',
      'git push origin ma{i,in}n',
      'git push origin %BR%',
      "$'git' push origin main",
      'git push $(cat remote) main',
    ]) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/shell expansion/);
    }
  });

  it('S12 does not inspect gh free-text option values', () => {
    expectAllow('gh pr merge 12 --subject "fix $x"', makeCtx(withFlag()));
    expectAllow('gh pr merge 12 --body "see `note`" --body-file $F', makeCtx(withFlag()));
    const verdict = expectBlock('gh pr merge 12 --subject "fix $x"');
    expect(verdict.reason).toMatch(/Quality check not passed/);
    expect(verdict.reason).not.toMatch(/expansion/);
  });

  it('S17 blocks a gate word hidden behind a redirection', () => {
    const verdict = expectBlock('git > /dev/null merge feat', onMain(withFlag()));
    expect(verdict.rule).toBe('2');
    expect(verdict.reason).toMatch(/redirection/);
    expectAllow('git push origin feat/x > push.log');
  });

  it('S18 blocks two gated operations on one line', () => {
    const verdict = expectBlock('git push origin main && gh pr merge 3', onMain(withFlag()));
    expect(verdict.rule).toBe('2');
    expect(verdict.reason).toMatch(/one gated operation/);
  });

  it('S4 blocks <x>:main refspecs from another branch', () => {
    const verdict = expectBlock('git push origin feat/x:main', onMain(withFlag()));
    expect(verdict.rule).toBe('2');
    expect(verdict.reason).toMatch(/Push from the branch itself/);
  });

  it('S5 accepts HEAD:main and the current branch as the source', () => {
    // Design §3.5 rule 2, last bullet: <x> is exempt when it is HEAD or the
    // current branch. (The memo row spells the second case as a block; the
    // design is normative — otherwise no branch could ever be pushed to main.)
    expectAllow('git push origin HEAD:main', makeCtx(withFlag()));
    expectAllow('git push origin feat/x:main', makeCtx(withFlag()));
    expect(expectBlock('git push origin feat/y:main', makeCtx(withFlag())).rule).toBe('2');
  });

  it('F5 treats main:main as <x>:main', () => {
    expect(expectBlock('git push origin main:main', makeCtx(withFlag())).rule).toBe('2');
    expectAllow('git push origin main:main', onMain(withFlag()));
  });

  it('I1 keeps rule 2 ahead of the flag and of both exemptions', () => {
    const ctx = onMain({
      ...withFlag(),
      diffSinceBase: { files: ['.claude/settings.json'], overrideChanged: false },
    });
    for (const command of ['git push --force origin main', 'git commit -m x && git push origin main']) {
      expect(classify(command, ctx).rule, command).toBe('2');
    }
  });

  // ---- rule 1 + ctx: main-only candidates ------------------------------

  it('S21 leaves merge, pull and rebase alone off main', () => {
    for (const command of ['git merge feat/y', 'git rebase main', 'git pull']) {
      expectAllow(command, makeCtx());
    }
  });

  it('S22 does not treat merge control flags as a merge', () => {
    for (const command of ['git merge --abort', 'git merge --continue', 'git rebase --skip', 'git rebase --quit']) {
      const ctx = onMain();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('S19 allows the three sync forms without a flag', () => {
    for (const command of ['git pull', 'git pull origin main', 'git merge origin/main']) {
      expectAllow(command, onMain());
    }
  });

  it('S20 gates every near miss of the sync forms', () => {
    for (const command of [
      'git pull origin main --rebase',
      'git pull upstream main',
      'git merge origin/main --no-ff',
      'git merge origin/master',
      'git -C . pull',
    ]) {
      expect(classify(command, onMain()).decision, command).toBe('block');
    }
    // Two gated operations, so rule 2 answers before the sync form can.
    const chained = expectBlock('git pull && git push origin main', onMain(withFlag()));
    expect(chained.rule).toBe('2');
  });

  // ---- rules 3 and 4 ---------------------------------------------------

  it('S25 passes gh pr merge with a flag on HEAD', () => {
    expectAllow('gh pr merge 12', makeCtx(withFlag()));
  });

  it('S29 authorizes on commit alone and ignores the flag branch', () => {
    // I7: the flag's `branch` field is diagnostic; only `commit` authorizes.
    const ctx = makeCtx({ branch: 'feat/other', flag: { commit: HEAD_SHA }, head: HEAD_SHA });
    expectAllow('git push origin main', ctx);
    // An abbreviated commit still matches its HEAD.
    expectAllow('git push origin main', makeCtx({ flag: { commit: HEAD_SHA.slice(0, 7) } }));
  });

  it('S26 passes an ancestor flag with a harness-only diff', () => {
    const ctx = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['.claude/agents/x.md', 'CLAUDE.md'], overrideChanged: false },
    });
    expectAllow('git push origin main', ctx);
  });

  it('S27 blocks a post-flag control-plane change', () => {
    const control = [
      'skills/project/quality-check/SKILL.md',
      'skills/project/test-recommendation/SKILL.md',
      'skills/project/_schemas/quality-check-report.schema.md',
      '.claude/hooks/quality-gate.cjs',
      '.claude/skills',
      '.claude/settings.local.json',
      '.codex/hooks.json',
      '.codex/config.toml',
      '.github/review-security.md',
    ];
    for (const file of control) {
      const ctx = makeCtx({
        flag: { commit: OTHER_SHA },
        isAncestor: true,
        diffSinceFlag: { files: [file], overrideChanged: false },
      });
      const verdict = classify('git push origin main', ctx);
      expect(verdict.decision, file).toBe('block');
      expect(verdict.reason, file).toMatch(/^Gate control-plane changed: /);
    }
  });

  it('F7 matches control-plane paths case-insensitively and only at directory nodes', () => {
    const blocked = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['.claude/Hooks/quality-gate.cjs'], overrideChanged: false },
    });
    expect(classify('git push origin main', blocked).reason).toMatch(/^Gate control-plane changed: /);

    // The `(\/|$)` boundary (#90-7): a sibling directory whose name merely
    // starts with `hooks` is an ordinary harness file.
    const allowed = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['.claude/hooksfoo/x.md'], overrideChanged: false },
    });
    expectAllow('git push origin main', allowed);
  });

  it('S28 blocks a harness diff that moves an override string', () => {
    const ctx = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['CLAUDE.md'], overrideChanged: true },
    });
    expect(expectBlock('git push origin main', ctx).reason).toMatch(/Code changed after the last quality check/);
  });

  it('S30 exempts a harness-only diff against origin/main', () => {
    const ctx = makeCtx({
      diffSinceBase: { files: ['.claude/agents/x.md'], overrideChanged: false },
    });
    expectAllow('git push origin main', ctx);

    // Empty, control-plane and override-string diffs are not exempt.
    expectBlock('git push origin main', makeCtx({ diffSinceBase: { files: [], overrideChanged: false } }));
    expect(
      expectBlock('git push origin main', makeCtx({
        diffSinceBase: { files: ['.claude/hooks/quality-gate.cjs'], overrideChanged: false },
      })).reason
    ).toMatch(/^Gate control-plane changed: /);
    expectBlock('git push origin main', makeCtx({
      diffSinceBase: { files: ['CLAUDE.md'], overrideChanged: true },
    }));
  });

  it('blocks a stale flag that is not an ancestor of HEAD', () => {
    const ctx = makeCtx({ flag: { commit: OTHER_SHA }, isAncestor: false });
    expect(expectBlock('git push origin main', ctx).reason).toMatch(/Code changed after the last quality check/);
  });

  // ---- rule 5 and invariants -------------------------------------------

  it('S32 blocks when the repository state cannot be resolved', () => {
    // I3: a candidate plus an unresolvable ctx is a block, never a pass.
    const cases = [
      { branch: null },
      { head: null, flag: { commit: OTHER_SHA } },
      { flag: { commit: OTHER_SHA }, isAncestor: null },
      { flag: { commit: OTHER_SHA }, isAncestor: true, diffSinceFlag: null },
      { diffSinceBase: null },
    ];
    for (const over of cases) {
      const verdict = classify('git push origin main', makeCtx(over));
      expect(verdict.decision, JSON.stringify(over)).toBe('block');
      expect(verdict.rule, JSON.stringify(over)).toBe('5');
      expect(verdict.reason, JSON.stringify(over)).toMatch(/^Cannot verify /);
    }
  });

  it('F8 blocks a candidate when the branch cannot be resolved', () => {
    // Detached HEAD: `git branch --show-current` is empty.
    expect(expectBlock('git merge feat', makeCtx({ branch: '' })).rule).toBe('5');
    expect(expectBlock('git push origin main', makeCtx({ branch: '' })).rule).toBe('5');
    // ... but a line with no candidate still never resolves anything.
    const ctx = makeCtx({ branch: '' });
    expectAllow('git status', ctx);
    expectUntouched(ctx);
  });

  it('I5 is a pure function of (command, ctx)', () => {
    const command = 'git push origin main';
    const ctx = makeCtx(withFlag());
    const before = JSON.stringify(Object.keys(ctx));
    const first = classify(command, ctx);
    const second = classify(command, ctx);
    expect(second).toEqual(first);
    expect(JSON.stringify(Object.keys(ctx))).toBe(before);
    expect(classify(command, makeCtx(withFlag()))).toEqual(first);
  });

  it('I4 reports only allow or block with a one-sentence reason', () => {
    expect(classify('ls -la', makeCtx())).toEqual({ decision: 'allow' });
    const verdict = classify('git push origin main', makeCtx());
    expect(Object.keys(verdict).sort()).toEqual(['decision', 'reason', 'rule']);
    expect(verdict.reason.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('tokenizes lines, segments, redirections and quoting', () => {
    const lines = tokenizeLines('echo "a b" > out.txt\ngit push origin main');
    expect(lines).toHaveLength(2);
    expect(lines[0].segments[0].words).toEqual(['echo', 'a b']);
    expect(lines[0].segments[1]).toMatchObject({ words: ['out.txt'], redirected: true });
    expect(lines[1].segments[0].words).toEqual(['git', 'push', 'origin', 'main']);
  });
});

describe('quality-gate hook (integration)', () => {
  const hookScript = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');
  const FLAG = '.quality-check-passed';

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const runHookIn = (cwd, payload) => {
    const result = spawnSync('node', [hookScript], {
      cwd,
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const runHook = (command) => runHookIn(tmpDir, { tool_input: { command } }).stdout;

  // Turn tmpDir into a git repo with an origin/main tracking ref. Identity and
  // autocrlf ride on `-c` rather than `git config` calls: every process spawn
  // here is wall time, and this helper runs once per integration test.
  const initRepo = () => {
    const g = (...args) =>
      execFileSync(
        'git',
        [
          '-c', 'core.autocrlf=false',
          '-c', 'commit.gpgsign=false',
          '-c', 'user.email=test@example.com',
          '-c', 'user.name=Test',
          ...args,
        ],
        { cwd: tmpDir, encoding: 'utf8' }
      ).trim();
    g('init', '-b', 'main');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log(1);\n');
    g('add', '.');
    g('commit', '-m', 'init');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return g;
  };

  // `-f`: a developer's global gitignore must not turn a fixture add into a
  // silent skip. `add <file>` (not `.`) keeps the untracked flag file out.
  const commitFile = (g, file, content, msg) => {
    const abs = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    g('add', '-f', file);
    g('commit', '-q', '-m', msg);
  };
  const head = (g) => g('rev-parse', 'HEAD');

  const writeFlag = (commit, branch = 'main') =>
    fs.writeFileSync(path.join(tmpDir, FLAG), JSON.stringify({ branch, commit }) + '\n');

  const decision = (out) => (out === '' ? 'allow' : JSON.parse(out).decision);

  it('S25 [int] passes gh pr merge with a flag on HEAD', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head(g), 'feat/x');
    expect(runHook('gh pr merge 12')).toBe('');
  });

  it('S26 [int] passes an ancestor flag with a harness-only diff', () => {
    const g = initRepo();
    commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head(g));
    commitFile(g, 'CLAUDE.md', '# rules\n', 'harness');
    expect(runHook('git push origin main')).toBe('');
  });

  it('S27 [int] blocks a post-flag control-plane change (edit and rename)', () => {
    const g = initRepo();
    commitFile(g, '.claude/hooks/x.cjs', 'aaa\nbbb\nccc\nddd\n', 'hook');
    commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head(g));
    commitFile(g, 'skills/project/quality-check/SKILL.md', '# skill\n', 'control');
    const edited = JSON.parse(runHook('git push origin main'));
    expect(edited.decision).toBe('block');
    expect(edited.reason).toMatch(/^Gate control-plane changed: /);

    // --no-renames: moving a control-plane file out of its directory must
    // still list the source path, or the carve-out sees only the destination.
    g('mv', '.claude/hooks/x.cjs', '.claude/notes.md');
    g('commit', '-q', '-m', 'rename');
    const renamed = JSON.parse(runHook('git push origin main'));
    expect(renamed.decision).toBe('block');
    expect(renamed.reason).toMatch(/\.claude\/hooks\/x\.cjs/);
  });

  it('S1 [int] blocks a push to main without a flag and allows a feature push', () => {
    const g = initRepo();
    commitFile(g, 'code.js', 'x\n', 'code');
    const blocked = JSON.parse(runHook('git push origin main'));
    expect(blocked).toMatchObject({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    g('checkout', '-b', 'feat/x');
    expect(runHook('git push origin feat/x')).toBe('');
  });

  it('S19 [int] allows the sync forms on main and gates their near misses', () => {
    const g = initRepo();
    commitFile(g, 'code.js', 'x\n', 'code');
    expect(runHook('git pull')).toBe('');
    expect(runHook('git merge origin/main')).toBe('');
    expect(decision(runHook('git pull upstream main'))).toBe('block');
  });

  it('S31 [int] fails open on an unreadable payload and outside a repo', () => {
    const outside = runHookIn(tmpDir, { tool_input: { command: 'git push origin main' } });
    expect(outside.stdout).toBe('');
    expect(outside.stderr).toMatch(/not a git repository/);

    const malformed = runHookIn(tmpDir, 'not json');
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toMatch(/unreadable hook payload/);
    expect(runHookIn(tmpDir, {}).stdout).toBe('');
  });

  it('S32 [int] blocks when git cannot resolve the flag commit', () => {
    const g = initRepo();
    commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag('0123456789abcdef0123456789abcdef01234567'); // No such object.
    const verdict = JSON.parse(runHook('git push origin main'));
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toMatch(/^Cannot verify /);
  });

  it('resolves the repository from the payload cwd', () => {
    const g = initRepo();
    commitFile(g, 'code.js', 'x\n', 'code');
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub);
    const out = runHookIn(sub, { cwd: tmpDir, tool_input: { command: 'git push origin main' } });
    expect(JSON.parse(out.stdout).decision).toBe('block');
  });
});
