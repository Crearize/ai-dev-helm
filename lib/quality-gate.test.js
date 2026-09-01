const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { PACKAGE_ROOT } = require('./utils');

// Lives in its own file (not inside init.test.js) so vitest can run it on a
// separate worker: every test here spawns real git repos and node child
// processes, and the suite dominated init.test.js's wall time.
describe('quality-gate hook', () => {
  const hookScript = path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs');
  const FLAG = '.quality-check-passed';

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const runHookIn = (cwd, payload) =>
    execFileSync('node', [hookScript], {
      cwd,
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
    });

  const runHook = (payload) => runHookIn(tmpDir, payload);

  // Turn tmpDir into a git repo with an origin/main tracking ref.
  // `-c core.autocrlf=false` keeps blob bytes exactly as written so the
  // CRLF / encoding cases below assert on what the test actually authored.
  const initRepo = () => {
    const g = (...args) =>
      execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
        cwd: tmpDir,
        encoding: 'utf8',
      }).trim();
    g('init', '-b', 'main');
    g('config', 'core.autocrlf', 'false');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log(1);\n');
    g('add', '.');
    g('commit', '-m', 'init');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return g;
  };

  const writeFlag = (commit, branch = 'feat/x') =>
    fs.writeFileSync(
      path.join(tmpDir, FLAG),
      JSON.stringify({ branch, commit }) + '\n'
    );

  // `g('add', file)` on purpose: `git add .` would sweep the untracked
  // .quality-check-passed written by writeFlag into the commit and break
  // the harness-only diff assertions.
  // `-f`: a developer's global gitignore (e.g. `**/.claude/settings.local.json`)
  // must not turn a fixture add into a silent skip.
  const commitFile = (g, file, content, msg) => {
    const abs = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    g('add', '-f', file);
    g('commit', '-m', msg);
    return g('rev-parse', 'HEAD');
  };

  // Commit `content` on main and advance origin/main, so a following branch
  // diffs against a base that already contains the file.
  const seedMain = (g, file, content, msg = 'seed') => {
    const sha = commitFile(g, file, content, msg);
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return sha;
  };

  const expectBlock = (command, label = command) => {
    const out = runHook({ tool_input: { command } });
    expect(out, `${label} must not be exempt`).not.toBe('');
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe('block');
    return parsed;
  };

  it('always allows push to a feature branch without a flag', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    expect(runHook({ tool_input: { command: 'git push origin feat/x' } })).toBe('');
    expect(runHook({ tool_input: { command: 'git push -u origin feat/x' } })).toBe('');
  });

  it('detects gated commands in chained and -C forms', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    for (const command of [
      'cd sub && git push origin main',
      'git -C . push origin main',
      'echo done; gh pr merge 12',
    ]) {
      const out = JSON.parse(runHook({ tool_input: { command } }));
      expect(out.decision).toBe('block');
    }
  });

  it('gates force refspecs like +main', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    const out = JSON.parse(runHook({ tool_input: { command: 'git push origin +main' } }));
    expect(out.decision).toBe('block');
  });

  it('does not gate merge-control flags on main', () => {
    initRepo(); // on main
    expect(runHook({ tool_input: { command: 'git merge --abort' } })).toBe('');
    expect(runHook({ tool_input: { command: 'git merge --continue' } })).toBe('');
  });

  it('does not gate pushes whose refspec merely contains "main" as substring', () => {
    const g = initRepo();
    g('checkout', '-b', 'feature/main-menu');
    commitFile(g, 'code.js', 'x\n', 'code');

    expect(
      runHook({ tool_input: { command: 'git push origin feature/main-menu' } })
    ).toBe('');
  });

  it('blocks gh pr merge without a flag when the branch has code changes', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    const out = expectBlock('gh pr merge 12 --squash');
    expect(out.reason).toContain('Quality check not passed');
  });

  it('blocks push targeting main without a flag', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    expectBlock('git push origin main');
  });

  it('blocks git merge on main without a flag, allows it on a feature branch', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    // Merges on a feature branch (e.g. pulling in origin/main) are not gated.
    expect(runHook({ tool_input: { command: 'git merge origin/main' } })).toBe('');

    g('checkout', 'main');
    expectBlock('git merge feat/x');
  });

  it('allows a gated command with a valid flag and does NOT delete the flag', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const head = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head);

    expect(runHook({ tool_input: { command: 'gh pr merge 12' } })).toBe('');
    expect(fs.existsSync(path.join(tmpDir, FLAG))).toBe(true);
  });

  // The follow-up files are deliberately NON-control-plane harness files:
  // this is the guarantee that self-improvement edits never force a
  // re-review. Gate control-plane files are exactly the class the flag must
  // NOT stay valid across — see the carve-out section below.
  it('keeps the flag valid across harness-only follow-up commits', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const head = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head);
    commitFile(g, 'CLAUDE.md', '# rules\n', 'harness');
    commitFile(g, 'skills/project/branch-workflow/SKILL.md', '# skill\n', 'skill');

    expect(runHook({ tool_input: { command: 'gh pr merge 12' } })).toBe('');
  });

  it('blocks when non-harness code changed after the flag commit', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const head = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head);
    commitFile(g, 'code2.js', 'y\n', 'more code');

    const out = expectBlock('gh pr merge 12');
    expect(out.reason).toContain('Code changed');
  });

  it('blocks reuse of a stale flag from another branch', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/y');
    const staleTip = commitFile(g, 'lib-y.js', 'y\n', 'y code');
    writeFlag(staleTip, 'feat/y');
    g('checkout', 'main');
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'lib-x.js', 'x\n', 'x code');

    expectBlock('gh pr merge 13');
  });

  it('exempts a harness-only branch without any flag', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', '# rules\n', 'harness');
    commitFile(g, '.claude/settings.json', '{}\n', 'settings');

    expect(runHook({ tool_input: { command: 'gh pr merge 14' } })).toBe('');
  });

  it('does not exempt an empty diff', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/empty');

    expectBlock('gh pr merge 15');
  });

  it('treats a legacy empty flag file as invalid', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');
    fs.writeFileSync(path.join(tmpDir, FLAG), '');

    const out = expectBlock('gh pr merge 12');
    expect(out.reason).toContain('Quality check not passed');
  });

  it('allows pushing main after a gated local merge (ancestor rule)', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const checked = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(checked);
    g('checkout', 'main');
    g('merge', '--no-ff', 'feat/x', '-m', 'merge feat/x');

    expect(runHook({ tool_input: { command: 'git push origin main' } })).toBe('');
  });

  it('blocks gh pr merge on main when the PR head cannot be resolved', () => {
    initRepo(); // on main with no remote — gh pr view always fails here
    const out = expectBlock('gh pr merge 12');
    expect(out.reason).toContain('Cannot verify');
  });

  it('ignores unrelated commands', () => {
    for (const command of ['git status', 'npm test', 'echo "git pushover"', 'git pull']) {
      expect(runHook({ tool_input: { command } })).toBe('');
    }
  });

  it('fails open outside a git repo for git commands', () => {
    // tmpDir is intentionally NOT a git repo here
    expect(runHook({ tool_input: { command: 'git push' } })).toBe('');
    expect(runHook({ tool_input: { command: 'git merge feat/x' } })).toBe('');
  });

  it('does not block on malformed payloads', () => {
    expect(runHook('not json')).toBe('');
    expect(runHook({})).toBe('');
  });

  it('emits the current permissionDecision schema alongside the legacy decision', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    const out = expectBlock('git push origin main');
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: out.reason,
    });
  });

  it('blocks when any chained push segment targets main', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    expectBlock('git push origin feat/x && git push origin main');
  });

  it('allows chained pushes that only target feature branches', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    expect(
      runHook({ tool_input: { command: 'git push origin feat/x && git push origin feat/y' } })
    ).toBe('');
  });

  it('verifies HEAD, not the merge argument, when a feature-branch merge precedes a gated push', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const head = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(head);

    // Common idiom: sync with main, then push. HEAD is the checked commit,
    // so the chain must pass even though `git merge origin/main` appears
    // earlier in the command line.
    expect(
      runHook({ tool_input: { command: 'git merge origin/main && git push origin main' } })
    ).toBe('');
  });

  it('blocks a merge+push chain on main when the merged branch is unchecked', () => {
    const g = initRepo();
    const mainHead = g('rev-parse', 'HEAD');
    writeFlag(mainHead, 'main'); // an old check whose commit is already in main history
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'unchecked code');
    g('checkout', 'main');

    const out = expectBlock('git merge feat/x && git push origin main');
    expect(out.reason).toContain('Code changed');
  });

  it('allows a merge+push chain on main when the merged tip is the checked commit', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const checked = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(checked);
    g('checkout', 'main');

    expect(
      runHook({ tool_input: { command: 'git merge feat/x && git push origin main' } })
    ).toBe('');
  });

  // NOTE: これらのテストは廃止済みキー（mutation_threshold_* / mutation_mode_medium）を題材にしている。#90 の hook 後掃除で mutation_budget_minutes 題材へ差し替える（削除ではなく差し替え — カーブアウトの回帰テストを失わないこと）。
  // quality-policy.md §2「上書きの契約」: a harness config diff that changes a
  // gate parameter must go through quality-check, exemption or not.
  it.each(['CLAUDE.md', 'AGENTS.md', '.cursorrules'])(
    'does not exempt a harness-only diff that changes gate parameters in %s',
    (file) => {
      const g = initRepo();
      g('checkout', '-b', 'chore/harness');
      commitFile(
        g,
        file,
        '### Quality Gate Overrides\n- mutation_threshold_high: 60\n',
        'weaken gate'
      );

      const out = expectBlock('gh pr merge 20', file);
      expect(out.reason).toContain('Quality check not passed');
    }
  );

  // The fourth §2 key is string-valued (gate / advisory / off). Switching the
  // Medium mutation mode off weakens the gate as surely as lowering a
  // threshold, so it is carved out of the exemption the same way.
  it('does not exempt a harness-only diff that switches the Medium mutation mode', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_mode_medium: off\n',
      'switch medium mode off'
    );

    const out = expectBlock('gh pr merge 21', 'mutation_mode_medium');
    expect(out.reason).toContain('Quality check not passed');
  });

  // The realistic weakening for a string-valued key is a VALUE rewrite of an
  // already-declared line (advisory -> off). The hook compares whole
  // normalized declaration lines, so this must be caught exactly like a
  // numeric threshold change.
  it('does not exempt a harness-only diff that rewrites the declared Medium mode value', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_mode_medium: advisory\n',
      'declare advisory'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_mode_medium: off\n',
      'rewrite mode to off'
    );

    const out = expectBlock('gh pr merge 22', 'mutation_mode_medium value rewrite');
    expect(out.reason).toContain('Quality check not passed');
  });

  // Bypass repro: the extraction previously required the exact `key: value`
  // notation, so any other markdown rendering of the same key (bold,
  // backtick-quoted, or a table row) slipped through as "no change".
  it.each([
    ['bold', '### Quality Gate Overrides\n- **mutation_threshold_high**: 10\n'],
    ['backticked', '### Quality Gate Overrides\n- `mutation_threshold_high`: 10\n'],
    ['table row', '### Quality Gate Overrides\n| mutation_threshold_high | 10 |\n'],
  ])('does not exempt a gate-parameter change written as a %s', (_label, doc) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc, 'weaken gate via alternate notation');

    expectBlock('gh pr merge 28', _label);
  });

  it('keeps the harness-only exemption for a CLAUDE.md diff with no gate-parameter change', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', '# rules\n\n- prefer small diffs\n', 'harness');

    expect(runHook({ tool_input: { command: 'gh pr merge 21' } })).toBe('');
  });

  it('keeps the exemption when the override block is commented out', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n<!-- template — uncomment to override\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 80\n' +
        '- mutation_budget_minutes: 15\n-->\n',
      'harness template'
    );

    expect(runHook({ tool_input: { command: 'gh pr merge 22' } })).toBe('');
  });

  it('invalidates the flag when a follow-up commit changes a gate parameter', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');
    const checked = commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n',
      'gate params'
    );
    writeFlag(checked);
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 60\n',
      'weaken gate'
    );

    const out = expectBlock('gh pr merge 23');
    expect(out.reason).toContain('Code changed');
  });

  // Bypass repro: a literal `<!--` in prose must not make a live override
  // block below it read as commented out.
  it('does not exempt a live override hidden behind a decoy comment marker', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\na comment starts with the `<!--` marker.\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'decoy marker'
    );

    expectBlock('gh pr merge 25');
  });

  // Bypass repro: activating a pre-existing commented block by deleting only
  // the comment delimiters changes no `mutation_*` line at all.
  it('does not exempt a delimiter-only edit that activates a commented override', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '# rules\n\n<!--\n### Quality Gate Overrides\n' +
        '- mutation_threshold_high: 80\n-->\n',
      'harness template'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n### Quality Gate Overrides\n- mutation_threshold_high: 80\n',
      'uncomment overrides'
    );

    expectBlock('gh pr merge 26');
  });

  // A value edited inside a block that stays commented activates nothing, so
  // the exemption holds even in a large file where the delimiters are far
  // from the edited line.
  it('keeps the exemption when a value changes inside a still-commented block', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `- rule ${i}\n`).join('');
    const doc = (high) =>
      `# rules\n\n${filler}\n<!-- template - uncomment to override\n\n` +
      `### Quality Gate Overrides\n- mutation_threshold_high: ${high}\n` +
      `- mutation_budget_minutes: 15\n-->\n\n${filler}`;
    const g = initRepo();
    seedMain(g, 'CLAUDE.md', doc(80), 'harness template');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc(60), 'tweak commented default');

    expect(runHook({ tool_input: { command: 'gh pr merge 27' } })).toBe('');
  });

  // ---------------------------------------------------------------------
  // Reproduced bypasses (each must BLOCK).
  // Expected values derive from quality-policy.md §2「上書きの契約」: a diff that
  // changes what a harness config file *declares* as a gate parameter is
  // outside the harness-only exemption. "Declares" is a property of the
  // rendered document (fence / comment / section), not of the raw line text.
  // ---------------------------------------------------------------------

  // §2: a value listed under a "Rejected proposals" heading declares nothing;
  // the identical line under `### Quality Gate Overrides` declares an
  // override. Moving it is therefore a gate-parameter change even though no
  // line text changed — the old flat, sorted line set could not see it.
  it('does not exempt moving an unchanged override line into the overrides block', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '# rules\n\n### Rejected proposals\n\n- mutation_threshold_high: 10\n',
      'rejected proposal'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n### Quality Gate Overrides\n\n- mutation_threshold_high: 10\n',
      'promote proposal to an override'
    );

    expectBlock('gh pr merge 30');
  });

  // §2 renders the override block inside a fenced example, so fenced content
  // is illustrative, not a declaration. Unfencing it activates the override.
  it('does not exempt unfencing an override block', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '# rules\n\n```markdown\n### Quality Gate Overrides\n' +
        '- mutation_threshold_high: 10\n```\n',
      'documented example'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'unfence the example'
    );

    expectBlock('gh pr merge 31');
  });

  // A `<!--` inside a fence is literal text, so it cannot pair with a later
  // `-->` to comment out the live block between them.
  it('does not exempt a live override hidden behind a fenced comment-open decoy', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n```text\n<!--\n```\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 10\n\n' +
        '<!-- unrelated note -->\n',
      'fenced decoy'
    );

    expectBlock('gh pr merge 32');
  });

  // Whichever context opened first wins. A comment opens before the fence
  // marker on the next line, so that marker is literal text inside the
  // comment and cannot swallow the `-->` that ends it.
  it('does not exempt a live override hidden behind a fence marker inside a comment', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n<!-- note\n```\n-->\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'phantom fence inside a comment'
    );

    expectBlock('gh pr merge 44');
  });

  // Same trick with every delimiter paired, so an "unterminated at EOF"
  // check alone cannot catch it: only the first-opened-context rule can.
  it('does not exempt a live override hidden behind balanced phantom fences', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\n<!-- note\n```\n-->\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 10\n\n' +
        '<!-- end\n```\n-->\n',
      'balanced phantom fences'
    );

    expectBlock('gh pr merge 45');
  });

  // CommonMark does no inline processing inside an HTML block, so a
  // backtick-wrapped `-->` still closes an open comment. Treating it as a
  // protected code span kept the comment open over the live block below.
  it('does not exempt a live override after a code-span-wrapped comment close', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '<!-- start\n`-->`\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'code-span comment close'
    );

    expectBlock('gh pr merge 46');
  });

  // Setext headings are headings too: the same line moved under one goes
  // from declaring nothing to declaring an override.
  it('does not exempt moving an override line under a setext overrides heading', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '# rules\n\n### Rejected proposals\n\n- mutation_threshold_high: 10\n',
      'rejected proposal'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\nQuality Gate Overrides\n======================\n\n' +
        '- mutation_threshold_high: 10\n',
      'promote under a setext heading'
    );

    expectBlock('gh pr merge 47');
  });

  // An unterminated fence or comment makes everything after it unreadable,
  // and "unreadable" is not "declares nothing" — a single stray delimiter
  // would otherwise hide every later gate-parameter change forever.
  it.each([
    ['fence', '# rules\n\n```\n\n### Quality Gate Overrides\n- mutation_threshold_high: 10\n'],
    ['comment', '# rules\n\n<!-- note\n\n### Quality Gate Overrides\n- mutation_threshold_high: 10\n'],
  ])('does not exempt a document with an unterminated %s at EOF', (_label, doc) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc, 'stray delimiter');

    expectBlock('gh pr merge 48', _label);
  });

  // Reordering two DISTINCT keys declares exactly the same thing, so §2's
  // carve-out does not apply — only the effective value per key matters.
  it('keeps the exemption when two distinct gate-parameter lines are reordered', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n' +
        '- mutation_budget_minutes: 15\n',
      'overrides'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_budget_minutes: 15\n' +
        '- mutation_threshold_high: 80\n',
      'reorder distinct keys'
    );

    expect(runHook({ tool_input: { command: 'gh pr merge 49' } })).toBe('');
  });

  // Both delimiters sit inside inline code spans, so neither is a real
  // comment delimiter and the block between them stays live.
  it('does not exempt a live override wrapped in code-span comment delimiters', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '# rules\n\nan opener is written `<!--` in prose.\n\n' +
        '### Quality Gate Overrides\n- mutation_threshold_high: 10\n\n' +
        'and a closer is written `-->` in prose.\n',
      'code-span delimiters'
    );

    expectBlock('gh pr merge 33');
  });

  // §2's notation is `key: value`; markdown lets the value sit on the
  // following line and still render as the same declaration.
  it('does not exempt a gate-parameter change whose value is on the next line', () => {
    const doc = (high) =>
      `### Quality Gate Overrides\n\n- mutation_threshold_high:\n  ${high}\n`;
    const g = initRepo();
    seedMain(g, 'CLAUDE.md', doc(80), 'overrides');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc(10), 'weaken via continuation line');

    expectBlock('gh pr merge 34');
  });

  // §2 names the keys; markdown prose renders them with varying case and
  // separators. A key the reader recognises is a declaration regardless.
  it.each([
    ['case variant', '### Quality Gate Overrides\n- Mutation_Threshold_High: 10\n'],
    ['hyphen variant', '### Quality Gate Overrides\n- mutation-threshold-high: 10\n'],
    ['spaced variant', '### Quality Gate Overrides\n- Mutation Threshold High: 10\n'],
  ])('does not exempt a gate parameter declared as a %s', (_label, doc) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc, 'weaken gate via key spelling');

    expectBlock('gh pr merge 35', _label);
  });

  // With a duplicate key the last declaration wins in any reader, so
  // swapping the two lines changes the effective threshold from 80 to 10.
  it('does not exempt swapping two duplicate gate-parameter lines', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n' +
        '- mutation_threshold_high: 80\n',
      'duplicate keys'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n' +
        '- mutation_threshold_high: 10\n',
      'swap duplicate keys'
    );

    expectBlock('gh pr merge 36');
  });

  // quality-policy.md §2 forbids duplicate override keys in one file and
  // defines differing duplicates as indeterminate. Last-wins alone could not
  // see a weakened line INSERTED ABOVE the original — the unchanged line
  // stayed last, so the state was identical and the diff merged exempt.
  it.each([
    [
      'above',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n' +
        '- mutation_threshold_high: 80\n',
    ],
    [
      'below',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n' +
        '- mutation_threshold_high: 10\n',
    ],
  ])('does not exempt inserting a weakened duplicate key %s the original', (_label, doc) => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n',
      'single declaration'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc, 'insert a weakened duplicate');

    expectBlock('gh pr merge 50', _label);
  });

  // Duplicates that say the same thing are not the 「値が食い違う」 case §2
  // calls indeterminate: they declare exactly one value, so the state is the
  // same as the single-line form and the diff stays exempt.
  it('keeps the exemption when a duplicate key repeats an identical value', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n',
      'single declaration'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n' +
        '- mutation_threshold_high: 80\n',
      'repeat the same declaration'
    );

    expect(runHook({ tool_input: { command: 'gh pr merge 51' } })).toBe('');
  });

  // The hook's deadline only clamps child-process timeouts, so pure-JS work
  // is what actually decides whether a decision is emitted at all. A
  // backtick-stuffed line drove the code-span masker quadratic; the harness
  // then SIGTERM'd the hook before it printed anything, and a PreToolUse hook
  // that prints nothing lets the command through. Fail-OPEN, from a file the
  // size caps never rejected.
  it.each([
    // One ~200KB line: ~31s of masking on the quadratic implementation.
    ['a single oversized line', () => 'x' + '`'.repeat(200000) + '\n'],
    // 20 lines of 60KB each: every line is under any per-line cap, the file
    // is under MAX_BLOB_BYTES, and the total was ~57s.
    [
      'many lines under the per-line cap',
      () => Array.from({ length: 20 }, () => 'x' + '`'.repeat(60000) + '\n').join(''),
    ],
  ])('emits a decision promptly for %s of backticks', (_label, build) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n\n' + build(),
      'backtick-stuffed harness doc'
    );

    const started = Date.now();
    const out = runHook({ tool_input: { command: 'gh pr merge 52' } });
    const elapsed = Date.now() - started;

    // A decision — never silence, which the harness reads as "allowed".
    expect(out, `${_label} must not fail open`).not.toBe('');
    expect(JSON.parse(out).decision).toBe('block');
    expect(elapsed, `${_label} took ${elapsed}ms`).toBeLessThan(10000);
  });

  // A directory whose literal name contains `%OS%`: the old shell-string
  // `git show <rev>:"docs%OS%x/CLAUDE.md"` had cmd.exe expand `%OS%` inside
  // the double quotes, the read failed, and the failure was misread as
  // "the file is absent, so it declares nothing" — fail-open.
  it('does not exempt a gate-parameter change under a path containing %OS%', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'docs%OS%x/CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'weaken gate under an env-var-looking path'
    );

    expectBlock('gh pr merge 37');
  });

  // With `diff.relative` configured and the hook launched from a
  // subdirectory, git reported `CLAUDE.md` instead of `sub/CLAUDE.md`; the
  // read of the (nonexistent) root file then failed and was misread as
  // "declares nothing" on both sides. Git is now pinned to the repo root with
  // `diff.relative=false`, so §2's carve-out sees the real path.
  it('does not exempt a gate-parameter change when diff.relative is set and cwd is a subdirectory', () => {
    const g = initRepo();
    g('config', 'diff.relative', 'true');
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'sub/CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'weaken gate in a subdirectory'
    );

    const out = runHookIn(path.join(tmpDir, 'sub'), {
      tool_input: { command: 'gh pr merge 39' },
    });
    expect(out).not.toBe('');
    expect(JSON.parse(out).decision).toBe('block');
  });

  // A UTF-16LE file is a perfectly valid CLAUDE.md; reading its bytes as
  // UTF-8 made every key unmatchable, so the declaration went unseen.
  it('does not exempt a gate-parameter change in a UTF-16LE file', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    const abs = path.join(tmpDir, 'CLAUDE.md');
    const text = '### Quality Gate Overrides\r\n- mutation_threshold_high: 10\r\n';
    fs.writeFileSync(
      abs,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    );
    g('add', 'CLAUDE.md');
    g('commit', '-m', 'weaken gate in utf-16');

    expectBlock('gh pr merge 38');
  });

  // §2's carve-out is about what lands on main, so the direct-push path owes
  // the same check as the merge path: ancestry of the checked commit only
  // proves the check happened, not that nothing changed since.
  it.each([
    [
      'a gate-parameter change',
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
    ],
    ['arbitrary code', 'code2.js', 'console.log(2);\n'],
  ])(
    'blocks a direct push to main that commits %s after the flag',
    (_label, file, content) => {
      const g = initRepo();
      const checked = commitFile(g, 'code.js', 'x\n', 'checked code');
      writeFlag(checked, 'main');
      commitFile(g, file, content, 'post-check change on main');

      const out = expectBlock('git push origin main', _label);
      // The generic "before merging" wording is impossible advice once the
      // content is already on main, so this branch has its own message.
      expect(out.reason).toContain('main contains changes that were not part');
      expect(out.reason).toContain('Re-run the quality-check skill on the current main');
    }
  );

  it('allows a direct push to main whose post-flag commits are harness-only', () => {
    const g = initRepo();
    const checked = commitFile(g, 'code.js', 'x\n', 'checked code');
    writeFlag(checked, 'main');
    commitFile(g, 'CLAUDE.md', '# rules\n', 'harness note');

    expect(runHook({ tool_input: { command: 'git push origin main' } })).toBe('');
  });

  // ---------------------------------------------------------------------
  // False-block regressions (each must be EXEMPT).
  // ---------------------------------------------------------------------

  // §2 exempts harness-only diffs; file size is not a gate parameter, so a
  // large CLAUDE.md with no parameter change must stay exempt. The old 1MB
  // default maxBuffer turned it into an unreadable blob and a hard block.
  it('keeps the exemption for a CLAUDE.md larger than 1MB with no parameter change', () => {
    const filler = 'x'.repeat(64) + '\n';
    const doc = (tail) =>
      '# rules\n\n### Quality Gate Overrides\n- mutation_threshold_high: 80\n\n' +
      filler.repeat(20000) +
      tail;
    const g = initRepo();
    seedMain(g, 'CLAUDE.md', doc('- note a\n'), 'big harness doc');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', doc('- note b\n'), 'edit prose only');

    expect(runHook({ tool_input: { command: 'gh pr merge 40' } })).toBe('');
  });

  // §2 decides on declared parameters, not on how shell-quotable the path is.
  // With argv-based git calls the file is readable, so the pair below splits
  // the old blanket "unsafe path ⇒ block" into the two answers §2 gives.
  it('blocks a gate-parameter change under a path containing $', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'sub$dir/CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 10\n',
      'weaken gate under an odd path'
    );

    expectBlock('gh pr merge 41');
  });

  it('keeps the exemption for a $-containing path with no gate-parameter change', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'sub$dir/CLAUDE.md', '# rules\n', 'odd path, no overrides');

    expect(runHook({ tool_input: { command: 'gh pr merge 42' } })).toBe('');
  });

  // Line endings and trailing whitespace are not declarations.
  it('keeps the exemption across a CRLF and trailing-whitespace rewrite', () => {
    const g = initRepo();
    seedMain(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\n- mutation_threshold_high: 80\n- prose\n',
      'overrides lf'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      'CLAUDE.md',
      '### Quality Gate Overrides\r\n- mutation_threshold_high:  80  \r\n- prose\r\n',
      'rewrite with crlf'
    );

    expect(runHook({ tool_input: { command: 'gh pr merge 43' } })).toBe('');
  });

  // ---------------------------------------------------------------------
  // Gate control-plane carve-out.
  // Expected values derive from the 「Merge Gate」 carve-out in
  // templates/CLAUDE.md.template (quality policy §5.5, review consolidation):
  // the files that DEFINE the gate — the quality-check skill and its schemas
  // (canonical or copied under .claude/.codex/.cursor), the review persona
  // docs, the hooks directories, and the hook registration — must never ride
  // the harness-only exemption. With in-development reviews consolidated into
  // the merge gate, these must never change with ZERO review; editing or
  // unregistering the hook disables the gate as surely as weakening a
  // threshold does.
  // ---------------------------------------------------------------------

  const SETTINGS = '.claude/settings.json';

  const expectControlBlock = (command, label = command) => {
    const out = expectBlock(command, label);
    expect(out.reason, label).toContain('Gate control-plane changed:');
    return out;
  };

  // Bypass repro: every one of these paths sits inside HARNESS_PATTERNS, so
  // before the carve-out a diff made only of them merged with no review at
  // all — including a rewrite of the gate hook itself.
  it.each([
    ['canonical quality-check skill', 'skills/project/quality-check/SKILL.md'],
    ['copied quality-check skill', '.claude/skills/project/quality-check/SKILL.md'],
    ['cursor-copied quality-check skill', '.cursor/skills/project/quality-check/SKILL.md'],
    ['canonical schemas', 'skills/project/_schemas/quality-check-report.schema.md'],
    ['codex-copied schemas', '.codex/skills/project/_schemas/x.md'],
    ['claude hooks directory', '.claude/hooks/quality-gate.cjs'],
    ['codex hooks directory', '.codex/hooks/quality-gate.cjs'],
    ['cursor hooks directory', '.cursor/hooks/quality-gate.cjs'],
    ['codex hook registration', '.codex/hooks.json'],
    ['review persona doc', '.github/review-frontend.md'],
  ])('does not exempt a harness-only diff that touches the %s', (_label, file) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, file, '# edited\n', 'touch the gate control plane');

    const out = expectControlBlock('gh pr merge 60', _label);
    expect(out.reason, _label).toContain(file);
  });

  // Unregistering the hook disables the gate just as surely as editing it,
  // so the `hooks` block of settings.json is control plane — and only it.
  it('does not exempt a .claude/settings.json diff that changes the hooks block', () => {
    const g = initRepo();
    seedMain(
      g,
      SETTINGS,
      JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash' }] } }) + '\n',
      'settings with hooks'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      SETTINGS,
      JSON.stringify({ model: 'opus', hooks: {} }) + '\n',
      'unregister the gate hook'
    );

    const out = expectControlBlock('gh pr merge 61');
    expect(out.reason).toContain(SETTINGS);
  });

  it('keeps the exemption when .claude/settings.json changes a non-hooks key only', () => {
    const settings = (model) =>
      JSON.stringify({ model, hooks: { PreToolUse: [{ matcher: 'Bash' }] } }) + '\n';
    const g = initRepo();
    seedMain(g, SETTINGS, settings('opus'), 'settings with hooks');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, SETTINGS, settings('sonnet'), 'switch the default model');

    expect(runHook({ tool_input: { command: 'gh pr merge 62' } })).toBe('');
  });

  // One-sided presence: the file appears with a hooks block where there was
  // none (registration), or disappears taking one with it (unregistration).
  it('does not exempt a newly added .claude/settings.json carrying a hooks block', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      SETTINGS,
      JSON.stringify({ hooks: { PreToolUse: [] } }) + '\n',
      'register hooks'
    );

    expectControlBlock('gh pr merge 63');
  });

  it('does not exempt deleting a .claude/settings.json that carried a hooks block', () => {
    const g = initRepo();
    seedMain(
      g,
      SETTINGS,
      JSON.stringify({ hooks: { PreToolUse: [] } }) + '\n',
      'settings with hooks'
    );
    g('checkout', '-b', 'chore/harness');
    g('rm', SETTINGS);
    g('commit', '-m', 'drop settings entirely');

    expectControlBlock('gh pr merge 68');
  });

  // Fail closed: an unparsable settings.json on EITHER side leaves the hooks
  // block indeterminate, and "cannot tell" must never read as "unchanged".
  it.each([
    ['tip', '{"hooks":{}}\n', '{ not json\n'],
    ['base', '{ not json\n', '{"hooks":{}}\n'],
  ])(
    'does not exempt an unparsable .claude/settings.json on the %s side',
    (_label, baseDoc, tipDoc) => {
      const g = initRepo();
      seedMain(g, SETTINGS, baseDoc, 'settings');
      g('checkout', '-b', 'chore/harness');
      commitFile(g, SETTINGS, tipDoc, 'edit settings');

      expectControlBlock('gh pr merge 64', _label);
    }
  );

  it('does not exempt a mixed diff of a control-plane file and an ordinary harness file', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, 'CLAUDE.md', '# rules\n', 'harness note');
    commitFile(g, '.claude/hooks/quality-gate.cjs', '// edited\n', 'edit the gate hook');

    const out = expectControlBlock('gh pr merge 65');
    expect(out.reason).toContain('.claude/hooks/quality-gate.cjs');
  });

  // Regression guard: harness paths that are NOT control plane keep the
  // exemption — the carve-out must not swallow the whole harness.
  it('keeps the harness-only exemption for a diff with no control-plane files', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, '.claude/agents/reviewer.md', '# agent\n', 'agent doc');
    commitFile(g, 'skills/project/writing-test/SKILL.md', '# skill\n', 'unrelated skill');
    commitFile(g, 'documents/development/coding-rules/js.md', '# rules\n', 'coding rules');

    expect(runHook({ tool_input: { command: 'gh pr merge 66' } })).toBe('');
  });

  // The carve-out removes the EXEMPTION only. A control-plane change that
  // actually went through /quality-check still merges: the flag is issued AT
  // the control-plane commit, so the change is inside what the check covered.
  // Contrast with the post-flag tests below, where the control-plane change
  // lands AFTER the flag and is therefore unreviewed.
  it('allows a control-plane change covered by a valid quality-check flag', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/gate');
    const head = commitFile(
      g,
      '.claude/hooks/quality-gate.cjs',
      '// edited\n',
      'edit the gate hook'
    );
    writeFlag(head, 'chore/gate');

    expect(runHook({ tool_input: { command: 'gh pr merge 67' } })).toBe('');
  });

  // Bypass repro: the flag-stays-valid-across-harness-commits rule exists so
  // self-improvement edits never force a re-review. Gate control-plane edits
  // are exactly the class it must NOT cover — a post-flag hook rewrite rode
  // the harness-only staleness exemption and merged with zero review of a
  // gate-control change, defeating the carve-out's purpose.
  it('invalidates the flag when a follow-up commit touches the gate control plane', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const head = commitFile(g, 'code.js', 'x\n', 'checked code');
    writeFlag(head);
    commitFile(
      g,
      'skills/project/quality-check/SKILL.md',
      '# rewritten\n',
      'post-flag control-plane edit'
    );

    const out = expectControlBlock('gh pr merge 70');
    expect(out.reason).toContain('skills/project/quality-check/SKILL.md');
  });

  it('invalidates the flag when a follow-up commit changes the settings hooks block', () => {
    const settings = (timeout) =>
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', timeout }] } }) + '\n';
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, SETTINGS, settings(30), 'registered hooks');
    const head = commitFile(g, 'code.js', 'x\n', 'checked code');
    writeFlag(head);
    commitFile(g, SETTINGS, settings(1), 'post-flag hook re-registration');

    expectControlBlock('gh pr merge 71');
  });

  it('keeps the flag valid across a post-flag non-control-plane harness commit', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const head = commitFile(g, 'code.js', 'x\n', 'checked code');
    writeFlag(head);
    commitFile(g, '.claude/agents/reviewer.md', '# agent\n', 'harness note');

    expect(runHook({ tool_input: { command: 'gh pr merge 72' } })).toBe('');
  });

  // The direct-push-to-main path owes the same rule: ancestry of the checked
  // commit plus a harness-only post-flag diff used to be enough, so a
  // control-plane commit made after the flag pushed to main unreviewed.
  it('blocks a direct push to main with a post-flag control-plane commit', () => {
    const g = initRepo();
    const checked = commitFile(g, 'code.js', 'x\n', 'checked code');
    writeFlag(checked, 'main');
    commitFile(g, '.claude/hooks/quality-gate.cjs', '// edited\n', 'post-flag hook edit');

    const out = expectControlBlock('git push origin main');
    expect(out.reason).toContain('.claude/hooks/quality-gate.cjs');
  });

  // ---------------------------------------------------------------------
  // Reproduced gate bypasses (each must BLOCK). Merge-gate review findings:
  // the control-plane carve-out was defeatable four ways, three PoC-verified.
  // ---------------------------------------------------------------------

  const SETTINGS_LOCAL = '.claude/settings.local.json';

  // Finding 1 — case-insensitive filesystem bypass. On Windows/macOS these
  // are the SAME real files as the canonical spellings, yet the path-based
  // GATE_CONTROL_PATTERNS matched case-sensitively while HARNESS_PATTERNS
  // `/^\.claude\//` matched the first segment either way — so a case-variant
  // control-plane path rode the harness exemption with zero review.
  it.each([
    ['capital-H claude hooks dir', '.claude/Hooks/quality-gate.cjs'],
    ['capital-QC copied skill', '.claude/skills/project/Quality-Check/SKILL.md'],
    ['capital-H codex registration', '.codex/Hooks.json'],
  ])('does not exempt a case-variant control-plane path (%s)', (_label, file) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, file, '# edited\n', 'case-variant control-plane edit');

    const out = expectControlBlock('gh pr merge 80', _label);
    expect(out.reason, _label).toContain(file);
  });

  // Finding 1 — the settings file matched by exact string, so a case variant
  // slipped past the content-dependent settings check too.
  it('does not exempt a case-variant .claude/Settings.json hooks change', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      '.claude/Settings.json',
      JSON.stringify({ hooks: { PreToolUse: [] } }) + '\n',
      'register hooks via a case-variant settings path'
    );

    const out = expectControlBlock('gh pr merge 81');
    expect(out.reason).toContain('.claude/Settings.json');
  });

  // Finding 2 — Claude Code reads hooks from settings.local.json too, at
  // HIGHER precedence than settings.json. It matched HARNESS but neither the
  // path patterns nor the single settings constant, so a hooks change there
  // merged unreviewed.
  it('does not exempt a .claude/settings.local.json diff that changes the hooks block', () => {
    const g = initRepo();
    seedMain(
      g,
      SETTINGS_LOCAL,
      JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash' }] } }) + '\n',
      'local settings with hooks'
    );
    g('checkout', '-b', 'chore/harness');
    commitFile(
      g,
      SETTINGS_LOCAL,
      JSON.stringify({ model: 'opus', hooks: {} }) + '\n',
      'unregister the gate hook via local settings'
    );

    const out = expectControlBlock('gh pr merge 82');
    expect(out.reason).toContain(SETTINGS_LOCAL);
  });

  it('keeps the exemption when .claude/settings.local.json changes a non-hooks key only', () => {
    const settings = (model) =>
      JSON.stringify({ model, hooks: { PreToolUse: [{ matcher: 'Bash' }] } }) + '\n';
    const g = initRepo();
    seedMain(g, SETTINGS_LOCAL, settings('opus'), 'local settings with hooks');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, SETTINGS_LOCAL, settings('sonnet'), 'switch model in local settings');

    expect(runHook({ tool_input: { command: 'gh pr merge 83' } })).toBe('');
  });

  // Finding 3 — the disableAllHooks / allowManagedHooksOnly kill-switches turn
  // hooks off without touching the `hooks` block, which was the only compared
  // state. A byte-identical hooks block with the switch flipped was exempt.
  it.each([
    ['disableAllHooks', { disableAllHooks: true }],
    ['allowManagedHooksOnly', { allowManagedHooksOnly: true }],
  ])(
    'does not exempt a settings.json %s kill-switch with an unchanged hooks block',
    (_label, extra) => {
      const hooks = { PreToolUse: [{ matcher: 'Bash', timeout: 30 }] };
      const g = initRepo();
      seedMain(g, SETTINGS, JSON.stringify({ hooks }) + '\n', 'hooks registered');
      g('checkout', '-b', 'chore/harness');
      commitFile(
        g,
        SETTINGS,
        JSON.stringify({ ...extra, hooks }) + '\n',
        `${_label} without touching the hooks block`
      );

      const out = expectControlBlock('gh pr merge 84', _label);
      expect(out.reason).toContain(SETTINGS);
    }
  );

  // Finding 4 — `.claude/skills` is created as a symlink by init; re-pointing
  // the link node swaps the whole quality-check tree with a single-path diff
  // of `.claude/skills` (no trailing slash), which the trailing-slash-only
  // hooks pattern never matched.
  it('does not exempt re-pointing the .claude/skills symlink (single-path diff)', () => {
    const g = initRepo();
    // Stage a mode-120000 (symlink) entry without needing a real working-tree
    // symlink, so this reproduces on Windows without privilege too.
    const mkSymlink = (linkPath, target, msg) => {
      const tf = path.join(tmpDir, '.symlink-target');
      fs.writeFileSync(tf, target);
      const sha = g('hash-object', '-w', tf);
      fs.rmSync(tf);
      g('update-index', '--add', '--cacheinfo', `120000,${sha},${linkPath}`);
      g('commit', '-m', msg);
      return g('rev-parse', 'HEAD');
    };

    mkSymlink('.claude/skills', 'skills/project', 'add skills symlink');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('checkout', '-b', 'chore/harness');
    mkSymlink('.claude/skills', 'evil/tree', 're-point the skills symlink');

    const out = expectControlBlock('gh pr merge 85');
    expect(out.reason).toContain('.claude/skills');
  });

  // Regression: the carve-out removes the exemption, not the flag. A local
  // settings hooks change that actually went through /quality-check merges.
  it('allows a settings.local.json hooks change covered by a valid flag', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/gate');
    const head = commitFile(
      g,
      SETTINGS_LOCAL,
      JSON.stringify({ hooks: { PreToolUse: [] } }) + '\n',
      'register hooks locally'
    );
    writeFlag(head, 'chore/gate');

    expect(runHook({ tool_input: { command: 'gh pr merge 86' } })).toBe('');
  });

  // ---------------------------------------------------------------------
  // Reproduced command-detection bypasses (downstream gate reviews measured
  // real ALLOW results for each of these against the regex-based detection;
  // the tokenizer must BLOCK them all).
  // ---------------------------------------------------------------------
  it.each([
    ['double-quoted refspec', 'git push origin "main"'],
    ['single-quoted refspec', "git push origin 'main'"],
    ['quoted refs/heads refspec', 'git push origin "refs/heads/main"'],
    ['heads/-prefixed refspec', 'git push origin heads/main'],
    ['newline-separated command', 'echo sync\ngit push origin main'],
    ['backtick substitution', '`git push origin main`'],
    ['brace group', '{ git push origin main; }'],
    ['if/then prefix', 'if true; then git push origin main; fi'],
    ['env-assignment prefix', 'GIT_TRACE=1 git push origin main'],
    ['command builtin prefix', 'command git push origin main'],
    ['backslash-escaped word', 'git push origin ma\\in'],
    ['-c global option', 'git -c push.default=simple push origin main'],
    ['--no-pager global option', 'git --no-pager push origin main'],
    ['quoted -C value with a space', 'git -C "some dir" push origin main'],
    ['--repo option naming the remote', 'git push --repo=origin main'],
    ['--all push (main included)', 'git push --all origin'],
    ['--mirror push (main included)', 'git push --mirror origin'],
  ])('detects a push to main written with a %s', (_label, command) => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    expectBlock(command, _label);
  });

  it('still ignores near-miss commands after tokenization', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    commitFile(g, 'code.js', 'x\n', 'code');

    for (const command of [
      'git stash push -m "wip"', // push is a stash subcommand here
      'git push origin mainline', // substring, not main
      'echo "git push origin main"', // quoted: one word, not a command
    ]) {
      expect(runHook({ tool_input: { command } }), command).toBe('');
    }
  });

  it('resolves a quoted merge ref instead of failing closed on it', () => {
    const g = initRepo();
    g('checkout', '-b', 'feat/x');
    const checked = commitFile(g, 'code.js', 'x\n', 'code');
    writeFlag(checked);
    g('checkout', 'main');

    expect(
      runHook({ tool_input: { command: 'git merge "feat/x" && git push origin main' } })
    ).toBe('');
  });

  // Bypass repro: `git diff` output used to be trimmed (whole-output and
  // per-entry), so a committed path with LEADING WHITESPACE — ` .claude/
  // evil.md`, space included, which is NOT a harness path — normalized into
  // one and rode the harness exemption. Paths are now taken verbatim; the
  // odd path simply fails the harness match, which is fail-closed.
  it('does not exempt a diff whose only file resembles a harness path after trimming', () => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    // Stage the path without touching the filesystem so Windows naming rules
    // cannot interfere with the leading space.
    const tf = path.join(tmpDir, 'blob');
    fs.writeFileSync(tf, '# evil\n');
    const sha = g('hash-object', '-w', tf);
    fs.rmSync(tf);
    g('update-index', '--add', '--cacheinfo', `100644,${sha}, .claude/evil.md`);
    g('commit', '-m', 'leading-space path');

    expectBlock('gh pr merge 90');
  });

  // ---------------------------------------------------------------------
  // Registration coverage beyond hooks.json (downstream feedback).
  // ---------------------------------------------------------------------

  // `.codex/config.toml` can carry an inline `[hooks]` table, a `[features]`
  // hooks kill-switch, and `[[rules]]` deny decisions; mcp.json registers
  // command/args execution. All are registration, gated whole-file.
  it.each([
    ['codex project config', '.codex/config.toml'],
    ['case-variant codex project config', '.codex/Config.toml'],
    ['claude mcp registration', '.claude/mcp.json'],
    ['cursor mcp registration', '.cursor/mcp.json'],
  ])('does not exempt a harness-only diff touching the %s', (_label, file) => {
    const g = initRepo();
    g('checkout', '-b', 'chore/harness');
    commitFile(g, file, '# edited\n', 'registration-class edit');

    const out = expectControlBlock('gh pr merge 92', _label);
    expect(out.reason, _label).toContain(file);
  });

  // The deny rules in settings.json are the layer backing the destructive-
  // command guards; dropping one is a protection change (the codex
  // counterpart, `[[rules]]` in config.toml, is gated whole-file).
  it('does not exempt removing a permissions.deny rule from settings.json', () => {
    const settings = (deny) =>
      JSON.stringify({ permissions: { deny, allow: [] }, hooks: {} }) + '\n';
    const g = initRepo();
    seedMain(g, SETTINGS, settings(['Bash(git reset --hard:*)']), 'deny rules');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, SETTINGS, settings([]), 'drop the deny rule');

    const out = expectControlBlock('gh pr merge 93');
    expect(out.reason).toContain(SETTINGS);
  });

  it('keeps the exemption when only permissions.allow changes', () => {
    const settings = (allow) =>
      JSON.stringify({
        permissions: { deny: ['Bash(git reset --hard:*)'], allow },
        hooks: {},
      }) + '\n';
    const g = initRepo();
    seedMain(g, SETTINGS, settings([]), 'settings');
    g('checkout', '-b', 'chore/harness');
    commitFile(g, SETTINGS, settings(['Bash(npm test)']), 'widen allow only');

    expect(runHook({ tool_input: { command: 'gh pr merge 94' } })).toBe('');
  });

  // ---------------------------------------------------------------------
  // Command injection: refs reach git as argv elements, never as shell text.
  // ---------------------------------------------------------------------
  it.each([
    ['cmd.exe redirection', 'git merge a">injected.txt'],
    ['POSIX command substitution', 'git merge `touch injected.txt`'],
    ['POSIX $() substitution', 'git merge $(touch injected.txt)'],
  ])('does not let a crafted merge ref (%s) run side effects', (_label, command) => {
    initRepo(); // on main, so the merge is gated
    const before = fs.readdirSync(tmpDir).sort();

    const out = runHook({ tool_input: { command } });
    if (out !== '') expect(JSON.parse(out).decision).toBe('block');

    expect(fs.existsSync(path.join(tmpDir, 'injected.txt'))).toBe(false);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(before);
  });
});
