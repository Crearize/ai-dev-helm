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
//   git > /dev/null merge feat               -> S17 reads through a redirection instead of breaking the command there
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
//
// quality-check cycle 1 (qc-fixes.md) -> test names:
//   A1  redirections are stripped, not split at   -> S17 (+ the tokenizer test)
//   A2  bundled -fu / -df short options           -> S6, I1
//   A3  `git push origin HEAD` / `@`              -> S33
//   A4  newline cannot hide a HEAD mover          -> S8 (newline rows)
//   A5  a payload with no command says so         -> S31 [int]
//   A6  linear time in the number of git words    -> S35
//   A7  sync forms follow the current trunk       -> S19, S20
//   A8  64 KB classifier budget                   -> S34
//   A9  .claude/agents, .codex/commands           -> S27
//   A12 deliberate feature-branch over-detection  -> S37
//   A13 non-repo decided by exit status           -> S31 [int]
//   A14 unquoted Windows path (characterization)  -> F1
//   A15 unquoted `#` comment                      -> S36
//   A17 `git -C . pull` is rule 2                 -> S20
//   A21 git.cmd / git.bat                         -> F1
//   A22 trunk name compared case-insensitively    -> S19
//   A23 gh free-text carve-out is scoped to gh    -> S12
//
// quality-check cycle 2 (qc-fixes-2.md) -> test names:
//   H1  the payload is read whole, not truncated  -> S38 [int]
//   H2  `""#` / `''#` do not start a comment      -> S36 (+ the tokenizer test)
//   H3  a pulls/<n>/merge with a query string     -> S24
//   M1  linear parsing of thousands of pushes     -> S35
//   M2  .cursor/rules, .codex/prompts are control -> S27
//   L2  `@:main` is the current branch, like HEAD -> S5
//   L3  newline commit + refspec-less push        -> S37

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

    // H3: the endpoint word may carry a query string or a fragment - the merge
    // still happens, so the boundary is "not another path word character".
    for (const word of [
      'repos/o/r/pulls/1/merge?draft=false',
      'repos/o/r/pulls/1/merge?merge_method=squash&sha=abc',
      'repos/o/r/pulls/1/merge#frag',
      '/repos/o/r/pulls/1/merge/',
    ]) {
      expect(expectBlock(`gh api ${word} -X PUT`, makeCtx()).rule, word).toBe('3');
    }
    // Control: a longer endpoint word is a different endpoint.
    for (const word of ['repos/o/r/pulls/1/merged', 'repos/o/r/pulls/1/merge-queue']) {
      const ctx = makeCtx();
      expectAllow(`gh api ${word}`, ctx);
      expectUntouched(ctx);
    }
  });

  it('F1 detects git and gh through case and path spellings', () => {
    expectBlock('Git Push Origin Main');
    expectBlock('GIT PUSH', onMain());
    expectBlock('/usr/bin/git push origin main');
    expectBlock('"C:\\Program Files\\Git\\bin\\git.exe" push origin main');
    expectBlock('git.cmd push origin main'); // A21: Windows launcher shims.
    expectBlock('C:/tools/git.bat push origin main');

    // A14, characterization: only the QUOTED Windows spelling is recognised.
    // Unquoted, `\` is an escape character (as in any POSIX shell), so this
    // line tokenizes into words that no longer look like `git` and is allowed.
    // Reading `\` as a path separator would break every legitimate escape.
    const ctx = makeCtx();
    expectAllow('C:\\Program Files\\Git\\bin\\git.exe push origin main', ctx);
    expectUntouched(ctx);
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
      // A2: single-dash bundles carrying `f` or `d`.
      'git push -fu origin main',
      'git push -df origin main',
      'git push -uf origin main',
      'git push -dv origin main',
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
      // A4: a mover that moves HEAD is judged over the whole command, so a
      // newline cannot hide the TOCTOU window.
      ['git commit -am wip\ngit push origin main', 'commit'],
      ['git checkout main\ngit merge feat', 'checkout'],
      ['git stash pop\ngit push origin main', 'stash pop'],
      ['git push origin main\ngit reset --hard', 'reset'],
    ];
    for (const [command, mover] of cases) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(new RegExp(`git ${mover}`));
    }
    // `fetch` and `branch -f` do not move HEAD, so they stay line-scoped.
    expectAllow('git fetch\ngit merge origin/main', onMain());
    expectAllow('git branch -f tmp abc\ngit pull', onMain());
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

    // A23: the carve-out belongs to the gh call, not to the whole segment -
    // `--body` in front of a git command is not a PR description.
    const leaked = expectBlock('git push --body $BR origin main', onMain(withFlag()));
    expect(leaked.rule).toBe('2');
    expect(leaked.reason).toMatch(/shell expansion/);
  });

  it('S36 drops an unquoted comment to the end of the line', () => {
    // A15: `#` starts a comment, so the words after it are not a mover.
    expectAllow('git push origin main # then git checkout foo', onMain(withFlag()));
    expect(expectBlock('git push origin main # note', onMain()).rule).toBe('3');
    // Quoted or mid-word, `#` is an ordinary character.
    expect(expectBlock('git commit -m "fix #12" && git push origin main', onMain(withFlag())).reason)
      .toMatch(/git commit/);

    // H2: a `#` only opens a comment where no word has STARTED. An empty quote
    // starts one, so bash reads `""#` as the word `#` and keeps running the
    // line - reading it as a comment hid everything after it from the hook.
    for (const command of [
      'echo ""# ; git push origin main',
      "echo ''#; git push origin main",
      'echo x# ; git push origin main',
      'echo ""#; git merge feat',
    ]) {
      expect(expectBlock(command, onMain()).rule, command).toBe('3');
    }
    expect(expectBlock('git commit -am wip ""# ; git push origin main', onMain(withFlag())).reason)
      .toMatch(/git commit/);
  });

  it('S17 reads through a redirection instead of breaking the command there', () => {
    // A1: `>` `>>` `<` `2>` `&>` remove the operator and its target word only;
    // every other word still belongs to the same command.
    expect(expectBlock('git > /dev/null merge feat', onMain()).rule).toBe('3');
    expectAllow('git > /dev/null merge feat', onMain(withFlag()));

    expect(expectBlock('git push > /dev/null origin main', onMain()).rule).toBe('3');
    expect(expectBlock('git push origin >/dev/null :main', onMain(withFlag())).reason)
      .toMatch(/Force, delete/);
    expect(expectBlock('gh api >/dev/null repos/o/r/pulls/1/merge -X PUT', onMain()).rule).toBe('3');
    expect(expectBlock('git push origin main 2> err.log', onMain()).rule).toBe('3');
    expect(expectBlock('git push origin main &>> err.log', onMain()).rule).toBe('3');

    // A redirection target that merely spells a gate word is not a command.
    for (const command of ['echo hi > pr', 'npm test > merge', 'git push origin feat/x > push.log']) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
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

    // L2: `@` is HEAD, and HEAD is compared case-insensitively - both name the
    // current branch, so they ask for the flag (rule 3) instead of rule 2.
    for (const spec of ['@:main', 'head:main', 'Head:main', 'HEAD:main']) {
      expect(expectBlock(`git push origin ${spec}`, onMain()).rule, spec).toBe('3');
      expectAllow(`git push origin ${spec}`, onMain(withFlag()));
    }
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
    for (const command of [
      'git push --force origin main',
      'git push -fu origin main',
      'git commit -m x && git push origin main',
    ]) {
      expect(classify(command, ctx).rule, command).toBe('2');
    }
  });

  it('S33 treats a bare HEAD or @ refspec as an omitted refspec', () => {
    // A3: `git push origin HEAD` lands on origin/main from main, so it is a
    // candidate exactly where a refspec-less push is one.
    for (const command of ['git push origin HEAD', 'git push origin @', 'git push -u origin HEAD']) {
      expect(expectBlock(command, onMain()).rule, command).toBe('3');
      expectAllow(command, makeCtx());
    }
    expect(expectBlock('git push origin head', onMain()).rule).toBe('3');
  });

  // ---- rule 1 + ctx: main-only candidates ------------------------------

  it('S21 leaves merge, pull and rebase alone off main', () => {
    for (const command of ['git merge feat/y', 'git rebase main', 'git pull']) {
      expectAllow(command, makeCtx());
    }
  });

  it('S37 over-blocks these feature-branch lines by design', () => {
    // Characterization, not a wish: rule 2 items 1-5 are evaluated before the
    // branch is known, so they fire on a feature branch as well. Both of these
    // are safe to run and are still blocked; the fix is to split the line.
    const fetchRebase = expectBlock('git fetch && git rebase origin/main', makeCtx(withFlag()));
    expect(fetchRebase.rule).toBe('2');
    expect(fetchRebase.reason).toMatch(/git fetch/);

    const lease = expectBlock('git push --force-with-lease', makeCtx(withFlag()));
    expect(lease.rule).toBe('2');
    expect(lease.reason).toMatch(/Force, delete/);

    // L3: a refspec-less push is a candidate on any branch (only ctx narrows
    // it), so a commit on the line before it blocks off main as well. Splitting
    // by newline does not help - it is still one tool call.
    const committed = expectBlock('git commit -am wip\ngit push', makeCtx(withFlag()));
    expect(committed.rule).toBe('2');
    expect(committed.reason).toMatch(/git commit/);
  });

  it('S22 does not treat merge control flags as a merge', () => {
    for (const command of ['git merge --abort', 'git merge --continue', 'git rebase --skip', 'git rebase --quit']) {
      const ctx = onMain();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('S19 allows the three sync forms of the current trunk without a flag', () => {
    for (const command of ['git pull', 'git pull origin main', 'git merge origin/main']) {
      expectAllow(command, onMain());
    }
    // A7: on master the sync forms are the master ones, not the main ones.
    for (const command of ['git pull', 'git pull origin master', 'git merge origin/master']) {
      expectAllow(command, makeCtx({ branch: 'master' }));
    }
    // A22: the trunk is recognised whatever its case, and parameterizes the
    // sync forms through its lower-cased name.
    expectAllow('git pull origin main', makeCtx({ branch: 'Main' }));
    expect(expectBlock('git merge feat', makeCtx({ branch: 'MAIN' })).rule).toBe('3');
  });

  it('S20 gates every near miss of the sync forms', () => {
    for (const command of [
      'git pull origin main --rebase',
      'git pull upstream main',
      'git merge origin/main --no-ff',
      'git merge origin/master',
    ]) {
      expect(classify(command, onMain()).decision, command).toBe('block');
    }
    // A7: the other trunk's forms are ordinary gated operations.
    for (const command of ['git pull origin main', 'git merge origin/main']) {
      expect(classify(command, makeCtx({ branch: 'master' })).rule, command).toBe('3');
    }
    // A17: a global option is rule 2 (relocation), not a missed sync form.
    const relocated = expectBlock('git -C . pull', onMain());
    expect(relocated.rule).toBe('2');
    expect(relocated.reason).toMatch(/separate command/);
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
      diffSinceFlag: { files: ['.claude/memo.md', 'CLAUDE.md'], overrideChanged: false },
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
      // A9: subagent definitions and session prompts are control plane too.
      '.claude/agents/reviewer.md',
      '.codex/commands/ship.md',
      '.cursor/agents',
      // M2: `.cursor/rules/*.mdc` is auto-loaded into every session and
      // `.codex/prompts/` is read the same way `commands/` is.
      '.cursor/rules/policy.mdc',
      '.codex/prompts/review.md',
      '.claude/rules',
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

    // M2: the same set carves out the rule-4 exemption, with no flag at all.
    const onMainRules = onMain({
      diffSinceBase: { files: ['.cursor/rules/policy.mdc'], overrideChanged: false },
    });
    expect(expectBlock('git push origin main', onMainRules).reason)
      .toMatch(/^Gate control-plane changed: \.cursor\/rules\/policy\.mdc\./);
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
      diffSinceBase: { files: ['.claude/memo.md'], overrideChanged: false },
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

  it('S34 refuses to classify a command line over the byte budget', () => {
    // A8: an oversized line is answered from the gate words alone - block when
    // one is present, allow when none is.
    const gated = 'git push '.repeat(8000) + 'git push origin main';
    expect(gated.length).toBeGreaterThan(64 * 1024);
    const verdict = expectBlock(gated, onMain(withFlag()));
    expect(verdict.reason).toMatch(/too long to classify/i);

    const harmless = 'echo '.repeat(14000);
    expect(harmless.length).toBeGreaterThan(64 * 1024);
    const ctx = onMain(withFlag());
    expectAllow(harmless, ctx);
    expectUntouched(ctx);
  });

  it('S35 classifies a command with thousands of git words in linear time', () => {
    // A6: `git` words used to each copy the rest of the segment (O(W^2)); a
    // 60 KB line of them made the hook time out, which reads as "allowed".
    const started = Date.now();
    for (const command of [
      'git '.repeat(15000), // ~60 KB, just under the budget.
      '> a '.repeat(15000), // Redirection scanning is per operator, not per tail.
    ]) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
    // M1: `git push` repeated is the harder shape - every invocation used to
    // re-slice and re-walk the rest of the segment (12 s and ~2 GB at 63 KB).
    // Only the trailing `git push` has no refspec, so it is the one candidate.
    expect(expectBlock('git push '.repeat(7000), onMain()).rule).toBe('3');
    expect(Date.now() - started).toBeLessThan(2000);
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

  it('I4 reports only allow or block, with a reason of one or two sentences', () => {
    // Design rule 6: one or two sentences, and they say what to do next.
    expect(classify('ls -la', makeCtx())).toEqual({ decision: 'allow' });
    const verdict = classify('git push origin main', makeCtx());
    expect(Object.keys(verdict).sort()).toEqual(['decision', 'reason', 'rule']);
    expect(verdict.reason.split('. ').length).toBeLessThanOrEqual(2);
    expect(verdict.reason).toMatch(/quality-check skill/);
  });

  it('tokenizes lines, segments, redirections, comments and quoting', () => {
    const lines = tokenizeLines('echo "a b" > out.txt\ngit push 2>&1 origin main # done');
    expect(lines).toHaveLength(2);
    expect(lines[0].segments).toHaveLength(1);
    expect(lines[0].segments[0].words).toEqual(['echo', 'a b']);
    // A1: the operator and its target leave the argv; the rest of the command
    // stays put. A15: an unquoted `#` starts a comment.
    expect(lines[1].segments[0].words).toEqual(['git', 'push', 'origin', 'main']);

    // H2: `""#` and `x#` are words, not comment openers, so the segment after
    // them survives tokenization.
    const quoted = tokenizeLines('echo ""# ; git push origin main');
    expect(quoted[0].segments.map((s) => s.words)).toEqual([['echo', '#'], ['git', 'push', 'origin', 'main']]);
    const midWord = tokenizeLines("echo ''#; git merge feat");
    expect(midWord[0].segments).toHaveLength(2);
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

  it('S31 [int] fails open on an unreadable payload and outside a repo, and closes on an oversized one', () => {
    // A13: the fail-open is decided by rev-parse's exit status, and it says so.
    const outside = runHookIn(tmpDir, { tool_input: { command: 'git push origin main' } });
    expect(outside.stdout).toBe('');
    expect(outside.stderr).toMatch(/not inside a git repository/);

    const malformed = runHookIn(tmpDir, 'not json');
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toMatch(/unreadable hook payload/);

    // A5: a payload with no readable command is a fail-open that SAYS SO -
    // a silent allow here is indistinguishable from a gate that passed.
    for (const payload of [{ cwd: tmpDir }, { tool_input: { command: 12 } }]) {
      const result = runHookIn(tmpDir, payload);
      expect(result.stdout, JSON.stringify(payload)).toBe('');
      expect(result.stderr, JSON.stringify(payload)).toMatch(/unreadable hook payload/);
    }

    // A8: stdin is capped at the same budget, and what is read past it is
    // judged on its gate words - an oversized payload cannot flood the hook
    // into printing nothing (which would read as "allowed").
    const huge = runHookIn(tmpDir, { tool_input: { command: `git push origin main${' x'.repeat(60000)}` } });
    expect(JSON.parse(huge.stdout).reason).toMatch(/too long to classify/i);
  });

  it('S38 [int] reads the whole payload and blocks one it cannot hold', () => {
    initRepo();
    // H1: stdin used to stop at 64 KB of PAYLOAD, so anything past the padding
    // - the gated push included - never reached the classifier and the hook
    // printed nothing, which reads as "allowed".
    const pad = 'a'.repeat(65500);
    const padded = runHookIn(tmpDir, { tool_input: { command: `echo ${pad} && git push origin main` } });
    expect(JSON.parse(padded.stdout).decision).toBe('block');
    expect(padded.stderr).toBe('');

    // The same padding with no gated word is still allowed, silently.
    const harmless = runHookIn(tmpDir, { tool_input: { command: `echo ${pad}` } });
    expect(harmless.stdout).toBe('');
    expect(harmless.stderr).toBe('');

    // Over the payload cap there is nothing to classify, so the hook blocks
    // and says why rather than failing open on a flood.
    const flood = runHookIn(tmpDir, { tool_input: { command: `echo ${'b'.repeat(1100000)}` } });
    expect(JSON.parse(flood.stdout).decision).toBe('block');
    expect(flood.stderr).toMatch(/payload over 1 MB/);
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
