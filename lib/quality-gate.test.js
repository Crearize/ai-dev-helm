const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
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
      // L17: the API path is matched case-insensitively - GitHub answers
      // `REPOS/o/r/PULLS/1/MERGE` exactly as it answers the lower-case form.
      'REPOS/o/r/PULLS/1/MERGE',
      'repos/o/r/Pulls/1/Merge?merge_method=squash',
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
    // <n> need not be digits: a PR-number variable or substitution is a
    // common, benign way to write this call, and it must not slip past as a
    // non-candidate. Once it is a candidate, the word also carries a shell
    // expansion character, so the existing rule 2 expansion item - not this
    // regex - is what actually blocks it (evaluated ahead of the flag, so a
    // passing flag does not exempt it either).
    const ctx = makeCtx(withFlag());
    for (const command of [
      'gh api -X PUT repos/o/r/pulls/$PR/merge',
      'gh api -X PUT "repos/o/r/pulls/${PR}/merge"',
      'gh api -X PUT "repos/o/r/pulls/$(prnum)/merge"',
    ]) {
      const verdict = classify(command, ctx);
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/shell expansion/);
    }

    // Control: a literal PR number still gates as before (rule 3, no expansion).
    expect(expectBlock('gh api repos/o/r/pulls/1/merge -X PUT').rule).toBe('3');

    // Control: the word boundary is unchanged - `pulls/1/merged` is still a
    // different endpoint and not a candidate.
    const untouched = makeCtx();
    expectAllow('gh api repos/o/r/pulls/1/merged', untouched);
    expectUntouched(untouched);
  });

  it('M26 reads a command substitution as part of the word, so pulls/$(...)/merge is a candidate', () => {
    // A shell reads `$(` ... `)` and a backtick pair as part of the word they
    // sit in. The tokenizer used to cut segments at `(`, `)` and backticks, so
    // `repos/o/r/pulls/$(prnum)/merge` broke into `repos/o/r/pulls/$`, `prnum`
    // and `/merge`: no word held a `pulls/<n>/merge` endpoint, the line had no
    // candidate at all, and the merge was allowed outright. Taking the PR
    // number from `$(gh pr view ...)` is a benign, everyday spelling, so this
    // sits inside the threat model.
    const forms = [
      'gh api -X PUT repos/o/r/pulls/$(prnum)/merge',
      'gh api -X PUT repos/o/r/pulls/$(gh pr view --json number -q .number)/merge',
      'gh api -X PUT repos/o/r/pulls/`prnum`/merge',
    ];
    for (const ctx of [makeCtx(withFlag()), onMain(withFlag())]) {
      for (const command of forms) {
        const verdict = classify(command, ctx);
        expect(verdict.decision, command).toBe('block');
        expect(verdict.rule, command).toBe('2');
        expect(verdict.reason, command).toMatch(/shell expansion/);
      }
    }

    // The git spellings keep blocking: the substitution is one unreadable
    // refspec word now, where it used to be a `$` word and a second segment.
    for (const command of [
      'git push origin $(get_branch)',
      'git merge $(get_branch)',
      'gh pr merge $(prnum)',
    ]) {
      const verdict = classify(command, onMain(withFlag()));
      expect(verdict.decision, command).toBe('block');
      expect(verdict.rule, command).toBe('2');
      expect(verdict.reason, command).toMatch(/shell expansion/);
    }

    // A `(` with no `$` in front is still a subshell, so it still cuts
    // segments and the push inside it is classified on its own terms.
    const subshell = makeCtx();
    expectAllow('(cd sub && git push origin feat/x)', subshell);
    expectUntouched(subshell);
    expect(expectBlock('(cd sub && git push origin main)', onMain(withFlag())).rule).toBe('2');

    // Controls: a substitution on a line with no candidate is not the gate's
    // business, and reading it as a word must not make it one.
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
    // Unquoted, `$(` / a backtick is read as part of the word and its body is
    // tokenized onto the line (M26). Inside double quotes the tokenizer used
    // to only flip the word's expansion bit and never read the body, so
    // `echo "$(git push origin main)"` had no candidate at all and was
    // allowed outright. The shell still runs the substitution and the quotes
    // stay open around it, so this must behave exactly like the unquoted form.
    const forms = [
      'echo "$(git push origin main)"',
      'OUT="$(gh pr merge 3)"',
      'echo "`git push origin main`"',
    ];
    for (const ctx of [makeCtx(withFlag()), onMain(withFlag())]) {
      for (const command of forms) {
        const verdict = classify(command, ctx);
        expect(verdict.decision, command).toBe('block');
        expect(verdict.rule, command).toBe('2');
        expect(verdict.reason, command).toMatch(/shell expansion/);
      }
    }

    // On main with no flag, the body's own `git push origin main` segment is
    // a rule-1/rule-3 candidate on its own terms, independent of expansion.
    expectBlock('MSG="$(git push origin main 2>&1)"', onMain());

    // The line holds an expansion word (the outer assignment) and, separately,
    // a `git merge feat` candidate from the body: rule 2's expansion check
    // runs over the whole LINE, so the flag exempts nothing even though the
    // candidate segment itself has no expansion in it.
    expect(expectBlock('X="$(git merge feat)"', onMain(withFlag())).rule).toBe('2');

    // Regressions: these must keep allowing exactly as before this fix.
    for (const command of [
      // A quoted substitution with no candidate on the line is still nobody's
      // business, and ctx must stay unresolved.
      'VERSION="$(node -p \'require("./package.json").version\')" npm publish',
      'echo "$(date)" && git push origin feat/x',
    ]) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }
    // `\$` is an escaped, literal `$`: the `(...)` that follows it is just
    // text, never reaches scanSubstitution, and stays out of the word's
    // expansion flag - existing behaviour, unchanged by this fix.
    const escaped = makeCtx();
    expectAllow('echo "\\$(git push origin main)"', escaped);
    expectUntouched(escaped);
  });

  it('M28 reads a double-quoted command substitution across newlines, as the shell reads it', () => {
    // `scanSubstitution` used to cut off at the first `\n` no matter the
    // quoting. Unquoted that is harmless - the shell itself stops there too,
    // and the next line is classified on its own anyway (M26/M27) - but a
    // double-quoted substitution keeps running across the line break, so
    // cutting there dropped every continuation line from the gate: none of
    // these forms held a candidate on the line that spelled them, and all of
    // them were allowed outright.
    const forms = [
      'LOG="$(cd repo &&\n  git push origin main)"',
      'MSG="$(\n git push origin main\n)"',
      'MSG="`\ngit push origin main\n`"',
      'echo "$(date\ngit push origin main)"',
      // Already blocked before this fix (the candidate was on the first
      // line); confirms the cross-line body it now reads does not regress it.
      'RESULT="$(git push origin main 2>&1 |\n tail -1)"',
    ];
    for (const ctx of [makeCtx(withFlag()), onMain(withFlag())]) {
      for (const command of forms) {
        const verdict = classify(command, ctx);
        expect(verdict.decision, command).toBe('block');
        expect(verdict.rule, command).toBe('2');
      }
    }

    // Regressions: these must keep behaving exactly as before this fix.
    for (const command of [
      // Unquoted, an unterminated substitution still stops at the end of the
      // line instead of swallowing the next one the way a double-quoted one
      // does, so the second line is classified on its own and has no
      // candidate (a feature-branch push).
      'echo $(\ngit push origin feat/x',
      // A quoted substitution with no candidate on the line is still
      // nobody's business.
      'VERSION="$(node -p \'require("./package.json").version\')" npm publish',
      // The newline here sits after the substitution has already closed, so
      // it is plain text inside the double-quoted string, not part of the
      // substitution body - the whole thing is one word and holds no
      // candidate (security review R26, confirmed unchanged by this fix).
      'echo "$(date)\ngit push origin main"',
      'echo "a\nb" && git push origin feat/x',
    ]) {
      const ctx = makeCtx();
      expectAllow(command, ctx);
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
    expectAllow('git branch -f tmp abc\ngit pull', onMain());

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

  it('S35 refuses more than 256 git/gh invocations and stays linear under it', () => {
    // A6: `git` words used to each copy the rest of the segment (O(W^2)); a
    // 60 KB line of them made the hook time out, which reads as "allowed".
    // M13: the candidate scans that remain are O(invocations x words) - the
    // push tail walk, the refspec bookkeeping, the git/gh option scans - so the
    // invocation count is capped as the second half of the classification
    // budget. Without the cap these five shapes cost 0.3-0.7 s and up to
    // ~700 MB each, and an OOM prints nothing, which reads as "allowed".
    const started = Date.now();
    for (const command of [
      'git '.repeat(15000), // ~60 KB, just under the byte budget.
      'git push main '.repeat(4608),
      'git push o main '.repeat(4062),
      'git -c '.repeat(9216),
      'gh -R '.repeat(9000),
      'git push '.repeat(7000),
    ]) {
      const ctx = onMain(withFlag());
      const verdict = classify(command, ctx);
      const label = command.slice(0, 16);
      expect(verdict.decision, label).toBe('block');
      expect(verdict.rule, label).toBe('2');
      expect(verdict.reason, label).toMatch(/Too many git\/gh invocations/);
      expectUntouched(ctx); // The budget answers before any candidate is found.
    }
    // Redirection scanning is per operator, not per tail, and holds no
    // invocation at all.
    const ctx = makeCtx();
    expectAllow('> a '.repeat(15000), ctx);
    expectUntouched(ctx);

    // M1: under the cap the line is classified as before - `git push` repeated
    // used to re-slice and re-walk the rest of the segment (12 s and ~2 GB at
    // 63 KB). Only the trailing push has no refspec, so it is the candidate.
    expect(expectBlock('git push '.repeat(256), onMain()).rule).toBe('3');
    // Exactly at the cap the command is still classified on its merits: 257
    // invocations would answer with the budget reason instead.
    const atCap = expectBlock('git push '.repeat(255) + 'git push origin main', onMain());
    expect(atCap.reason).toMatch(/one gated operation/);
    expect(classify('git push '.repeat(256) + 'git push origin main', onMain()).reason)
      .toMatch(/Too many git\/gh invocations/);
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

    // Out of scope by threat model: deliberate evasion. Spelling the command or
    // subcommand word with an expansion leaves the classifier no candidate to
    // find, and it is allowed by design rather than papered over - a hand that
    // writes `pus{h..h}` is not the accidental push this gate exists for. If
    // one of these ever does harm it gets its own fix; until then the header
    // lists them among the forms nothing here can see through.
    for (const command of [
      'git pus{h..h} origin main',
      'gi{t..t} push origin main',
      'gh pr me{r..r}ge 1',
    ]) {
      const ctx = onMain(withFlag());
      expectAllow(command, ctx);
      expectUntouched(ctx);
    }

    // What the rule still catches: an unreadable refspec on a line that IS a
    // candidate. `$BR` could spell `main`, so rule 2 blocks ahead of the flag.
    const blocked = expectBlock('git push origin $BR', onMain(withFlag()));
    expect(blocked.rule).toBe('2');
    expect(blocked.reason).toMatch(/expansion/i);

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

    // M26: `$(` ... `)` and a backtick pair belong to the WORD, so the
    // endpoint stays in one piece and carries the expansion flag; the body is
    // tokenized too and its segments join the same line.
    const subst = tokenizeLines('gh api -X PUT repos/o/r/pulls/$(gh pr view -q .number)/merge');
    expect(subst[0].segments[0].words).toEqual([
      'gh', 'api', '-X', 'PUT', 'repos/o/r/pulls/$(gh pr view -q .number)/merge',
    ]);
    expect(subst[0].segments[0].expand[4]).toBe(true);
    expect(subst[0].segments[1].words).toEqual(['gh', 'pr', 'view', '-q', '.number']);

    // Whitespace, `;` and quoting inside a substitution cut neither the word
    // nor the segment (the `)` inside the quoted argument does not close it);
    // an unquoted `(` with no `$` in front is still a subshell separator.
    const nested = tokenizeLines('A=$(node -p \'require("./p.json").v; x\') B=`id -u` (cd s && ls)');
    expect(nested[0].segments[0].words).toEqual([
      'A=$(node -p \'require("./p.json").v; x\')', 'B=`id -u`',
    ]);
    expect(nested[0].segments[0].expand).toEqual([true, true]);
    expect(nested[0].segments.some((s) => s.words.join(' ') === 'cd s')).toBe(true);

    // An unterminated `$(` swallows the rest of the LINE, so the word keeps
    // its expansion flag instead of losing it at the line break.
    const open = tokenizeLines('git merge $(get_branch\ngit status');
    expect(open).toHaveLength(2);
    expect(open[0].segments[0].words).toEqual(['git', 'merge', '$(get_branch']);
    expect(open[0].segments[0].expand[2]).toBe(true);

    // M27: a substitution inside double quotes is read the same way - the
    // word keeps the substitution text (quotes stripped, substitution kept)
    // and its body joins the line as its own segment.
    const dq = tokenizeLines('echo "$(git push origin main)"');
    expect(dq[0].segments[0].words).toEqual(['echo', '$(git push origin main)']);
    expect(dq[0].segments[0].expand[1]).toBe(true);
    expect(dq[0].segments[1].words).toEqual(['git', 'push', 'origin', 'main']);

    const dqBacktick = tokenizeLines('echo "`git push origin main`"');
    expect(dqBacktick[0].segments[0].words).toEqual(['echo', '`git push origin main`']);
    expect(dqBacktick[0].segments[1].words).toEqual(['git', 'push', 'origin', 'main']);

    // An inner `"` pair belongs to the substitution (`scanSubstitution`
    // tracks its own quoting), so it does not close the outer double quote.
    const dqNested = tokenizeLines('echo "$(echo "x")"');
    expect(dqNested[0].segments[0].words).toEqual(['echo', '$(echo "x")']);
    expect(dqNested[0].segments[1].words).toEqual(['echo', 'x']);

    // `\$` stays an escaped, literal `$`: the `(...)` after it never reaches
    // scanSubstitution and carries no expansion flag (existing behaviour).
    const dqEscaped = tokenizeLines('echo "\\$(git push origin main)"');
    expect(dqEscaped[0].segments).toHaveLength(1);
    expect(dqEscaped[0].segments[0].words).toEqual(['echo', '$(git push origin main)']);
    expect(dqEscaped[0].segments[0].expand[1]).toBe(false);

    // M28: a double-quoted substitution is read across newlines, as the
    // shell reads it - the word keeps the raw text, newlines included, and
    // its body (also spanning the newlines) still joins the same line.
    const dqCross = tokenizeLines('MSG="$(\n git push origin main\n)"');
    expect(dqCross).toHaveLength(1);
    expect(dqCross[0].segments[0].words).toEqual(['MSG=$(\n git push origin main\n)']);
    expect(dqCross[0].segments[0].expand[0]).toBe(true);
    expect(dqCross[0].segments[1].words).toEqual(['git', 'push', 'origin', 'main']);

    const dqCrossBacktick = tokenizeLines('MSG="`\ngit push origin main\n`"');
    expect(dqCrossBacktick).toHaveLength(1);
    expect(dqCrossBacktick[0].segments[0].words).toEqual(['MSG=`\ngit push origin main\n`']);
    expect(dqCrossBacktick[0].segments[1].words).toEqual(['git', 'push', 'origin', 'main']);

    // Unquoted, an unterminated substitution still stops at the end of the
    // line instead of swallowing the next one - unchanged by this fix - so
    // the second line is classified on its own.
    const unquotedCross = tokenizeLines('echo $(\ngit push origin feat/x');
    expect(unquotedCross).toHaveLength(2);
    expect(unquotedCross[0].segments[0].words).toEqual(['echo', '$(']);
    expect(unquotedCross[1].segments[0].words).toEqual(['git', 'push', 'origin', 'feat/x']);
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
  const world = ({ otherFlag = false, repoFlag = true } = {}) => {
    const otherCtx = stub({
      ...repoState({ head: OTHER_SHA, flag: otherFlag ? { commit: OTHER_SHA } : null }),
      cwd: other,
      toplevel: other,
    });
    const repoValues = repoState(repoFlag ? {} : { flag: null });
    const at = vi.fn((dir) => {
      if (within(dir, other)) return otherCtx;
      if (within(dir, repo)) return stub({ ...repoValues, cwd: dir, toplevel: repo });
      return stub({ cwd: dir, toplevel: null, branch: null });
    });
    const ctx = stub({ ...repoValues, cwd: repo, toplevel: repo, at });
    return { ctx, otherCtx, at };
  };

  // ---- the attack forms: allowed before the fix -----------------------

  it('does not let a move on an earlier line borrow the current repository flag', () => {
    // Acceptance criterion 1: the current repository has a flag on HEAD,
    // `../other` has none, so the push into `../other` must not pass.
    for (const command of [
      'cd ../other\ngit push origin main',
      'cd ../other\r\ngit push origin main',
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

  it('blocks an expanded -C value under the expansion item, before any location', () => {
    const verdict = classify('git -C$X push origin main', world({ otherFlag: true }).ctx);
    expect(verdict).toMatchObject({ decision: 'block', rule: '2' });
    expect(verdict.reason).toMatch(/expansion/);
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

  it('reads a lone CR as a line break, as PowerShell does', () => {
    for (const command of ['cd ../other\rgit push origin main', 'git status # note\rcd ../other\rgit push origin main']) {
      expect(classify(command, world().ctx), JSON.stringify(command)).toMatchObject({ decision: 'block', rule: '3' });
    }
    expect(tokenizeLines('a\rb\r\nc')).toHaveLength(3);
  });

  it('does not place a move that one shell would not run (heredoc, block comment)', () => {
    // The current repository has no flag, `../other` has one: placing the
    // move in the text would borrow `../other`'s flag for a push that runs here.
    for (const command of [
      'cat <<EOF\ncd ../other\nEOF\ngit push origin main',
      "cat <<'X' > notes.txt\ncd ../other\nX\ngit push origin main",
      '<#\ncd ../other\n#>\ngit push origin main',
    ]) {
      expect(classify(command, world({ repoFlag: false, otherFlag: true }).ctx), command)
        .toMatchObject({ decision: 'block', rule: '2' });
    }
    // Text after a closing block-comment marker still runs in PowerShell.
    expect(classify('<# note #> git push origin main', world({ repoFlag: false }).ctx))
      .toMatchObject({ decision: 'block', rule: '3' });
  });

  it('treats a move word outside plain command position as a move it cannot place', () => {
    // Cycle-2 review of PR #173: the walk only read a move word at the start of
    // a segment, so a move the shell does run - inside a block, a pipeline, an
    // assignment, behind `.` / `&` - was ignored and the push was judged with
    // the CURRENT repository's flag. A move word anywhere else now makes every
    // later location unresolved (a false denial only costs a rephrase).
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
      // Words the shell never runs as a move are over-detected the same way.
      'grep -rn cd src',
      'echo cd &&',
      'git log --grep pushd',
    ]) {
      const command = `${prefix}\ngit push origin main`;
      expect(classify(command, world().ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('does not place anything in a command that runs text it cannot read', () => {
    // eval / Invoke-Expression, a function definition, and `&` / `.` on an
    // expression or a script block can run a move the text does not show.
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
      const command = `${prefix}\ngit push origin main`;
      expect(classify(command, world().ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('does not follow a move after a comment line or a block count it lost', () => {
    // `#>` at the start of a line is a comment to both shells; `echo }` closes
    // no block, so the `cd` after it is still inside the `if`.
    for (const command of [
      '#> cd ../other\ngit push origin main',
      'if false; then\necho }\ncd ../other\nfi\ngit push origin main',
    ]) {
      expect(classify(command, world({ repoFlag: false, otherFlag: true }).ctx), command)
        .toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('judges both directories when a move is followed by ||', () => {
    // The right-hand side runs only when the move FAILED, i.e. in the old
    // directory - which has no flag here.
    const verdict = classify('cd ../other || git push origin main', world({ repoFlag: false, otherFlag: true }).ctx);
    expect(verdict).toMatchObject({ decision: 'block', rule: '3' });
    expectAllowed('cd ../other || git push origin main', world({ otherFlag: true }).ctx);
  });

  it('does not trust a command whose quotes the two shells close differently', () => {
    // PowerShell closes the string at the second quote and runs the push; a
    // POSIX shell reads an escaped quote and never closes it.
    for (const command of ['Write-Host "C:\\tmp\\"; git push origin main', "echo 'x\ngit push origin main"]) {
      expect(classify(command, world().ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
    expectAllowed('echo "unterminated', world().ctx);
  });

  it.runIf(process.platform === 'win32')('[win32] does not place a drive-relative path for a POSIX shell', () => {
    // Git Bash reads `C:../other` as `C:/../other`, not as `../other`.
    const command = `cd ${repo[0]}:../other\ngit push origin main`;
    expect(classify(command, world({ repoFlag: false, otherFlag: true }).ctx)).toMatchObject({ decision: 'block', rule: '2' });
  });

  it('lets the trunk sync through only as the whole command, and only for the remote-tracking ref', () => {
    const noFlag = { repoFlag: false };
    for (const command of [
      'git remote set-url origin ../other\ngit fetch\ngit merge origin/main',
      'git config remote.origin.url ../other && git fetch && git merge origin/main',
      'git remote add o2 ../other; git fetch origin main; git merge origin/main',
      'git fetch\ngit merge origin/main\ngit status',
      'git fetch > out.txt\ngit merge origin/main',
      'git fetch "origin"\ngit merge origin/main',
    ]) {
      expect(classify(command, world(noFlag).ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
    // A local tag or branch named origin/main is what git would merge.
    for (const fullRef of [() => 'refs/tags/origin/main', () => 'refs/heads/origin/main', () => null]) {
      const { at } = world(noFlag);
      const ctx = stub({ ...repoState({ flag: null, fullRef }), cwd: repo, toplevel: repo, at });
      expect(classify('git fetch\ngit merge origin/main', ctx)).toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('follows a move inside a pure && chain, and not past its end', () => {
    expect(classify('npm test && cd ../other && git push origin main', world().ctx))
      .toMatchObject({ decision: 'block', rule: '3' });
    expectAllowed('npm test && cd ../other && git push origin main', world({ otherFlag: true }).ctx);
    expectAllowed('cd ../other && cd ../repo\ngit push origin main', world().ctx);
    for (const command of ['npm test && cd ../other\ngit push origin main', 'true || cd ../other && git push origin main']) {
      expect(classify(command, world({ otherFlag: true }).ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('keeps an if / try block without a move from unresolving the command', () => {
    for (const command of [
      'cd sub; git push origin main\nif ($LASTEXITCODE -eq 0) { Write-Output ok }',
      'if ($LASTEXITCODE -eq 0) { Write-Output ok }\ncd sub\ngit push origin main',
      'try { npm test } catch { exit 1 }\ncd sub\ngit push origin main',
      'if [ -f x ]; then echo y; fi\ncd sub\ngit push origin main',
    ]) {
      expectAllowed(command, world().ctx);
    }
    for (const command of [
      'if ($x) { cd ../other }\ngit push origin main',
      'if ($x) {\ncd ../other\n}\ngit push origin main',
      'cd sub\n$f = { git push origin main }',
      '1..2 | ForEach-Object { git push origin main; cd ../other }',
    ]) {
      expect(classify(command, world({ otherFlag: true }).ctx), command).toMatchObject({ decision: 'block', rule: '2' });
    }
  });

  it('reads a backslash path both ways and judges every place it can land', () => {
    // PowerShell keeps `\` (`..\other`); a POSIX shell eats it (`..other`,
    // which does not exist): `-C` then does nothing there, and `cd` /
    // `Set-Location` leave the directory where it was.
    expectAllowed('git -C ..\\other push origin main', world({ repoFlag: false, otherFlag: true }).ctx);
    expect(classify('git -C ..\\other push origin main', world().ctx)).toMatchObject({ decision: 'block', rule: '3' });
    for (const command of ['Set-Location ..\\other; git push origin main', 'cd ..\\other\ngit push origin main']) {
      expectAllowed(command, world({ otherFlag: true }).ctx);
      expect(classify(command, world({ repoFlag: false, otherFlag: true }).ctx), command).toMatchObject({ decision: 'block' });
      expect(classify(command, world().ctx), command).toMatchObject({ decision: 'block', rule: '3' });
    }
  });

  it.runIf(process.platform === 'win32')('[win32] maps an MSYS /c/… path and rejects a drive-less one', () => {
    const msys = `/${other[0].toLowerCase()}/${other.slice(3).replace(/\\/g, '/')}`;
    expectAllowed(`cd ${msys}\ngit push origin main`, world({ otherFlag: true }).ctx);
    expect(classify(`cd ${msys}\ngit push origin main`, world().ctx)).toMatchObject({ decision: 'block', rule: '3' });
    expect(classify('cd /tmp\ngit push origin main', world({ otherFlag: true }).ctx)).toMatchObject({ decision: 'block', rule: '2' });
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
      for (const command of ['cd //host/share\ngit push origin main', 'git -C \\\\host\\share push origin main', 'Set-Location \\\\host\\share; git push origin main']) {
        const verdict = classify(command, world({ otherFlag: true }).ctx);
        expect(verdict.decision, command).toBe('block');
      }
      for (const spy of spies.slice(1)) for (const [p] of spy.mock.calls) seen.push(String(p));
      expect(seen.filter((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('keeps an empty quoted argument, as the shell does', () => {
    expect(classify("git -C '' -C ../other push origin main", world().ctx)).toMatchObject({ decision: 'block', rule: '3' });
    expectAllowed("git -C '' push origin main", world().ctx);
    expect(tokenizeLines("echo '' \"\" x")[0].segments[0].words).toEqual(['echo', '', '', 'x']);
  });

  it('reads PowerShell environment drive and .NET assignments of GIT_*', () => {
    for (const command of [
      'Set-Item Env:GIT_DIR ../other/.git\ngit push origin main',
      'Set-Item -Path Env:\\GIT_WORK_TREE -Value x\ngit push origin main',
      "[Environment]::SetEnvironmentVariable('GIT_DIR', '../other/.git')\ngit push origin main",
    ]) {
      expect(classify(command, world({ otherFlag: true }).ctx), command).toMatchObject({ decision: 'block', rule: '2' });
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

  const expectAllowed = (command, ctx) => {
    const verdict = classify(command, ctx);
    expect(verdict, `${command} must be allowed (got ${verdict.reason})`).toMatchObject({ decision: 'allow' });
  };
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
