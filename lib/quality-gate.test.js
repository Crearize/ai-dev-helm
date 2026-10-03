const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFileSync, spawnSync } = require('child_process');
const { PACKAGE_ROOT } = require('./utils');
const { classify, parseSimple } = require('../templates/hooks/quality-gate.cjs');

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
//
// quality-check cycle 2, round 3 (qc-fixes-3.md) -> test names:
//   H4  gate words split by quotes or backslashes -> S39
//   M13 the 256 git/gh invocation budget          -> S35
//   M14 revert, am and bisect move HEAD           -> S8
//   L17 a mixed-case pulls/<n>/merge endpoint     -> S24
//   L21 --repo keeps refspecs in argument order   -> F4
//
// quality-check cycle 2, round 4 (qc-fixes-4.md) -> test names:
//   H5  expansion in a command or subcommand word -> WITHDRAWN in round 5 (R1)
//   M18 line continuations over the byte budget   -> S39
//   L30 the budget counts git/gh WORDS            -> header only (S35 unchanged)
//   L31 MAX_INVOCATIONS sits with the other caps  -> no behaviour change
//
// quality-check cycle 2, round 5 (qc-fixes-5.md) -> test names:
//   R1  the positional expansion rule is dropped  -> S40 (rewritten)
//   R2  threat model stated in the hook header    -> header only
//   R3  deliberate evasion is out of scope        -> S40; fallback name -> S39
//   R4  the accidental forms still regress-tested:
//       newline commit + push       -> S8, S37      redirection      -> S17
//       bare HEAD / @               -> S33, S5      sync forms       -> S19, S20
//       force/delete/--all bundles  -> S6, S13, I1  -C / cd / GIT_*  -> S9, S14
//       64 KB cut-off               -> S34, S39     `""#`            -> S36
//       revert / am / bisect        -> S8           two gated ops    -> S18
//       expansion on a gated line   -> S11, S40     control plane    -> S27, F7
// Out of scope by the threat model (round 5): H5's nine forms, H6
// (`gh pr me{r..r}ge`), M20 (`git stash po{p..p}` split by a newline) and M22
// (a percent-encoding inside quotes). They are listed in the hook header under
// the forms nothing here can see through, not asserted as blocks.
//
// quality-check cycle 5 -> test names:
//   M24 pulls/<n>/merge takes a variable or substitution segment, not just
//       digits, so it is a candidate too and blocks under rule 2's
//       expansion item                                -> M24 (new)
//   L44 header: `git stash po{p..p}` moved out of the "candidate disappears"
//       list into its own "mover hidden on a line of its own" item -> header only
//   L45 header: gh free-text carve-out counted as 6 forms, missing the
//       `--subject=`/`--body=`/`--body-file=` spellings (9 in all) -> header only
//   M26 a command substitution is part of the WORD, not a segment boundary,
//       so `gh api ... pulls/$(prnum)/merge` holds an endpoint word and is a
//       candidate; a `(` with no `$` is still a subshell -> M26 (new,
//       + the tokenizer test)
//   M27 a command substitution inside double quotes is read the same as
//       unquoted - the body is tokenized too, not just the word's expansion
//       bit -> M27 (new, + the tokenizer test)
//   M28 a double-quoted command substitution is read across newlines, as the
//       shell reads it, instead of being cut off at the first one, which used
//       to hide every continuation line from the gate -> M28 (new, + the
//       tokenizer test)
//
// #158 (H-44) relocation across lines and the attached -C<path> -> the
// 'quality-gate relocation across lines (#158)' block and two [int] tests:
//   newline / PowerShell cd, pushd, sl, Set-Location, Push-Location -> judged
//       with the DESTINATION's flag (acceptance criterion 1)
//   -C../other == -C ../other (PowerShell argv splitting, fixture
//       test/fixtures/quality-gate/powershell-argv.json) -> criterion 2
//   unresolvable moves, non-work-tree targets, two repositories -> rule 2
//   fetch and GIT_* assignments over the whole command, attached -c -> rule 2
//   same-toplevel cd sub / -C sub / -Csub stay allowed -> criterion 4
//   S8 (a fetch on another line now blocks, except the trunk sync), S9 / S14
//   / M26 keep blocking because their stub ctx has no cwd, so every move
//   there is unresolved.
// Review of PR #173 -> the '---- review of PR #173' tests and two [int]
// tests: line breaks, non-executed text, command position, && chains, block
// structure, the two shell readings of a path, network paths, empty
// arguments, more GIT_* spellings, the trunk-sync shape, the `elsewhere`
// field and failure reasons, per-destination caching, destination config
// programs, and the flag file size / type.
// Fourth review cycle of PR #173 (owner-approved redesign): a command that
// mentions a gate word is judged only in a simple, allowlisted form, and
// anything else is refused with guidance (`expectRefused`). Every bypass form
// from cycles 1-3 is kept and still blocks - most of them now as "not
// simple"; a test that used to assert an allow for a form that is no longer
// simple asserts the refusal and its guidance instead. New forms and the
// everyday allows live in the 'simple-form allowlist' block.
// Fifth (final, owner-approved) cycle -> the '---- cycle 5' tests at the end
// of the relocation block: `-C` held to the cd rule (a real directory link),
// the sync forms only as the whole command (+ `--ff-only`), pushes that write
// every matching branch, trunk-bound refspecs from another branch (S1/S26-S32
// now push `HEAD:main`, which is what they meant), `$` as an escape
// character, message values and trailing output forms, and fetch + rebase
// (S8, S37).

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
      // How git reads a merge source: here, as the remote-tracking ref.
      fullRef: (name) => (name.startsWith('refs/') ? name : `refs/remotes/${name}`),
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
  // A gated command outside the simple form: refused before any git runs,
  // with the guidance to rerun the push/merge as its own simple command.
  const expectRefused = (command, ctx = makeCtx()) => {
    const verdict = classify(command, ctx);
    expect(verdict.decision, `${command} must be refused`).toBe('block');
    expect(verdict.rule, command).toBe('2');
    expect(verdict.reason, command).toMatch(/not in the simple form/);
    expect(verdict.reason, command).toMatch(/separate command/);
    expectUntouched(ctx);
    return verdict;
  };

  // ---- rule 1: what is a candidate ------------------------------------

  it('S1 gates a push whose destination is exactly main', () => {
    expect(expectBlock('git push origin HEAD:main').reason).toMatch(/quality-check skill/i);
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
    for (const command of ['git stash push', 'git merge-base HEAD origin/main', 'git pushd']) {
      const ctx = onMain();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
    // Cycle 4: a git subcommand outside the closed list (an alias, a custom
    // command) in a command that mentions a gate word is not simple.
    expectRefused('git pull-request', onMain());
  });

  it('S24 gates the gh api merge endpoint', () => {
    expect(expectBlock('gh api repos/o/r/pulls/12/merge -X PUT').rule).toBe('3');
    expectAllow('gh api repos/o/r/pulls/12/comments');

    // H3: the endpoint word may carry a query string or a fragment - the merge
    // still happens. Cycle 4: `?`, `&` and `#` are not simple, so these are
    // refused before the endpoint is even read.
    for (const word of [
      'repos/o/r/pulls/1/merge?draft=false',
      'repos/o/r/pulls/1/merge?merge_method=squash&sha=abc',
      'repos/o/r/pulls/1/merge#frag',
      'repos/o/r/Pulls/1/Merge?merge_method=squash',
    ]) {
      expectRefused(`gh api ${word} -X PUT`);
    }
    for (const word of [
      '/repos/o/r/pulls/1/merge/',
      // L17: the API path is matched case-insensitively - GitHub answers
      // `REPOS/o/r/PULLS/1/MERGE` exactly as it answers the lower-case form.
      'REPOS/o/r/PULLS/1/MERGE',
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

  it('M24 treats a variable or substitution pulls/<n>/merge segment as a gh api candidate', () => {
    // <n> need not be digits, so a variable or substitution must not slip past
    // as a non-candidate. Cycle 4: `$` is not simple, so all of these are
    // refused before anything is resolved - a passing flag exempts nothing.
    for (const command of [
      'gh api -X PUT repos/o/r/pulls/$PR/merge',
      'gh api -X PUT "repos/o/r/pulls/${PR}/merge"',
      'gh api -X PUT "repos/o/r/pulls/$(prnum)/merge"',
    ]) {
      expectRefused(command, makeCtx(withFlag()));
    }

    // Control: a literal PR number still gates as before (rule 3, no expansion).
    expect(expectBlock('gh api repos/o/r/pulls/1/merge -X PUT').rule).toBe('3');
    // ...and so does a non-digit segment written plainly.
    expect(expectBlock('gh api repos/o/r/pulls/next/merge -X PUT').rule).toBe('3');

    // Control: the word boundary is unchanged - `pulls/1/merged` is still a
    // different endpoint and not a candidate.
    const untouched = makeCtx();
    expectAllow('gh api repos/o/r/pulls/1/merged', untouched);
    expectUntouched(untouched);
  });

  it('M26 reads a command substitution as part of the word, so pulls/$(...)/merge is a candidate', () => {
    // A command substitution, written any way, is not simple (cycle 4), so the
    // forms the tokenizer once had to read word by word are refused outright.
    for (const ctx of [makeCtx(withFlag()), onMain(withFlag())]) {
      for (const command of [
        'gh api -X PUT repos/o/r/pulls/$(prnum)/merge',
        'gh api -X PUT repos/o/r/pulls/$(gh pr view --json number -q .number)/merge',
        'gh api -X PUT repos/o/r/pulls/`prnum`/merge',
        'git push origin $(get_branch)',
        'git merge $(get_branch)',
        'gh pr merge $(prnum)',
      ]) {
        expectRefused(command, ctx);
      }
    }

    // A subshell is not simple either, whatever runs inside it.
    expectRefused('(cd sub && git push origin feat/x)');
    expectRefused('(cd sub && git push origin main)', onMain(withFlag()));

    // Controls: a substitution in a command with no gate word is not the
    // gate's business.
    for (const command of [
      'echo $(date)',
      'VERSION=$(node -p \'require("./package.json").version\') npm publish',
    ]) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('M27 reads a command substitution inside double quotes, same as unquoted', () => {
    // A substitution inside double quotes still runs; `$` and a backtick are
    // not simple inside quotes either (cycle 4).
    for (const ctx of [makeCtx(withFlag()), onMain(withFlag()), onMain()]) {
      for (const command of [
        'echo "$(git push origin main)"',
        'OUT="$(gh pr merge 3)"',
        'echo "`git push origin main`"',
        'MSG="$(git push origin main 2>&1)"',
        'X="$(git merge feat)"',
        // Formerly allowed (a feature push next to a harmless substitution, an
        // escaped `$`): with a gate word in the command, not simple.
        'echo "$(date)" && git push origin feat/x',
        'echo "\\$(git push origin main)"',
      ]) {
        expectRefused(command, ctx);
      }
    }

    // A quoted substitution in a command with no gate word stays allowed.
    const ctx = makeCtx();
    expectAllow('VERSION="$(node -p \'require("./package.json").version\')" npm publish', ctx);
    expectUntouched(ctx);
  });

  it('M28 reads a double-quoted command substitution across newlines, as the shell reads it', () => {
    // These forms once hid a candidate on a continuation line; none of them
    // is simple now (cycle 4), so they are refused whatever the branch.
    for (const ctx of [makeCtx(withFlag()), onMain(withFlag())]) {
      for (const command of [
        'LOG="$(cd repo &&\n  git push origin main)"',
        'MSG="$(\n git push origin main\n)"',
        'MSG="`\ngit push origin main\n`"',
        'echo "$(date\ngit push origin main)"',
        'RESULT="$(git push origin main 2>&1 |\n tail -1)"',
        // Formerly allowed as holding no candidate: not simple now.
        'echo $(\ngit push origin feat/x',
        'echo "$(date)\ngit push origin main"',
        'echo "a\nb" && git push origin feat/x',
      ]) {
        expectRefused(command, ctx);
      }
    }
    const ctx = makeCtx();
    expectAllow('VERSION="$(node -p \'require("./package.json").version\')" npm publish', ctx);
    expectUntouched(ctx);
  });

  it('F1 detects git and gh through case and path spellings', () => {
    expectBlock('Git Push Origin Main');
    expectBlock('GIT PUSH', onMain());
    // Cycle 4: only the bare `git` / `gh` word is a command word; a path or a
    // launcher shim is not simple, so it is refused rather than read.
    expectRefused('/usr/bin/git push origin main');
    expectRefused('"C:\\Program Files\\Git\\bin\\git.exe" push origin main');
    expectRefused('git.cmd push origin main'); // A21: Windows launcher shims.
    expectRefused('C:/tools/git.bat push origin main');

    // A14: the unquoted Windows spelling used to be allowed (characterization:
    // `\` tokenized as an escape). A backslash is not simple, so it is refused.
    expectRefused('C:\\Program Files\\Git\\bin\\git.exe push origin main');
  });

  it('F2 compares refspecs after quote removal', () => {
    expectBlock('git push origin "main"');
    expectBlock("git push origin 'main'");
  });

  it('F3 classifies each line of a multi-line command', () => {
    expectBlock('npm test\ngit push origin main');
    const ctx = makeCtx();
    expectAllow('npm test\ngit push origin feat/x', ctx);
    expectUntouched(ctx);
    // A command word outside the allowlist on any line is not simple.
    expectRefused('echo x\ngit push origin main');
    expectRefused('echo x\ngit push origin feat/x');
  });

  it('F4 reads every positional as a refspec after --repo', () => {
    expectBlock('git push --repo=origin main');
    expectBlock('git push --repo origin main');

    // L21: the first positional is held back until --repo settles whether it
    // was the remote, but the reason must still name the FIRST offending
    // refspec in argument order, or the advice points at the wrong word.
    const verdict = expectBlock('git push --repo=origin bad1:main bad2:main', makeCtx(withFlag()));
    expect(verdict.rule).toBe('2');
    expect(verdict.reason).toMatch(/bad1:main/);
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
      'git push --branches origin',
      // A2: single-dash bundles carrying `f` or `d`.
      'git push -fu origin main',
      'git push -df origin main',
      'git push -uf origin main',
      'git push -dv origin main',
    ]) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      // L19: the reason lists every flag the check actually holds.
      expect(verdict.reason, command).toMatch(/Force, delete, --all, --branches and --mirror/);
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
      ['git stash apply && git push origin main', 'stash apply'],
      // M14: `revert` and `am` make a commit and `bisect` checks one out, so
      // all three move HEAD out from under the flag exactly as `commit` does.
      ['git revert --no-edit HEAD && git push origin main', 'revert'],
      ['git am p.mbox\ngit push origin main', 'am'],
      ['git bisect start && git push origin main', 'bisect'],
    ];
    for (const [command, mover] of cases) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(new RegExp(`git ${mover}`));
    }
    // #158: `fetch` rewrites the ref a later merge reads, so it is judged over
    // the whole command like the HEAD movers. `branch -f` stays line-scoped.
    // The one exception is the daily trunk sync (see the #158 block below).
    expect(expectBlock('git fetch origin topic\ngit merge origin/topic', onMain()).reason).toMatch(/git fetch/);
    expectAllow('git fetch\ngit merge origin/main', onMain());
    // Cycle 5: a sync form is exempt only as the WHOLE command, so anything
    // on another line - here a ref rewrite - puts it back under the flag.
    expect(expectBlock('git branch -f tmp abc\ngit pull', onMain()).rule).toBe('3');
    expectAllow('git branch -f tmp abc\ngit pull', onMain(withFlag()));

    // M14 control: the mover set is CLOSED. `restore` touches the working tree
    // without moving HEAD, so it asks for the flag like any other push.
    expect(expectBlock('git restore x && git push origin main', onMain()).rule).toBe('3');
    expectAllow('git restore x && git push origin main', ctx);
    expectAllow('git tag v1 && git push origin main', ctx);
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
    // `%` and a leading `~` are simple characters, so rule 2's expansion item
    // still answers for them.
    for (const command of ['git push origin %BR%', 'git push origin ~x']) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/shell expansion/);
    }
    // Every other expansion character is not simple (cycle 4).
    for (const command of [
      'git push origin $BR',
      '`git push origin main`',
      'git push origin ma{i,in}n',
      "$'git' push origin main",
      'git push $(cat remote) main',
    ]) {
      expectRefused(command, onMain(withFlag()));
    }
  });

  it('S12 does not inspect gh free-text option values', () => {
    // The carve-out still covers what a simple command can hold (`%`).
    expectAllow('gh pr merge 12 --subject "100% done"', makeCtx(withFlag()));
    expectAllow('gh pr merge 12 --body=50% -t "x %y%"', makeCtx(withFlag()));
    const verdict = expectBlock('gh pr merge 12 --subject "100% done"');
    expect(verdict.reason).toMatch(/Quality check not passed/);
    expect(verdict.reason).not.toMatch(/expansion/);
    // A variable or a backtick in free text is not simple (cycle 4).
    expectRefused('gh pr merge 12 --subject "fix $x"', makeCtx(withFlag()));
    expectRefused('gh pr merge 12 --body "see `note`" --body-file $F', makeCtx(withFlag()));

    // A23: the carve-out belongs to the gh call - `--body` in front of a git
    // command is not a PR description.
    const leaked = expectBlock('git push --body %BR% origin main', onMain(withFlag()));
    expect(leaked.rule).toBe('2');
    expect(leaked.reason).toMatch(/shell expansion/);
  });

  it('S36 drops an unquoted comment to the end of the line', () => {
    // A15 / H2: comments, and the `""#` / `x#` words a shell does not read as
    // comments, are not simple (cycle 4): every form is refused, whatever the
    // flag, before a word of it is trusted.
    for (const ctx of [onMain(), onMain(withFlag())]) {
      for (const command of [
        'git push origin main # then git checkout foo',
        'git push origin main # note',
        'git commit -m "fix #12" && git push origin main',
        'echo ""# ; git push origin main',
        "echo ''#; git push origin main",
        'echo x# ; git push origin main',
        'echo ""#; git merge feat',
        'git commit -am wip ""# ; git push origin main',
      ]) {
        expectRefused(command, ctx);
      }
    }
  });

  it('S17 reads through a redirection instead of breaking the command there', () => {
    // A1: a redirection is not simple (cycle 4), so none of these is read.
    for (const ctx of [onMain(), onMain(withFlag()), makeCtx()]) {
      for (const command of [
        'git > /dev/null merge feat',
        'git push > /dev/null origin main',
        'git push origin >/dev/null :main',
        'gh api >/dev/null repos/o/r/pulls/1/merge -X PUT',
        'git push origin main 2> err.log',
        'git push origin main &>> err.log',
        'npm test > merge',
        'git push origin feat/x > push.log',
      ]) {
        expectRefused(command, ctx);
      }
    }
    // A redirection in a command with no gate word is not the gate's business.
    const ctx = makeCtx();
    expectAllow('echo hi > pr', ctx);
    expectUntouched(ctx);
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

    // L2: HEAD is compared case-insensitively - it names the current branch,
    // so it asks for the flag (rule 3) instead of rule 2.
    for (const spec of ['head:main', 'Head:main', 'HEAD:main']) {
      expect(expectBlock(`git push origin ${spec}`, onMain()).rule, spec).toBe('3');
      expectAllow(`git push origin ${spec}`, onMain(withFlag()));
    }
    // `@:main` is HEAD to git, but PowerShell reads a word starting with `@`
    // as a splatted variable and drops it, so it is not simple (cycle 4).
    expectRefused('git push origin @:main', onMain(withFlag()));
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

  it('allows a plain feature commit followed by a refspec-less push using only branch context', () => {
    for (const command of [
      'git commit -m "fix the bug" && git push',
      "git commit -am 'fix: the bug' && git push origin",
    ]) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expect(ctx.spies.branch).toHaveBeenCalled();
      for (const [key, spy] of Object.entries(ctx.spies)) {
        if (key !== 'branch') expect(spy, key).not.toHaveBeenCalled();
      }
      for (const branch of ['main', 'master', null]) {
        expectBlock(command, makeCtx({ branch, ...withFlag() }));
      }
    }
  });

  it('keeps the feature commit/push exception closed around branch and shell context changes', () => {
    for (const command of [
      'git switch main && git push',
      'git checkout main && git push',
      'git bisect reset main && git push',
      'git rebase origin/main main && git push',
      'git update-ref --stdin && git push',
      'git reset --hard && git push',
      'git switch main && git commit -m x && git push',
      'git switch main\ngit commit -m x && git push',
      'cd other\ngit commit -m x && git push',
      'git -C other commit -m x && git push',
      'git commit -m x && git -C other push',
      'git commit -m x > .git/HEAD && git push',
      'git commit -m "$(git switch main)" && git push',
      'git commit -m x && git push origin main',
      'git commit -m x && git push origin HEAD',
      'git commit -m x && git push --force',
      'git commit -m x && gh pr merge 12',
      'git commit -m x || git push',
      'git commit -m x; git push',
      'git commit -m x | git push',
    ]) {
      const ctx = makeCtx(withFlag());
      expectBlock(command, ctx);
      expectUntouched(ctx);
    }
  });

  it('S37 over-blocks these feature-branch lines by design', () => {
    // Characterization, not a wish: rule 2 items 1-5 are evaluated before the
    // branch is known, so they fire on a feature branch as well. Both of these
    // are safe to run and are still blocked; the fix is to split the line.
    // Cycle 5: a plain fetch and then `git rebase origin/<trunk>` is read like
    // the fetch + merge sync: off the trunk a rebase is no trunk update, and
    // on the trunk it is judged by the flag like any other gated call.
    expectAllow('git fetch && git rebase origin/main', makeCtx());
    expectAllow('git fetch origin\ngit rebase origin/master', makeCtx());
    expect(expectBlock('git fetch && git rebase origin/main', onMain()).rule).toBe('3');
    expectAllow('git fetch && git rebase origin/main', onMain(withFlag()));
    for (const command of [
      'git fetch && git rebase -i origin/main',
      'git fetch && git rebase origin/topic',
      'git fetch other && git rebase origin/main',
      'git fetch && git rebase origin/main && git status',
      'git -C . fetch && git rebase origin/main',
    ]) {
      expect(expectBlock(command, makeCtx(withFlag())).reason, command).toMatch(/git fetch/);
    }

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
    expectAllow('git push origin HEAD:main', ctx);
    // An abbreviated commit still matches its HEAD.
    expectAllow('git push origin HEAD:main', makeCtx({ flag: { commit: HEAD_SHA.slice(0, 7) } }));
  });

  it('S26 passes an ancestor flag with a harness-only diff', () => {
    const ctx = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['.claude/memo.md', 'CLAUDE.md'], overrideChanged: false },
    });
    expectAllow('git push origin HEAD:main', ctx);
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
      const verdict = classify('git push origin HEAD:main', ctx);
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
    expect(classify('git push origin HEAD:main', blocked).reason).toMatch(/^Gate control-plane changed: /);

    // The `(\/|$)` boundary (#90-7): a sibling directory whose name merely
    // starts with `hooks` is an ordinary harness file.
    const allowed = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['.claude/hooksfoo/x.md'], overrideChanged: false },
    });
    expectAllow('git push origin HEAD:main', allowed);
  });

  it('S28 blocks a harness diff that moves an override string', () => {
    const ctx = makeCtx({
      flag: { commit: OTHER_SHA },
      isAncestor: true,
      diffSinceFlag: { files: ['CLAUDE.md'], overrideChanged: true },
    });
    expect(expectBlock('git push origin HEAD:main', ctx).reason).toMatch(/Code changed after the last quality check/);
  });

  it('S30 exempts a harness-only diff against origin/main', () => {
    const ctx = makeCtx({
      diffSinceBase: { files: ['.claude/memo.md'], overrideChanged: false },
    });
    expectAllow('git push origin HEAD:main', ctx);

    // Empty, control-plane and override-string diffs are not exempt.
    expectBlock('git push origin HEAD:main', makeCtx({ diffSinceBase: { files: [], overrideChanged: false } }));
    expect(
      expectBlock('git push origin HEAD:main', makeCtx({
        diffSinceBase: { files: ['.claude/hooks/quality-gate.cjs'], overrideChanged: false },
      })).reason
    ).toMatch(/^Gate control-plane changed: /);
    expectBlock('git push origin HEAD:main', makeCtx({
      diffSinceBase: { files: ['CLAUDE.md'], overrideChanged: true },
    }));
  });

  it('blocks a stale flag that is not an ancestor of HEAD', () => {
    const ctx = makeCtx({ flag: { commit: OTHER_SHA }, isAncestor: false });
    expect(expectBlock('git push origin HEAD:main', ctx).reason).toMatch(/Code changed after the last quality check/);
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
      const verdict = classify('git push origin HEAD:main', makeCtx(over));
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

  it('S35 stays linear on long commands without an invocation cap', () => {
    // A6 / M1 / M13: the old tokenizer read every `git` / `gh` word as a call
    // and walked the rest of the segment for each, so it needed a cap of 256
    // of them. A simple segment has exactly ONE command word (cycle 4), so
    // `git` in an argument position is just an argument, and no cap is left
    // to hit. These shapes are judged on their merits, fast.
    const started = Date.now();
    for (const command of [
      'git '.repeat(15000), // ~60 KB, just under the byte budget: no gate word.
      'git -c '.repeat(9216),
      'gh -R '.repeat(9000),
      '> a '.repeat(15000),
      'git push '.repeat(7000), // One push to a remote named `git`, no main refspec.
    ]) {
      const ctx = onMain(withFlag());
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
    // A main refspec among thousands of arguments is still found.
    expect(expectBlock('git push main '.repeat(4608), onMain()).rule).toBe('3');
    // Thousands of lines, each a candidate, are each judged.
    expect(expectBlock('git push origin main\n'.repeat(3000), onMain()).rule).toBe('3');
    // Thousands of candidates on one line: one gated operation per line.
    expect(expectBlock('git push origin main && '.repeat(2700) + 'git status', onMain(withFlag())).reason)
      .toMatch(/one gated operation/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('S39 reads gate words through quotes and backslashes over the byte budget, and the fallback is fail-closed on any expansion character', () => {
    // H4: over the byte budget the line is judged on its gate words, and the
    // shell reads `p""ush` / `pu\sh` / `me""rge` as the gate words they spell.
    // Screening the RAW text alone let 70 KB of padding carry a push to main
    // through in silence.
    const oversized = (tail) => `echo ${'x'.repeat(70000)} && ${tail}`;
    expect(oversized('').length).toBeGreaterThan(64 * 1024);
    const ctx = onMain(withFlag());
    for (const tail of [
      'git p""ush origin main',
      'git pu\\sh origin main',
      "git 'me'rge origin/feat",
      'gh api -X PUT repos/o/r/pulls/1/me""rge',
    ]) {
      const verdict = classify(oversized(tail), ctx);
      expect(verdict.decision, tail).toBe('block');
      expect(verdict.reason, tail).toMatch(/too long to classify/i);
    }

    // An expansion character defeats every static reading (`$'\x70'ush` IS
    // `push`), so it blocks whether or not a gate word is left visible.
    for (const tail of ["git $'\\x70'ush origin main", 'echo "$HOME"', 'echo `id`']) {
      const verdict = classify(oversized(tail), ctx);
      expect(verdict.decision, tail).toBe('block');
      expect(verdict.reason, tail).toMatch(/shell expansion/i);
      expect(verdict.reason, tail).toMatch(/cannot be classified/i);
    }

    // M18: a `\` immediately before a newline is a LINE CONTINUATION - the
    // shell folds both characters away before it reads a word, inside double
    // quotes as well as outside. Removing the backslash on its own left a
    // newline in the middle of the gate word, so 70 KB of padding carried
    // `git pu\<LF>sh origin main` through in silence.
    const BS = '\\';
    for (const tail of [
      `git pu${BS}\nsh origin main`,
      `git me${BS}\nrge origin/main`,
      `git "pu${BS}\nsh" origin main`,
      `git pu${BS}\r\nsh origin main`, // CRLF folds the same way.
    ]) {
      const verdict = classify(oversized(tail), ctx);
      expect(verdict.decision, tail).toBe('block');
      expect(verdict.reason, tail).toMatch(/too long to classify/i);
    }

    // The fallback is fail-closed on ANY expansion character, and its set is
    // the TOKENIZER's (`$`, backtick, `{`, `}`, `%`), so a brace-expanded or
    // percent-escaped gate word blocks here even though quote stripping leaves
    // no gate word visible. Under the budget these same lines are allowed
    // (deliberate evasion is out of scope, see S40); over it there is nothing
    // to classify at all, so the cheap screen stays conservative.
    for (const tail of [
      'git pus{h..h} origin main',
      'gh api -X PUT repos/o/r/pulls/1/%6Derge',
    ]) {
      const verdict = classify(oversized(tail), ctx);
      expect(verdict.decision, tail).toBe('block');
      expect(verdict.reason, tail).toMatch(/shell expansion/i);
    }

    // No gate word and no expansion: still allowed, and still without git.
    const clean = onMain(withFlag());
    expectAllow(oversized('echo hi'), clean);
    expectUntouched(clean);
  });

  it('S40 keeps the expansion rule on lines that hold a candidate; a command or subcommand word spelled by an expansion is out of scope by threat model: deliberate evasion', () => {
    // The gate stops ACCIDENTAL operations. An expansion only blocks a line
    // that ALREADY holds a rule-1 candidate, so everyday commands that happen
    // to carry `$`, a brace or a `%` are allowed and no git is resolved.
    for (const command of [
      'git status',
      'echo $HOME',
      'npm run $TASK',
      'NODE_ENV=$ENV npm test',
      'gh api repos/{owner}/{repo}/issues',
      '$HOME/bin/tool --flag',
      'git commit -m "$MSG"',
      'git log --format=%H',
    ]) {
      const ctx = onMain(withFlag());
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }

    // Out of scope by threat model: deliberate evasion. A gate word spelled by
    // an expansion leaves no gate word in the text at all, so the command is
    // allowed by design rather than papered over; the header lists these
    // among the forms nothing here can see through.
    for (const command of ['git pus{h..h} origin main', 'gh pr me{r..r}ge 1']) {
      const ctx = onMain(withFlag());
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
    // When the gate word itself is visible, an expansion anywhere is not
    // simple (cycle 4) - including the command word.
    expectRefused('gi{t..t} push origin main', onMain(withFlag()));
    expectRefused('git push origin $BR', onMain(withFlag()));

    // And a plainly written gated push still asks for the flag, not for this.
    expect(expectBlock('git push origin main', onMain()).rule).toBe('3');
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
    const verdict = classify('git push origin HEAD:main', makeCtx());
    expect(Object.keys(verdict).sort()).toEqual(['decision', 'reason', 'rule']);
    expect(verdict.reason.split('. ').length).toBeLessThanOrEqual(2);
    expect(verdict.reason).toMatch(/quality-check skill/);
  });

  it('parses the simple form into lines and segments, and refuses everything else', () => {
    const lines = parseSimple('cd sub && git -C x push origin "a b"\nnpm test; Set-Location -Path ../y\ngit push &&\ngit status');
    expect(lines).toHaveLength(3);
    expect(lines[0].segments.map((s) => [s.before, s.words, s.after])).toEqual([
      ['', ['cd', 'sub'], '&&'],
      ['&&', ['git', '-C', 'x', 'push', 'origin', 'a b'], ''],
    ]);
    expect(lines[0].segments[0].move).toEqual({ op: 'cd', posix: true, path: 'sub' });
    expect(lines[0].segments[1].git).toMatchObject({ sub: 'push', start: 4, chdirs: ['x'] });
    expect(lines[1].segments[1].move).toEqual({ op: 'cd', posix: false, path: '../y' });
    // `&&` at the end of a line continues on the next one.
    expect(lines[2].segments.map((s) => s.before)).toEqual(['', '&&']);
    // A quoted value after `name=`, and non-ASCII letters inside quotes.
    expect(parseSimple('git commit --message="修正、完了"')[0].segments[0].words).toEqual(['git', 'commit', '--message=修正、完了']);

    for (const command of [
      'git push origin main | cat', 'git push || true', 'git push &', 'git push > log', 'git push < in',
      'git push $X', 'git push `x`', 'git push (x)', 'git push {a,b}', 'git push [a]', 'git push a*', 'git push a?',
      'git push !x', 'git push ^x', 'git push # c', 'git push a\\b', 'git push a,b', 'git push \r\n',
      'git push "a\'b"', 'git push "a"b', 'git push a"b"', "git push ''", 'git push "unterminated',
      'git push "a\\b"', 'git push "$x"', 'git push “main”', 'git push ma in', '; git push',
      'git push ;; git status', 'git push &&', '"git" push', 'X=1 git push', 'echo push', 'git -c a=b push',
      'git --git-dir=x push', 'git config alias.p push', 'git push @x', 'git --% push', 'git push -o:main',
      'cd', 'cd a b', 'cd -', 'cd ~', 'cd ~/x', 'cd +1', 'cd //host/share', 'cd -P x', 'popd x',
      'Set-Location -Path', 'gh alias set m "pr merge"', 'npm run push', 'git rebase --ex=x main',
    ]) {
      expect(() => parseSimple(command), JSON.stringify(command)).toThrow();
    }
  });
});

// #158 (H-44): a `cd` / `pushd` / `Set-Location` on an EARLIER line, and the
// attached `-C<path>` spelling, used to be judged with the current
// repository's flag. Owner decision (design Q10, option A): a statically
// resolvable move is followed to its effective directory - the same toplevel
// is judged normally, another repository with ITS OWN branch and flag - and a
// move that cannot be resolved blocks.
//
// The ctx stubs here carry `cwd`, `toplevel` and `at(dir)` on top of the
// classifier's usual getters; the directories are real, because the hook
// resolves a move against the filesystem (existence and real path), never
// against git. `repo` is on main with a flag on HEAD; `other` is another
// repository on main whose flag the test chooses.
describe('quality-gate relocation across lines (#158)', () => {
  let base;
  let repo;
  let sub;
  let other;

  beforeAll(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-reloc-')));
    repo = path.join(base, 'repo');
    sub = path.join(repo, 'sub');
    other = path.join(base, 'other');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const within = (dir, root) => dir === root || dir.startsWith(root + path.sep);
  const stub = (values) => {
    const ctx = {};
    const spies = {};
    for (const key of Object.keys(values)) {
      spies[key] = vi.fn(() => values[key]);
      Object.defineProperty(ctx, key, { get: spies[key], enumerable: true });
    }
    Object.defineProperty(ctx, 'spies', { value: spies, enumerable: false });
    return ctx;
  };
  const repoState = (over = {}) => ({
    branch: 'main',
    head: HEAD_SHA,
    flag: { commit: HEAD_SHA },
    isAncestor: false,
    diffSinceFlag: null,
    diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
    // How git reads a merge source: here, as the remote-tracking ref.
    fullRef: (name) => (name.startsWith('refs/') ? name : `refs/remotes/${name}`),
    ...over,
  });
  // `otherFlag`: does the OTHER repository hold a flag on its own HEAD?
  // `branch`: the branch both repositories are on.
  const world = ({ otherFlag = false, repoFlag = true, branch = 'main', repo: repoOver = {} } = {}) => {
    const otherCtx = stub({
      ...repoState({ branch, head: OTHER_SHA, flag: otherFlag ? { commit: OTHER_SHA } : null }),
      cwd: other,
      toplevel: other,
    });
    const repoValues = repoState({ branch, ...(repoFlag ? {} : { flag: null }), ...repoOver });
    const at = vi.fn((dir) => {
      if (within(dir, other)) return otherCtx;
      if (within(dir, repo)) return stub({ ...repoValues, cwd: dir, toplevel: repo });
      return stub({ cwd: dir, toplevel: null, branch: null });
    });
    const ctx = stub({ ...repoValues, cwd: repo, toplevel: repo, at });
    return { ctx, otherCtx, at };
  };
  // Not simple (cycle 4): refused before any location or repository is read.
  const expectRefused = (command, w = world({ otherFlag: true })) => {
    const verdict = classify(command, w.ctx);
    expect(verdict, JSON.stringify(command)).toMatchObject({ decision: 'block', rule: '2' });
    expect(verdict.reason, JSON.stringify(command)).toMatch(/not in the simple form/);
    expect(w.at, JSON.stringify(command)).not.toHaveBeenCalled();
    return verdict;
  };

  // ---- the attack forms: allowed before the fix -----------------------

  it('does not let a move on an earlier line borrow the current repository flag', () => {
    // Acceptance criterion 1: the current repository has a flag on HEAD,
    // `../other` has none, so the push into `../other` must not pass.
    for (const command of [
      'cd ../other\ngit push origin main',
      'pushd ../other\ngit merge feature',
      'chdir ../other\ngit push origin main',
      'sl ../other\ngit push origin main',
      'Set-Location ../other\ngit push origin main',
      'Set-Location -Path ../other; git push origin main',
      'Push-Location ../other\ngit push origin main',
      'cd ../other\ngh pr merge 5',
      'cd sub\ncd ../../other\ngit push origin main',
      'pushd sub\npopd\npushd ../other\ngit push origin main',
    ]) {
      const { ctx } = world();
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('3');
      expect(verdict.reason, command).toMatch(/Quality check not passed/);
    }
  });

  it('reads the attached -C<path> as -C <path> (PowerShell argv splitting)', () => {
    // Acceptance criterion 2: both spellings name the same directory, and the
    // destination has no flag, so both block for the same reason.
    for (const command of [
      'git -C../other push origin main',
      'git -C ../other push origin main',
      'git -C../other merge feature',
      'git -Csub -C../../other push origin main',
    ]) {
      const verdict = classify(command, world().ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('3');
    }
  });

  it('blocks a move it cannot resolve before a gated operation', () => {
    for (const command of [
      'cd $X\ngit push origin main',
      'cd\ngit push origin main',
      'cd -\ngit push origin main',
      'cd ~/other\ngit push origin main',
      'cd ../missing\ngit push origin main',
      'cd ../other extra\ngit push origin main',
      '(cd ../other; git push origin main)',
      'echo "$(cd ../other)"\ngit push origin main',
      'true || cd ../other\ngit push origin main',
      'true && cd ../other\ngit push origin main',
      'cd ../other | cat\ngit push origin main',
      'cd ../other &\ngit push origin main',
      'popd\ngit push origin main',
      'if true; then cd ../other; fi\ngit push origin main',
      'builtin cd ../other\ngit push origin main',
      'git -C ../missing push origin main',
      // Deferred execution: the body runs AFTER the move it precedes.
      'f() {\ngit push origin main\n}\ncd ../other\nf',
      'for i in 1 2; do git push origin main; cd ../other; done',
      'while true; do\ngit push origin main\ncd ../other\ndone',
    ]) {
      const verdict = classify(command, world({ otherFlag: true }).ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/separate command/);
    }
  });

  it('does not place a bare cd name while CDPATH can redirect it', () => {
    // bash looks `cd sub` up in CDPATH before the current directory.
    for (const command of ['export CDPATH=..\ncd sub\ngit push origin main','CDPATH=.. ; cd sub\ngit push origin main']) {
      const verdict = classify(command, world({ otherFlag: true }).ctx);
      expect(verdict, command).toMatchObject({ decision: 'block', rule: '2' });
    }
    vi.stubEnv('CDPATH', base);
    try {
      expect(classify('cd sub\ngit push origin main', world().ctx)).toMatchObject({ decision: 'block', rule: '2' });
      expectAllowed('cd ./sub\ngit push origin main', world().ctx);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('blocks an expanded -C value before any location', () => {
    // Cycle 4: `$` is not simple, so it is refused before any location.
    expectRefused('git -C$X push origin main');
    expectRefused('git -C %X% push origin main');
  });

  it('blocks a move into a directory that is not a git work tree', () => {
    const notRepo = path.join(base, 'plain');
    fs.mkdirSync(notRepo, { recursive: true });
    const verdict = classify('cd ../plain\ngit push origin main', world().ctx);
    expect(verdict.decision).toBe('block');
    expect(verdict.rule).toBe('2');
  });

  it('blocks gated operations that span two repositories in one command', () => {
    const verdict = classify(
      'git push origin main\ncd ../other\ngit push origin main',
      world({ otherFlag: true }).ctx
    );
    expect(verdict.decision).toBe('block');
    expect(verdict.rule).toBe('2');
    expect(verdict.reason).toMatch(/one repository/);
  });

  it('treats fetch as a mover over the whole command, not just its line', () => {
    // A fetch rewrites the ref the merge reads; a newline does not change that.
    for (const command of [
      'git fetch origin topic\ngit merge origin/topic',
      'git fetch origin topic\ngit merge FETCH_HEAD',
      'git fetch\ngit merge origin',
      'git fetch\ngit merge remotes/origin/main',
      'git fetch\ngit merge origin/main --no-ff',
      'git fetch origin +refs/heads/*:refs/remotes/origin/*\ngit merge origin/main',
      'git fetch origin topic:refs/remotes/origin/main\ngit merge origin/main',
      'git fetch origin main:main\ngit merge origin/main',
      'git fetch --refmap= origin\ngit merge origin/main',
      'git fetch upstream\ngit merge origin/main',
      'git fetch origin master\ngit merge origin/main',
      'git fetch origin main topic\ngit merge origin/main',
      'git fetch -C ../other\ngit merge origin/main',
      'git fetch\ngit reset --hard\ngit merge origin/main',
      'git fetch\ngit merge origin/main\ngit push origin main',
    ]) {
      const verdict = classify(command, world({ otherFlag: true }).ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
    }
    // `@{u}` blocks too (its braces are an expansion on a gated line).
    expect(classify('git fetch\ngit merge @{u}', world().ctx)).toMatchObject({ decision: 'block', rule: '2' });
  });

  it('lets the daily trunk sync through: a plain fetch, then git merge origin/<trunk> on that trunk', () => {
    const noFlag = { repoFlag: false };
    for (const command of [
      'git fetch\ngit merge origin/main',
      'git fetch origin\ngit merge origin/main',
      'git fetch origin main && git merge origin/main',
      'git fetch --prune origin; git merge refs/remotes/origin/main',
    ]) {
      expectAllowed(command, world(noFlag).ctx);
    }
    // Only on that trunk: another trunk, or a merge source of the other trunk.
    const master = world(noFlag);
    const onMaster = { ...repoState({ branch: 'master', flag: null }), cwd: repo, toplevel: repo, at: master.at };
    expect(classify('git fetch\ngit merge origin/main', stub(onMaster))).toMatchObject({ decision: 'block', rule: '2' });
    expectAllowed('git fetch\ngit merge origin/master', stub(onMaster));
    // Off the trunk a merge is not gated at all, fetch or not.
    expectAllowed('git fetch\ngit merge origin/main', stub({ ...repoState({ branch: 'feat/x', flag: null }), cwd: repo, toplevel: repo }));
  });

  it('counts GIT_* assignments and attached -c over the whole command', () => {
    for (const command of [
      "$env:GIT_DIR='../o/.git'\ngit push origin main",
      '$env:GIT_WORK_TREE = "x"\ngit push origin main',
      'GIT_WORK_TREE=x\ngit merge feature',
      'export GIT_DIR=../other/.git\ngit push origin main',
      'git -cuser.name=x push origin main',
      'git -ccore.hooksPath=x merge feature',
    ]) {
      const verdict = classify(command, world({ otherFlag: true }).ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/separate command/);
    }
  });

  // ---- contrast: what must stay (or become) allowed --------------------

  it('does not resolve anything for a move without a gated candidate', () => {
    for (const command of ['cd sub\nnpm test', 'cd ../other\ngit push origin feat/x', 'cd $X\ngit status']) {
      const { ctx } = world();
      expectAllowed(command, ctx);
      for (const [name, spy] of Object.entries(ctx.spies)) {
        expect(spy, `${command}: ctx.${name}`).not.toHaveBeenCalled();
      }
    }
  });

  it('judges a move inside the same toplevel with the current flag (acceptance criterion 4)', () => {
    for (const command of [
      'cd sub\ngit push origin feat/x',
      'cd sub\ngit push origin main',
      'cd sub && git push origin main',
      'cd sub; git push origin main',
      'pushd sub\ngit push origin main\npopd',
      'Set-Location sub\ngit push origin main',
      'cd sub\ncd ..\ngit push origin main',
      'git -C sub push origin main',
      'git -Csub push origin main',
      'git status\ngit push origin main',
      'git merge origin/main',
    ]) {
      expectAllowed(command, world().ctx);
    }
    // ...and without the flag, the same move asks for it like any push.
    const noFlag = classify('cd sub\ngit push origin main', world({ repoFlag: false }).ctx);
    expect(noFlag).toMatchObject({ decision: 'block', rule: '3' });
  });

  it('judges a move into another repository with that repository flag', () => {
    for (const command of [
      'cd ../other\ngit push origin main',
      'git -C ../other push origin main',
      'git -C../other push origin main',
      'pushd ../other\ngit merge feature\npopd',
    ]) {
      const w = world({ otherFlag: true });
      expectAllowed(command, w.ctx);
      expect(w.at, command).toHaveBeenCalled();
    }
  });

  it('reads both PowerShell argv forms of -C../other as one path', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'quality-gate', 'powershell-argv.json'), 'utf8')
    );
    const attached = classify('git -C../other push origin main', world().ctx);
    for (const [shell, argv] of Object.entries(fixture.observed)) {
      expect(classify(`git ${argv.join(' ')}`, world().ctx), shell).toEqual(attached);
    }
  });

  it.runIf(process.platform === 'win32')('[win32] PowerShell passes -C../other in one of the two forms the hook reads', () => {
    const probe = 'node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- -C../other push origin main';
    const shells = ['powershell', 'pwsh'].filter(
      (exe) => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0
    );
    expect(shells).toContain('powershell');
    for (const exe of shells) {
      const out = spawnSync(exe, ['-NoProfile', '-Command', probe], { encoding: 'utf8' });
      const argv = JSON.parse(out.stdout.trim());
      expect(
        [JSON.stringify(['-C', '../other', 'push', 'origin', 'main']),
          JSON.stringify(['-C../other', 'push', 'origin', 'main'])],
        exe
      ).toContain(JSON.stringify(argv));
    }
  });

  // ---- review of PR #173 ------------------------------------------------
  // Cycles 2 and 3 found forms the two shells read differently. Every one of
  // them still blocks; since cycle 4 most are refused as not simple.

  it('refuses a CR anywhere, since PowerShell ends a statement at a lone CR', () => {
    for (const command of [
      'cd ../other\rgit push origin main',
      'git status # note\rcd ../other\rgit push origin main',
      'cd ../other\r\ngit push origin main',
    ]) {
      expectRefused(command, world());
    }
  });

  it('does not place a move that one shell would not run (heredoc, block comment)', () => {
    for (const command of [
      'cat <<EOF\ncd ../other\nEOF\ngit push origin main',
      "cat <<'X' > notes.txt\ncd ../other\nX\ngit push origin main",
      '<#\ncd ../other\n#>\ngit push origin main',
      '<# note #> git push origin main',
    ]) {
      expectRefused(command, world({ repoFlag: false, otherFlag: true }));
    }
  });

  it('treats a move word outside plain command position as a move it cannot place', () => {
    for (const prefix of [
      'try { cd ../other } catch {}',
      'if ($false) {} else { cd ../other }',
      '1 | % { cd ../other }',
      'Invoke-Command { cd ../other }',
      '. { cd ../other }',
      'switch (1) { 1 { cd ../other } }',
      'function f { cd ../other }\nf',
      '$x = cd ../other',
      '$null = cd ../other',
      '$null = Set-Location ../other',
      '. cd ../other',
      '. Set-Location ../other',
      '& (Get-Command cd) ../other',
      'eval cd ../other',
      '<# x #> cd ../other',
      'if ($false) {\n} else{\ncd ../other\n}',
      'try {\nnpm test\n} catch{\ncd ../other\n}',
      'grep -rn cd src',
      'echo cd &&',
    ]) {
      expectRefused(`${prefix}\ngit push origin main`, world());
    }
    // A move word as an ARGUMENT of an allowlisted command moves nothing, so
    // it is no longer over-detected: the push runs here, with this flag.
    expectAllowed('git log --grep pushd\ngit push origin main', world().ctx);
  });

  it('does not place anything in a command that runs text it cannot read', () => {
    for (const prefix of [
      'eval "$STEP"',
      "iex 'npm test'",
      'Invoke-Expression $script',
      'function f { npm test }',
      'f() { npm test; }',
      '& $tool',
      '& { npm test }',
      '. $profile',
    ]) {
      expectRefused(`${prefix}\ngit push origin main`, world());
    }
  });

  it('does not follow a move after a comment line or a block count it lost', () => {
    for (const command of [
      '#> cd ../other\ngit push origin main',
      'if false; then\necho }\ncd ../other\nfi\ngit push origin main',
    ]) {
      expectRefused(command, world({ repoFlag: false, otherFlag: true }));
    }
  });

  it('refuses a move followed by ||', () => {
    // `||` is not simple: the right-hand side would run in the old directory.
    expectRefused('cd ../other || git push origin main', world({ repoFlag: false, otherFlag: true }));
    expectRefused('cd ../other || git push origin main', world({ otherFlag: true }));
  });

  it('does not trust a command whose quotes the two shells close differently', () => {
    for (const command of ['Write-Host "C:\\tmp\\"; git push origin main', "echo 'x\ngit push origin main"]) {
      expectRefused(command, world());
    }
    expectAllowed('echo "unterminated', world().ctx);
  });

  it.runIf(process.platform === 'win32')('[win32] does not place a drive-relative path', () => {
    // Git Bash reads `C:../other` as `C:/../other`; PowerShell as relative to
    // drive C's current directory.
    expectRefused(`cd ${repo[0]}:../other\ngit push origin main`, world({ repoFlag: false, otherFlag: true }));
    expectRefused(`git -C ${repo[0]}:../other push origin main`, world({ repoFlag: false, otherFlag: true }));
  });

  it('lets the trunk sync through only as the whole command, and only for the remote-tracking ref', () => {
    const noFlag = { repoFlag: false };
    for (const command of [
      'git remote set-url origin ../other\ngit fetch\ngit merge origin/main',
      'git remote add o2 ../other; git fetch origin main; git merge origin/main',
      'git fetch\ngit merge origin/main\ngit status',
      'git fetch "origin"\ngit merge origin/main',
    ]) {
      expect(classify(command, world(noFlag).ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
    for (const command of [
      'git config remote.origin.url ../other && git fetch && git merge origin/main',
      'git fetch > out.txt\ngit merge origin/main',
    ]) {
      expectRefused(command, world(noFlag));
    }
    // A local tag or branch named origin/main is what git would merge.
    for (const fullRef of [() => 'refs/tags/origin/main', () => 'refs/heads/origin/main', () => null]) {
      const { at } = world(noFlag);
      const ctx = stub({ ...repoState({ flag: null, fullRef }), cwd: repo, toplevel: repo, at });
      expect(classify('git fetch\ngit merge origin/main', ctx)).toMatchObject({ decision: 'block', rule: '2' });
      // Cycle 4: the standalone sync form checks the same thing - the
      // exemption is gone, so it asks for the flag like any merge.
      const alone = stub({ ...repoState({ flag: null, fullRef }), cwd: repo, toplevel: repo, at });
      expect(classify('git merge origin/main', alone)).toMatchObject({ decision: 'block', rule: '3' });
    }
  });

  it('follows a move inside an && chain, and judges every place the chain may stop', () => {
    expect(classify('npm test && cd ../other && git push origin main', world().ctx))
      .toMatchObject({ decision: 'block', rule: '3' });
    expectAllowed('npm test && cd ../other && git push origin main', world({ otherFlag: true }).ctx);
    expectAllowed('cd ../other && cd ../repo\ngit push origin main', world().ctx);
    // Past the end of the chain, `npm test` may have failed before the move:
    // the push is judged in both places, and both must pass.
    const both = 'npm test && cd ../other\ngit push origin main';
    expectAllowed(both, world({ otherFlag: true }).ctx);
    expect(classify(both, world({ repoFlag: false, otherFlag: true }).ctx)).toMatchObject({ decision: 'block', rule: '3' });
    expect(classify(both, world().ctx)).toMatchObject({ decision: 'block', rule: '3', elsewhere: true });
    expectRefused('true || cd ../other && git push origin main', world({ otherFlag: true }));
  });

  it('refuses a block of either shell, with or without a move in it', () => {
    for (const command of [
      'cd sub; git push origin main\nif ($LASTEXITCODE -eq 0) { Write-Output ok }',
      'if ($LASTEXITCODE -eq 0) { Write-Output ok }\ncd sub\ngit push origin main',
      'try { npm test } catch { exit 1 }\ncd sub\ngit push origin main',
      'if [ -f x ]; then echo y; fi\ncd sub\ngit push origin main',
      'if ($x) { cd ../other }\ngit push origin main',
      'if ($x) {\ncd ../other\n}\ngit push origin main',
      'cd sub\n$f = { git push origin main }',
      '1..2 | ForEach-Object { git push origin main; cd ../other }',
    ]) {
      expectRefused(command, world({ otherFlag: true }));
    }
  });

  it('refuses a backslash path, which the two shells read differently', () => {
    for (const command of [
      'git -C ..\\other push origin main',
      'Set-Location ..\\other; git push origin main',
      'cd ..\\other\ngit push origin main',
    ]) {
      expectRefused(command, world({ repoFlag: false, otherFlag: true }));
      expectRefused(command, world());
    }
  });

  it.runIf(process.platform === 'win32')('[win32] refuses an absolute path without a drive letter', () => {
    // Git Bash maps `/c/…` to C:\…; PowerShell reads it from the current
    // drive's root. Only `C:/…` means the same place to both.
    const msys = `/${other[0].toLowerCase()}/${other.slice(3).replace(/\\/g, '/')}`;
    expectRefused(`cd ${msys}\ngit push origin main`, world({ otherFlag: true }));
    expectRefused('cd /tmp\ngit push origin main', world({ otherFlag: true }));
    const drive = other.replace(/\\/g, '/');
    expectAllowed(`cd ${drive}\ngit push origin main`, world({ otherFlag: true }).ctx);
    expect(classify(`cd ${drive}\ngit push origin main`, world().ctx)).toMatchObject({ decision: 'block', rule: '3' });
  });

  it('never touches a network path', () => {
    const real = fs.realpathSync.native;
    const seen = [];
    const spies = [
      vi.spyOn(fs.realpathSync, 'native').mockImplementation((p, ...rest) => {
        seen.push(String(p));
        return real(p, ...rest);
      }),
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs, 'statSync'),
    ];
    try {
      for (const command of [
        'cd //host/share\ngit push origin main',
        'git -C //host/share push origin main',
        'git -C \\\\host\\share push origin main',
        'Set-Location \\\\host\\share; git push origin main',
      ]) {
        expectRefused(command, world({ otherFlag: true }));
      }
      for (const spy of spies.slice(1)) for (const [p] of spy.mock.calls) seen.push(String(p));
      expect(seen.filter((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('refuses an empty quoted argument, which Windows PowerShell drops', () => {
    // `git -C '' push` is `git -C push` once PowerShell 5.1 has dropped the
    // empty string, and `git -C '' push` to a POSIX shell.
    expectRefused("git -C '' -C ../other push origin main", world());
    expectRefused("git -C '' push origin main", world());
    expectRefused('git push origin "" main', world());
  });

  it('reads PowerShell environment drive and .NET assignments of GIT_*', () => {
    for (const command of [
      'Set-Item Env:GIT_DIR ../other/.git\ngit push origin main',
      'Set-Item -Path Env:\\GIT_WORK_TREE -Value x\ngit push origin main',
      "[Environment]::SetEnvironmentVariable('GIT_DIR', '../other/.git')\ngit push origin main",
    ]) {
      expectRefused(command, world({ otherFlag: true }));
    }
  });

  it('marks a verdict decided elsewhere, and tells a git failure from a non-repository', () => {
    expect(classify('cd ../other\ngit push origin main', world().ctx)).toMatchObject({ decision: 'block', elsewhere: true });
    expect(classify('git push origin main', world({ repoFlag: false }).ctx).elsewhere).toBeUndefined();
    const broken = stub({
      ...repoState(),
      cwd: repo,
      toplevel: repo,
      at: () => ({ toplevel: null, state: { failure: 'git-error' } }),
    });
    expect(classify('cd ../other\ngit push origin main', broken).reason).toMatch(/git failed/);
  });

  it('reads each destination once and stops following moves after the last candidate', () => {
    const w = world({ otherFlag: true });
    expectAllowed('cd ../other\ngit merge origin/main\ngit push origin main', w.ctx);
    expect(w.at).toHaveBeenCalledTimes(1);
    expectAllowed(`git push origin main\n${'cd sub\ncd ..\n'.repeat(100)}`, world().ctx);
  });

  // ---- cycle 4: the simple-form allowlist --------------------------------

  it('refuses the cycle-3 forms as not simple', () => {
    for (const command of [
      // A backslash before a separator or at the end, in a PowerShell path.
      'cd ..\\other\\; git push origin main',
      'cd ..\\other\\\ngit push origin main',
      'Set-Location ..\\other\\\ngit push origin main',
      'git -C ..\\other\\ push origin main',
      // An escaped quote inside double quotes.
      'git commit -m "a\\"; cd ../other; git push origin main"',
      // GIT_* through other spellings.
      'GIT_DIR+=../other/.git git push origin main',
      'export GIT_DIR=../other/.git\ngit push origin main',
      'read GIT_DIR <<< ../other/.git\ngit push origin main',
      'New-Item -Path Env:GIT_DIR -Value ../other/.git\ngit push origin main',
      // Alias definitions in the same command.
      'alias cd=pushd\ncd ../other\ngit push origin main',
      'Set-Alias g git\ng push origin main',
      'git config alias.p push && git p origin main',
      'gh alias set m "pr merge" && gh m 5',
      // Other ways to run in another directory.
      'env -C ../other git push origin main',
      'env --chdir=../other git push origin main',
      'Start-Process git -ArgumentList push -WorkingDirectory ../other',
      'New-PSDrive -Name Q -PSProvider FileSystem -Root ../other\nSet-Location Q:\ngit push origin main',
      'Set-Location Q:\ngit push origin main',
      "$ExecutionContext.SessionState.Path.SetLocation('../other'); git push origin main",
    ]) {
      expectRefused(command, world());
    }
  });

  it('refuses words PowerShell and a POSIX shell pass to git differently', () => {
    for (const command of [
      'git push -o:main origin feat/x', // PowerShell: `-o:` `main`
      'git push -ofoo.main origin feat/x', // PowerShell: `-ofoo` `.main`
      'git push origin feat/x,main', // a PowerShell array
      'git push origin @args', // splatting
      'git --% push origin main', // stop-parsing
      'git push origin \u201cmain\u201d', // typographic quotes
    ]) {
      expectRefused(command, world());
    }
  });

  it('refuses a call that runs a command string, and a runner that mentions a gate word', () => {
    for (const command of [
      'npx -c "git push origin main"',
      'npm exec -- git push origin main',
      'pnpm exec git push origin main',
      'node -e "x" push',
      'git rebase -x "git push origin main" HEAD~1',
      'git rebase --exec="git push origin main" HEAD~1',
      'git rebase --ex "git push origin main" HEAD~1',
      'git bisect run git push origin main',
      'git fetch --upload-pack="git push origin main" ../other',
      'git push --receive-pack=x ../other feat/x',
      'git grep -Ogit push',
      'git submodule foreach "git push origin main"',
    ]) {
      expectRefused(command, world());
    }
  });

  it('reads abbreviated push options the way git does', () => {
    // `--rep` is `--repo` to git: `main` is the refspec, not the remote.
    expect(classify('git push --rep=origin HEAD:main', world({ repoFlag: false, branch: 'feat/x' }).ctx))
      .toMatchObject({ decision: 'block', rule: '3' });
    for (const command of ['git push --forc origin main', 'git push --del origin main', 'git push --mir origin']) {
      expect(classify(command, world().ctx), command)
        .toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('allows the everyday simple forms', () => {
    const everyday = [
      'git push',
      'git push origin feat/x',
      'cd sub && git push',
      'cd sub; git push',
      'Set-Location sub\ngit push',
      'git -C sub push',
      'pushd sub && git push && popd',
      'npm test && git push',
      'git log --grep cd',
      'git log --grep push',
      'git commit -m "msg with spaces"',
      'git status\ngit push origin feat/x',
    ];
    // On a feature branch with no flag: nothing here is gated - nor is the
    // plain commit-and-push, with a Japanese message.
    for (const command of [...everyday, 'git commit -m "push の修正、完了" && git push']) {
      expectAllowed(command, world({ repoFlag: false, branch: 'feat/x' }).ctx);
    }
    // On main with a flag on HEAD: gated, and passing.
    for (const command of everyday) {
      expectAllowed(command, world().ctx);
    }
    // ...and on main without one, the gated ones ask for the flag.
    for (const command of ['git push', 'cd sub && git push', 'Set-Location sub\ngit push', 'git -C sub push']) {
      expect(classify(command, world({ repoFlag: false }).ctx), command).toMatchObject({ decision: 'block', rule: '3' });
    }
  });

  it('judges a PowerShell-only move in both places a POSIX shell and PowerShell leave it', () => {
    // `Set-Location` is "command not found" to a POSIX shell, so the push may
    // run here or in ../other: both repositories must pass.
    const command = 'Set-Location ../other; git push origin main';
    expectAllowed(command, world({ otherFlag: true }).ctx);
    expect(classify(command, world({ otherFlag: true, repoFlag: false }).ctx)).toMatchObject({ decision: 'block', rule: '3' });
    expect(classify(command, world().ctx)).toMatchObject({ decision: 'block', rule: '3' });
    // A POSIX `cd` runs in both shells: only ../other is judged.
    expectAllowed('cd ../other; git push origin main', world({ otherFlag: true, repoFlag: false }).ctx);
  });

  it('refuses a gated command mentioning a gate word outside the simple form, with guidance', () => {
    const verdict = expectRefused('git commit -m "fix(gate): push check" && git push', world());
    expect(verdict.reason).toMatch(/`\(` inside quotes/);
    expect(verdict.reason).toMatch(/git -C <path>/);
    expect(verdict.reason).toMatch(/git commit -F <file>/);
    expect(expectRefused('grep -rn push src', world()).reason).toMatch(/the command `grep`/);
    // No gate word: not the gate's business, however it is written.
    expectAllowed('grep -rn "fix(gate)" src | head', world().ctx);
  });

  const expectAllowed = (command, ctx) => {
    const verdict = classify(command, ctx);
    expect(verdict, `${command} must be allowed (got ${verdict.reason})`).toMatchObject({ decision: 'allow' });
  };

  // ---- cycle 5 (owner-approved final cycle) ------------------------------

  describe('a directory link under -C and ..', () => {
    // `repo/J` is a link (a junction on Windows) to `other/inner`. On Windows
    // git and PowerShell resolve `..` lexically on the apparent path, so
    // `git -C J/..` runs in `repo`, while the physical walk lands in `other`.
    // `other` holds a flag and `repo` none: judging the physical reading let
    // the push into `repo` through.
    beforeAll(() => {
      fs.mkdirSync(path.join(other, 'inner'), { recursive: true });
      fs.symlinkSync(path.join(other, 'inner'), path.join(repo, 'J'), 'junction');
    });

    it('refuses a -C target whose lexical and physical readings disagree', () => {
      for (const command of [
        'git -C J/.. push origin main',
        'git -CJ/.. push origin main',
        'cd J\ngit -C .. push origin main',
        'pushd J\ngit -C .. push origin main',
        'Set-Location J; git -C .. merge feature',
        'git -C J -C .. push origin main',
      ]) {
        const verdict = classify(command, world({ otherFlag: true, repoFlag: false }).ctx);
        expect(verdict, command).toMatchObject({ decision: 'block', rule: '2', elsewhere: true });
        expect(verdict.reason, command).toMatch(/must be a local directory that exists now/);
      }
      // Where both readings agree, a link is still followed.
      expect(classify('git -C J push origin main', world({ otherFlag: false }).ctx))
        .toMatchObject({ decision: 'block', rule: '3' });
    });
  });

  it('exempts a trunk sync form only as the whole command', () => {
    // A ref named origin/<trunk> made earlier in the same command is not
    // there yet when the hook reads it, and git would merge it instead.
    const noFlag = () => world({ repoFlag: false }).ctx;
    for (const command of [
      'git tag origin/main HEAD~3\ngit merge origin/main',
      'git branch origin/main abc\ngit merge origin/main',
      'git remote set-url origin ../other\ngit pull',
      'git remote set-url origin ../other\ngit pull origin main',
      'git status\ngit pull',
      'git log -1; git merge origin/main',
    ]) {
      expect(classify(command, noFlag()), command).toMatchObject({ decision: 'block', rule: '3' });
    }
    for (const command of ['git pull', 'git pull origin main', 'git merge origin/main',
      'git pull --ff-only', 'git pull --ff-only origin main', 'git merge --ff-only origin/main',
      'git fetch\ngit merge --ff-only origin/main', 'git fetch origin main && git merge origin/main']) {
      expectAllowed(command, noFlag());
    }
    // --ff-only does not lift the remote-tracking requirement.
    const tagged = () => world({ repoFlag: false, repo: { fullRef: () => 'refs/tags/origin/main' } }).ctx;
    expect(classify('git merge --ff-only origin/main', tagged()).decision).toBe('block');
    expect(classify('git fetch && git merge --ff-only origin/main', tagged()).decision).toBe('block');
  });

  it('refuses a push that writes every matching branch', () => {
    const feature = () => world({ branch: 'feat/x' }).ctx;
    for (const command of [
      'git push origin :', 'git push origin +:', 'git push origin feat/x:',
      'git push --all origin feat/x', 'git push --mirror origin feat/x', 'git push --branches origin feat/x',
    ]) {
      expect(classify(command, feature()), command).toMatchObject({ decision: 'block', rule: '2' });
    }
    expect(classify('git push origin :', feature()).reason).toMatch(/every matching branch/);
    expectAllowed('git push origin feat/x:feat/x', feature());
    expectAllowed('git push --tags origin', feature());
  });

  it('pushes to the trunk only from HEAD or the current branch', () => {
    // A flag on a feature branch covers that branch, not the local main.
    const feature = () => world({ branch: 'feat/x' }).ctx;
    for (const command of [
      'git push origin main',
      'git push origin refs/heads/main',
      'git push origin main:main',
      'git push origin feat/x main',
      'git push origin heads/master',
    ]) {
      const verdict = classify(command, feature());
      expect(verdict, command).toMatchObject({ decision: 'block', rule: '2' });
      expect(verdict.reason, command).toMatch(/Check out that branch and push from it/);
    }
    for (const command of ['git push origin HEAD:main', 'git push origin feat/x:main',
      'git push origin refs/heads/feat/x:refs/heads/main', 'git push origin feat/x']) {
      expectAllowed(command, feature());
    }
    // On the trunk itself `main` is the current branch.
    for (const command of ['git push origin main', 'git push origin refs/heads/main', 'git push origin main:main']) {
      expectAllowed(command, world().ctx);
    }
  });

  it('reads a `$` as an escape character when looking for gate words', () => {
    expectRefused("git pu$''sh origin main");
    expectRefused("git me$''rge feature");
  });

  describe('message values and trailing output forms', () => {
    const heredoc = (body, delim = 'EOF') => `"$(cat <<'${delim}'\n${body}\n${delim}\n)"`;
    const contexts = () => [world().ctx, world({ branch: 'feat/x', repoFlag: false }).ctx];

    it('allows a gate word that appears only in a literal message value', () => {
      for (const command of [
        `git commit -m ${heredoc('fix: merge the push queue (rebase-safe)\n\nCo-Authored-By: x <x@example.com>')}`,
        `git commit -a -m "fix: push" -m ${heredoc('pull "request" notes')}`,
        `gh pr create --title "Fix the merge queue" --body ${heredoc('## Summary\n- rebase, push and pull')}`,
        `gh pr edit 5 -b ${heredoc('merge notes')}`,
        `gh issue comment 7 --body ${heredoc('pull this in')}`,
        `gh pr review 5 --approve -b 'looks good to merge'`,
        "git tag -a v1 -m 'release: merge train'",
        "git commit -m @'\nfix: push queue\n'@",
        `git commit -m ${heredoc('merge')} 2>&1 | tail -3`,
      ]) {
        for (const ctx of contexts()) {
          expectAllowed(command, ctx);
          for (const spy of Object.values(ctx.spies)) expect(spy, command).not.toHaveBeenCalled();
        }
      }
    });

    it('still refuses every abuse of the message forms', () => {
      for (const command of [
        `git commit -m ${heredoc('x')} && git push origin main`,
        'echo "$(git commit -m x; git push origin main)"',
        `git commit -m "$(git push origin main)"`,
        // A line starting with the delimiter before the real terminator.
        `git commit -m "$(cat <<'EOF'\nx\nEOF)\npush\nEOF\n)"`,
        `git commit -m "$(cat <<'EOF'\nx\nEOF \nmerge\nEOF\n)"`,
        `git commit -m "$(cat <<'EOF'\npull\nEOF\n) "`,
        `git commit -m "$(cat <<'EOF'\r\npull\r\nEOF\r\n)"`,
        // An unquoted delimiter expands the body.
        `git commit -m "$(cat <<EOF\npull\nEOF\n)"`,
        `git commit -m "$(cat <<"EOF"\npull\nEOF\n)"`,
        // Quoting the two shells read differently.
        "git commit -m 'it''s a merge'",
        'git commit -m "a ""merge"" b"',
        "git commit -m @'\nit's a merge\n'@",
        'git commit -m "fix “merge”"',
        // The value holds a git/gh word and a gate word.
        `git commit -m ${heredoc('git push origin main')}`,
        `gh pr create -b ${heredoc('then gh pr merge 5')}`,
        // Not a message of git commit|tag / gh pr|issue create|edit|comment|review.
        `eval git commit -m 'x; pull'`,
        "alias c='git commit'\nc -m 'merge'",
        `npx -c "git commit -m 'merge'"`,
        `git log --grep ${heredoc('merge')}`,
        `gh pr merge 5 --body ${heredoc('merge')}`,
        `git commit -m ${heredoc('merge')}; git $'\\x70'ush`,
      ]) {
        const verdict = classify(command, world({ repoFlag: false }).ctx);
        expect(verdict.decision, JSON.stringify(command)).toBe('block');
      }
    });

    it('allows the trailing output forms only at the very end', () => {
      expectAllowed('git push origin feat/x 2>&1 | tail -5', world({ branch: 'feat/x' }).ctx);
      expectAllowed('git push origin HEAD:main >/dev/null 2>&1', world({ branch: 'feat/x' }).ctx);
      expectAllowed('git pull 2>/dev/null', world({ repoFlag: false }).ctx);
      expectAllowed('git fetch && git merge origin/main | head -20', world({ repoFlag: false }).ctx);
      expect(classify('git push origin main 2>&1 | tail -5', world({ repoFlag: false }).ctx))
        .toMatchObject({ decision: 'block', rule: '3' });
      for (const command of [
        'git push origin main 2>&1\ngit status',
        'git push origin main | tail -5 | cat',
        'git push origin main | grep x',
        'git push origin main 2>&1 | tail -n 5',
        'git push origin main > /dev/null',
        'git push origin main >out.txt',
        'git push origin main2>&1',
        'git push origin main | tail -5 && git status',
      ]) {
        expectRefused(command, world({ otherFlag: true }));
      }
    });
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

  it('reads a UTF-8 BOM payload without bypassing the gate', () => {
    const g = initRepo();
    const payload = (command) => '\uFEFF' + JSON.stringify({ tool_input: { command } });
    const blocked = runHookIn(tmpDir, payload('git push origin main'));
    expect(decision(blocked.stdout)).toBe('block');
    expect(blocked.stderr).toBe('');
    writeFlag(head(g));
    expect(runHookIn(tmpDir, payload('git push origin main'))).toEqual({ stdout: '', stderr: '' });
    expect(runHookIn(tmpDir, payload('git status'))).toEqual({ stdout: '', stderr: '' });
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

  // #158: two real repositories side by side. `repo` (the session's cwd) is on
  // main with a flag on HEAD; `other` is on main with no flag until the test
  // writes one.
  const twoRepos = () => {
    const make = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const g = (...args) =>
        execFileSync(
          'git',
          ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
            '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
          { cwd: dir, encoding: 'utf8' }
        ).trim();
      g('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, 'app.js'), `console.log(${JSON.stringify(dir)});\n`);
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'x.js'), 'x\n');
      g('add', '-f', 'app.js', 'sub/x.js');
      g('commit', '-q', '-m', 'init');
      g('update-ref', 'refs/remotes/origin/main', 'HEAD~0');
      fs.writeFileSync(path.join(dir, 'code.js'), 'y\n');
      g('add', '-f', 'code.js');
      g('commit', '-q', '-m', 'code');
      return g;
    };
    const repo = path.join(tmpDir, 'repo');
    const other = path.join(tmpDir, 'other');
    const gRepo = make(repo);
    const gOther = make(other);
    fs.writeFileSync(path.join(repo, FLAG), JSON.stringify({ branch: 'main', commit: head(gRepo) }) + '\n');
    const flagOther = () =>
      fs.writeFileSync(path.join(other, FLAG), JSON.stringify({ branch: 'main', commit: head(gOther) }) + '\n');
    const run = (command, cwd = repo) => runHookIn(cwd, { cwd, tool_input: { command } });
    return { repo, other, run, flagOther, gOther };
  };

  it('#158 [int] does not run programs from the destination repository config', () => {
    const { other, run, gOther } = twoRepos();
    // A harness config file in the diff makes the hook read a patch (-U0),
    // which is where an external diff driver or a textconv filter would run.
    const marker = path.join(tmpDir, 'ran.txt');
    const script = path.join(tmpDir, 'mark.js');
    fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
    const cmd = `node "${script.replace(/\\/g, '/')}"`;
    fs.writeFileSync(path.join(other, '.gitattributes'), '*.md diff=mark\n');
    fs.writeFileSync(path.join(other, 'CLAUDE.md'), '# rules\n');
    gOther('add', '-f', '.gitattributes', 'CLAUDE.md');
    gOther('commit', '-q', '-m', 'harness');
    gOther('config', 'diff.external', cmd);
    gOther('config', 'diff.mark.textconv', cmd);
    gOther('config', 'core.fsmonitor', cmd);
    const out = run('cd ../other\ngit push origin main');
    expect(decision(out.stdout)).toBe('block');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('#158 [int] reads only a small regular flag file', () => {
    const { other, run, gOther } = twoRepos();
    const commit = gOther('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(other, FLAG), JSON.stringify({ branch: 'main', commit }) + ' '.repeat(5000));
    expect(decision(run('cd ../other\ngit push origin main').stdout)).toBe('block');
    fs.writeFileSync(path.join(other, FLAG), JSON.stringify({ branch: 'main', commit }) + '\n');
    expect(run('cd ../other\ngit push origin main').stdout).toBe('');
  });

  it('#158 [int] judges a move to another repository with that repository flag', () => {
    const { run, flagOther } = twoRepos();
    for (const command of [
      'cd ../other\ngit push origin main',
      'pushd ../other\ngit merge feature',
      'git -C../other push origin main',
      'git -C ../other push origin main',
      'Set-Location ../other; git push origin main',
    ]) {
      const out = run(command);
      expect(decision(out.stdout), command).toBe('block');
      expect(JSON.parse(out.stdout).reason, command).toMatch(/Quality check not passed/);
    }
    // Same toplevel: the current flag answers (acceptance criterion 4).
    for (const command of ['cd sub\ngit push origin main', 'cd sub && git push origin main', 'git -Csub push origin main']) {
      expect(run(command).stdout, command).toBe('');
    }
    // The destination's own flag answers for it.
    flagOther();
    expect(run('cd ../other\ngit push origin main').stdout).toBe('');
    expect(run('git -C../other push origin main').stdout).toBe('');
  });

  it('#158 [int] does not fail open when the session cwd is outside a repository but the move is not', () => {
    const { run } = twoRepos();
    // tmpDir itself is not a repository: a plain push there is the fail-open,
    // but a push after `cd other` lands in a real one and is judged there.
    expect(run('git push origin main', tmpDir).stderr).toMatch(/not inside a git repository/);
    const moved = run('cd other\ngit push origin main', tmpDir);
    expect(decision(moved.stdout)).toBe('block');
    expect(moved.stderr).toBe('');
    const unresolved = run('cd $REPO\ngit push origin main', tmpDir);
    expect(decision(unresolved.stdout)).toBe('block');
  });

  it('#158 [int] lets the trunk sync through only when origin/main is the remote-tracking ref', () => {
    const g = initRepo();
    expect(runHook('git fetch\ngit merge origin/main')).toBe('');
    g('tag', 'origin/main');
    expect(decision(runHook('git fetch\ngit merge origin/main'))).toBe('block');
  });

  // GIT_NO_LAZY_FETCH arrived in git 2.44.
  const gitAtLeast = (major, minor) => {
    const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
    return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
  };

  it.runIf(gitAtLeast(2, 44))('#158 [int] never fetches a missing object from a partial clone remote', () => {
    const g = (cwd, ...args) =>
      execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
        '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' }).trim();
    const origin = path.join(tmpDir, 'origin');
    fs.mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(origin, 'CLAUDE.md'), 'v1\n');
    g(origin, 'add', 'CLAUDE.md');
    g(origin, 'commit', '-q', '-m', 'a');
    g(origin, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(origin, 'CLAUDE.md'), 'v2\n');
    g(origin, 'commit', '-q', '-am', 'b');
    g(origin, 'checkout', '-q', 'main');
    g(origin, 'config', 'uploadpack.allowFilter', 'true');
    g(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const clone = path.join(tmpDir, 'clone');
    g(tmpDir, 'clone', '-q', '--filter=blob:none', pathToFileURL(origin).href, clone);
    // main now holds the harness-only commit whose blob was never fetched; the
    // diff that reads it (for the override strings) needs that blob.
    g(clone, 'update-ref', 'refs/heads/main', g(clone, 'rev-parse', 'origin/feat'));
    const blob = g(clone, 'rev-parse', 'origin/feat:CLAUDE.md');
    const present = () =>
      spawnSync('git', ['cat-file', '-e', blob], { cwd: clone, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).status === 0;
    expect(present()).toBe(false);
    const out = runHookIn(clone, { cwd: clone, tool_input: { command: 'git push origin main' } });
    expect(decision(out.stdout)).toBe('block');
    expect(present()).toBe(false);
  });
});
