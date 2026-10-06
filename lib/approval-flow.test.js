// #188 / #189: the approve-once flow and the automatic additional tests, pinned where the
// rule lives. The scan in approval-scan.test.js catches new stop points; these tests catch
// the rule itself drifting or the three templates diverging.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TEMPLATES = ['templates/CLAUDE.md.template', 'templates/AGENTS.md.template', 'templates/cursorrules.template'];
// Runtime-specific paths differ between the templates; compare the rule text without them.
const normalize = (text) => text.replace(/\.(claude|codex|cursor)\//g, '.<runtime>/').replace(/ai-dev-helm review-budget/g, '<runtime> review-budget');

function between(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`section not found: ${start}`);
  return text.slice(from, to + end.length);
}

describe('templates (#188 #189)', () => {
  test('the autonomy rule with the closed stop exceptions is identical in all three templates', () => {
    const sections = TEMPLATES.map((file) => normalize(between(read(file), 'Before the design is approved, ask the user only when:', 'run them yourself and verify.')));
    expect(sections[0]).toMatch(/X1 quality-check review limit/);
    expect(sections[0]).toMatch(/X8 something the work needs cannot be obtained/);
    expect(sections[1]).toBe(sections[0]);
    expect(sections[2]).toBe(sections[0]);
  });

  test('the after-approval line and the completion criteria are in all three templates', () => {
    for (const file of TEMPLATES) {
      const text = read(file);
      expect([file, text.includes('- After approval: the approval covers planning, implementation')]).toEqual([file, true]);
      expect([file, text.includes("Step 5 judged with its automatic runs done and the user's answer recorded for any item that needed confirmation")]).toEqual([file, true]);
      expect([file, text.includes('it is not an approval gate')]).toEqual([file, false]);
      expect([file, text.includes('a substantive decision outside the approved design has not been authorized')]).toEqual([file, false]);
    }
  });
});

describe('workflow skills (#188)', () => {
  test('the canonical rule lists the stop exceptions, the order and the final message', () => {
    const policy = read('shared/documents/development-policy.md');
    for (const id of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8']) expect(policy).toMatch(new RegExp(`\\| ${id} \\|`));
    expect(policy).toMatch(/#### 承認後の進め方（正本）/);
    expect(policy).toMatch(/設計との差異: なし/);
    expect(policy).toMatch(/X4 の手順（止まるのは 1 回）/);
  });

  test('executing-plans reports deviations at the end instead of escalating mid-way', () => {
    for (const file of ['scripts/skill-overlays/executing-plans/SKILL.md', 'skills/superpowers/executing-plans/SKILL.md']) {
      const text = read(file);
      expect(text).toMatch(/report them in the final report/);
      expect(text).not.toMatch(/Report material changes to the plan/);
      expect(text).not.toMatch(/ask only about missing consequential requirements/);
    }
  });

  test('brainstorming says what the approval covers and where deviations are recorded', () => {
    const text = read('skills/superpowers/brainstorming/SKILL.md');
    expect(text).toMatch(/The approval covers the spec update, the plan and its review, implementation/);
    expect(text).toMatch(/## 実装時の差異/);
  });

  test('upstream skills no longer hand decisions back to the human partner after approval', () => {
    expect(read('skills/superpowers/test-driven-development/SKILL.md')).not.toMatch(/ask your human partner|human partner's permission/i);
    expect(read('skills/superpowers/receiving-code-review/SKILL.md')).not.toMatch(/Stop and discuss with your human partner|ask for direction/);
    expect(read('skills/superpowers/systematic-debugging/SKILL.md')).not.toMatch(/Discuss with your human partner before attempting more fixes/);
    expect(read('skills/superpowers/using-git-worktrees/SKILL.md')).not.toMatch(/human partner's call/);
  });

  test('the approval covers the merge when there is no deviation; deviations wait for a final confirmation (#196)', () => {
    for (const file of ['scripts/skill-overlays/finishing-a-development-branch/SKILL.md', 'skills/superpowers/finishing-a-development-branch/SKILL.md']) {
      expect(read(file)).toMatch(/If there are none, merge with the project's merge procedure/);
      expect(read(file)).toMatch(/create the quality-check flag only after the user's confirmation/);
      expect(read(file)).toMatch(/A deviation that appears after that confirmation needs a new confirmation/);
      expect(read(file).indexOf('exception X2')).toBeLessThan(read(file).indexOf('If there are none, merge'));
      expect(read(file)).not.toMatch(/If those rules do not say to merge, do not merge/);
    }
    const policy = read('shared/documents/development-policy.md');
    expect(policy).toMatch(/main への統合（マージ）も承認の範囲に含む/);
    expect(policy).toMatch(/「この差異を認めてマージしてよいか」を書き、その項目への OK を受けてからフラグを作り、AI がマージする/);
    expect(policy).toMatch(/OK の後に新しい差異が生じたら、もう一度確認する/);
    expect(policy).toMatch(/マージで自動的に本番（客先・利用者に影響する環境）へのリリース・公開・デプロイが起きるマージは例外 X2/);
    expect(policy).toMatch(/PR 本文の「設計・計画との差異」/);
    expect(read('skills/project/quality-check/SKILL.md')).toMatch(/「この差異を認めてマージしてよいか」への OK を受けるまでフラグを作成しない/);
    // gate_override stays the record of an abort approval only, not of the OK for deviations.
    expect(read('skills/project/quality-check/SKILL.md')).toMatch(/ユーザーの明示承認なしにフラグを作成しない。承認時は `\.quality-check-report\.json` の `gate_override` に記録する/);
    expect(read('skills/project/quality-check/SKILL.md')).not.toMatch(/削除してから確認する。承認時は/);
    expect(read('skills/project/test-recommendation/SKILL.md')).toMatch(/設計との差異の項目がある場合は、その項目への OK を受けてから/);
    expect(policy).not.toMatch(/規則がマージまで進めると定めていなければマージしない/);
    for (const file of TEMPLATES) {
      expect(read(file)).toMatch(/It also covers the merge when no deviation from the design was recorded/);
      expect(read(file)).toMatch(/the PR and the merge when no deviation from the design was recorded \(with deviations, a final confirmation before merging\) - do not ask again/);
      expect(read(file)).toMatch(/X2 a release \(including a merge that automatically releases, publishes or deploys to production/);
      expect(read(file)).not.toMatch(/It does not cover merging unless the project's rules say to merge/);
    }
  });

  const FINISHING = ['scripts/skill-overlays/finishing-a-development-branch/SKILL.md', 'skills/superpowers/finishing-a-development-branch/SKILL.md'];
  // Asserts that every snippet is present and that they appear in this order.
  const inOrder = (text, snippets) => {
    const at = snippets.map((s) => text.indexOf(s));
    for (const [i, s] of snippets.entries()) expect([s, at[i]]).not.toEqual([s, -1]);
    for (let i = 1; i < at.length; i++) expect([snippets[i], at[i] > at[i - 1]]).toEqual([snippets[i], true]);
  };

  test('a deviation found after the flag is recorded like any other and the flag is deleted before asking (#199-1)', () => {
    const policy = read('shared/documents/development-policy.md');
    expect(policy).not.toContain('フラグの後に分かった差異は PR 本文にだけ書く');
    expect(policy).toContain('フラグの後に分かった差異も、同じ記録先（spec / 計画 / 作業メモ）と PR 本文に書き、1 に従って `.quality-check-passed` を削除してから確認する');
    expect(policy).toContain('OK を受けてから、その HEAD で quality-check の Step 6 を行う（前回のチェックからの差分が記録だけのとき');
    expect(read('skills/project/quality-check/SKILL.md')).toContain('OK を受けてから、その HEAD で Step 6 を行う（前回のチェックからの差分が記録だけのとき');
    for (const file of ['scripts/skill-overlays/brainstorming/SKILL.md', 'skills/superpowers/brainstorming/SKILL.md']) {
      expect(read(file)).toContain('A deviation found after the flag is recorded there and in the PR body too; delete the flag, then ask about merging with it; after the OK, create the flag on that HEAD (quality-check Step 6)');
    }
  });

  test('X2 is a release to production; an automatic deploy to a checking environment without production data is not X2 (#199-4)', () => {
    const policy = read('shared/documents/development-policy.md');
    const condition = '本番の DB・本番の決済・実際の客先への送信等を使わない、動作確認用の環境（staging 等）への自動デプロイは X2 に当たらない';
    expect(policy).toContain(`| X2 | リリース（マージで自動的に本番（客先・利用者に影響する環境）へのリリース・公開・デプロイが起きる場合を含む。${condition}。名前ではなく、客先・利用者に影響するかで決める）`);
    expect(policy).toContain(`マージは例外 X2（${condition}。名前ではなく、客先・利用者に影響するかで決める）`);
    expect(policy).toContain('共有環境の変更（staging の環境変数の手作業の変更など）');
    expect(policy).not.toContain('共有環境へのデプロイ');
    expect(read('shared/documents/harness-upgrade.md')).toContain(`${condition}（名前ではなく、客先・利用者に影響するかで決める）`);
    const english = 'an automatic deploy to an environment for checking behavior (such as staging) that does not touch production - the production database, live payments, or sending to real customers and the like - is not X2; judge by the effect on customers or users, not by the name';
    expect(policy).not.toContain('本番のデータ・外部サービス');
    for (const file of TEMPLATES) {
      expect([file, read(file).includes(`deploys to production - an environment that customers or users rely on; ${english}), closing`)]).toEqual([file, true]);
      expect([file, read(file).includes('deploys to a shared environment')]).toEqual([file, false]);
    }
    for (const file of FINISHING) {
      expect(read(file)).toContain(`deploys to production - an environment that customers or users rely on (exception X2; ${english})`);
    }
  });

  test('the OK for a promotion to production covers the whole range, fixed at one SHA (#199-5)', () => {
    const policy = read('shared/documents/development-policy.md');
    expect(policy).toContain('8. **本番への反映の OK の範囲（X2）**');
    expect(policy).toContain('聞く前に `git fetch origin` し、反映元（main）の終点の SHA を固定する');
    expect(policy).toContain('起点が見つからなければ、推測で一覧を作らず、見つからないことを最後の 1 通に書く');
    // N1: the OK rule covers all of X2 (the table row); item 8 refers to it.
    expect(between(policy, '| X2 |', '\n')).toContain('X2 の OK として扱うのは、その項目への返答か、操作と対象（範囲）を明示した指示だけ。設計の承認・汎用の継続指示（「続けて」等）・範囲を示さない指示は OK にしない');
    expect(policy).toContain('OK として扱うのは、4 の X2 の規則のとおり、一覧と SHA を示した項目への返答か、操作と範囲を明示した指示だけ（範囲を示さない「反映して」を受けたら、一覧と SHA を作って聞く）');
    expect(policy).toContain('反映はその SHA で行う。聞いてから OK までに増えた分と、OK の後に増えた分は含めない');
    expect(policy).toContain('PR で反映するときは head を main にしない（SHA を指す一時ブランチを head にする。例: `git push origin <SHA>:refs/heads/promote/<短縮SHA>`）か、`gh pr merge --match-head-commit <SHA>` でマージする');
    expect(policy).toContain('squash で反映するときは、反映 PR の本文に反映元の SHA を書く');
    expect(policy).toContain('一覧に「この PR（マージ後）」を加える');
    expect(policy).toContain('OK の後のマージ・反映は AI が行う');
    for (const file of FINISHING) {
      const text = read(file);
      expect(text).toContain('the X2 question covers everything that goes out');
      expect(text).toContain('if no starting point is found, do not guess a list - write that it was not found in the final message');
      expect(text).toContain('- finish the reviewable result and put that question in the final message. Only an answer to that item, or an instruction that names the operation and its target (range), counts as an X2 OK - not the design approval, a generic "continue", or an instruction that names no range.');
      expect(text).toContain('As for any X2 OK, only an answer to the item that shows the list and the SHA, or an instruction that names the operation and the range, counts (on a "promote it" that names no range, build the list and the SHA and ask)');
      expect(text).toContain('Promote exactly that SHA; anything that lands before or after the OK stays out');
      expect(text).toContain('do not use main as its head (push a temporary branch at the SHA and use it, for example `git push origin <SHA>:refs/heads/promote/<short SHA>`), or merge with `gh pr merge --match-head-commit <SHA>`');
      expect(text).toContain('With squash promotion, write the source SHA in the promotion PR body');
      expect(text).toContain('add "this PR (after merge)" to the list');
      expect(text).toContain('After the OK, the AI merges and promotes');
    }
    for (const file of TEMPLATES) {
      expect([file, read(file).includes('or a merge that an adopter rule requires the user to approve. Only an answer to that item, or an instruction that names the operation and its target (range), counts as an X2 OK - not the design approval, a generic "continue", or an instruction that names no range. For a project that promotes main to a production branch, the OK covers the whole range that goes out: the item shows the list and the SHA')]).toEqual([file, true]);
    }
  });

  test('without a remote: integrate-check, then git push, before detaching; otherwise merge where the flag is (#199-3, 3.4.3 E1)', () => {
    for (const file of FINISHING) {
      const text = read(file);
      inOrder(text, [
        '"No remote" means the trunk has no remote-tracking ref (such as `origin/main`), which includes a project whose only remote is push-only; do not push the feature branch to such a remote.',
        '(2) before touching the main checkout, run `npx --no ai-dev-helm integrate-check --main <main checkout>` in the feature worktree (`npx -y @crearize/ai-dev-helm@<version in .ai-dev-helm.json> integrate-check --main <main checkout>` where the CLI is not installed',
        'It only reads - no push, merge or switch - and calls git with argument arrays',
        'and a file the feature changes that the main checkout marks skip-worktree or assume-unchanged (local edits `git status` does not show).',
        'Unrelated untracked files (the user\'s own material) are not looked at and do not block the integration; leave them alone.',
        'Read its last line. `integrate-check: OK` (exit 0): go on.',
        '`integrate-check: NG (<trunk> is not an ancestor only)`: merge the trunk into the feature, re-run quality-check and start again from (1), integrate-check included (the main checkout is not touched, so this is no stop).',
        '`integrate-check: NG - change nothing ...` (exit 1): change nothing, stop integrating and report its output in the final message (exception X3; continue after the owner answers).',
        'Output that does not start with `integrate-check:` is no verdict (a usage error is exit 2; a missing CLI or an old devDependency\'s `Unknown argument` is no verdict either): fix the `--main` path or the like, or run `npx -y @crearize/ai-dev-helm@<version in .ai-dev-helm.json> integrate-check ...` instead.',
        '(3) Check that `git push . HEAD:main` is usable in this project',
        '(4) If it is, in the checkout that has main open, run `git switch --detach`',
        '(5) If it is not, or a deny rule refuses the push after the detach, keep main detached and use the local merge of the `branch-workflow` skill, run where the flag is',
        'in the feature worktree, `git switch main`, `git merge --no-ff <feature>`, `git switch <feature>`; in the main checkout, `git switch main`',
        'The detach, push, merge and switch stay plain git commands the quality gate sees; integrate-check never runs them.',
        'If the final `git switch main` fails anyway',
        'do not move or delete files and do not use `git switch -f`: leave the main checkout detached at the commit before the integration (the only case it stays detached) and report git\'s output (it names the files in the way) and the state in the final message (exception X3).',
        'If the push or the merge is refused for a reason other than a deny rule (the quality gate, git\'s non-fast-forward refusal and the like), put both checkouts back',
        'Use this only when the trunk has no remote-tracking ref.',
      ]);
      expect(text).toContain('and re-run quality-check (after merging main into the feature if main has moved on); otherwise never leave the main checkout detached');
      for (const gone of ['before stopping', 'one by one', 'Use this only when no remote exists', 'ls-files', '/dev/null', 'wc -l', 'Never list']) {
        expect([file, gone, text.includes(gone)]).toEqual([file, gone, false]);
      }
    }
    const workflow = read('skills/project/branch-workflow/SKILL.md');
    inOrder(workflow, [
      'ここで「リモートが無い」は、trunk の remote-tracking ref（例: `origin/main`）が無いことを言う。push 専用の remote しか無い場合（trunk を取り込まない公開用の remote など）を含む。そのような remote に feature ブランチを push しない（PR の道は無い）。',
      '2. main のチェックアウトに触る前に、feature の worktree で事前確認を実行する: `npx --no ai-dev-helm integrate-check --main <main のチェックアウト>`（CLI が手元に無ければ `npx -y @crearize/ai-dev-helm@<.ai-dev-helm.json の version> integrate-check --main <main のチェックアウト>`',
      '読み取りだけのコマンドで、何も変更しない（push・merge・switch もしない）',
      'feature が変えるファイルに main のチェックアウトで skip-worktree / assume-unchanged が付いていない（`git status` に出ない手元の変更）',
      '関係の無い未追跡ファイル（ユーザーの資料など）は見ない。統合を妨げないので、触れずにそのまま残す',
      '出力の最後の行が `integrate-check: OK`（終了コード 0）: 次へ進む',
      '最後の行が `integrate-check: NG (<trunk> is not an ancestor only)`: main を feature に取り込み、quality-check をやり直してから、手順 1 からやり直す（integrate-check も再実行する。main のチェックアウトには触れないので止まらない）',
      '最後の行が `integrate-check: NG - change nothing …`（終了コード 1）: 何も変えずに統合を止め、出力を最後の 1 通で知らせる（例外 X3。オーナーの返答の後に進める）',
      '出力が `integrate-check:` で始まらなければ、判定ではない（使い方の誤りは終了コード 2。CLI が手元に無い・古い devDependency の `Unknown argument` なども判定ではない）。`--main` の場所などを直すか、`npx -y @crearize/ai-dev-helm@<.ai-dev-helm.json の version> integrate-check …` で実行し直す',
      '3. このプロジェクトで `git push . HEAD:main` が使えるかを確かめる',
      '4. main を開いているチェックアウトで `git switch --detach` を実行する',
      'deny 規則で止められたら、detach したまま下の「`git push` が使えない場合」の 2 に進む',
      '6. main のチェックアウトで `git switch main` を実行する（失敗したときは下の「最後の `git switch main` が失敗したとき」）',
      '実際の detach・push・merge・switch は、上のとおり手順に書いた git コマンドで行う（quality-gate の hook に見える形を保つ。integrate-check の中では行わない）。',
      '**最後の `git switch main` が失敗したとき**',
      'ファイルの移動・削除や `git switch -f` はしない。main のチェックアウトは統合前の commit で detached のまま残し（この場合だけ）、git の出力（妨げているファイルの名前）と状態を最後の 1 通で知らせる（例外 X3）。',
      '**`git push` が使えない場合**: 上の表の「1 つのチェックアウト」と同じローカルのマージ（`git merge --no-ff <feature>`）を、フラグのある feature の worktree で行う',
      '2. feature の worktree で `git switch main` → `git merge --no-ff <feature>` → `git switch <feature>` を実行する',
      'deny 以外の理由（quality gate、git の non-fast-forward 拒否 等）で push / merge が拒否されたら、両方を元に戻し',
    ]);
    expect(workflow).toContain('main のチェックアウトを detached のまま残さない（例外は上の「最後の `git switch main` が失敗したとき」だけ）');
    for (const gone of ['ls-files', '/dev/null', 'wc -l', '一覧は出さない', '件数だけ', '個別に']) expect([gone, workflow.includes(gone)]).toEqual([gone, false]);
    // The summaries carry the same check and the same meaning of "no remote".
    const remoteDefinition = 'Without a remote (no remote-tracking ref for the trunk such as `origin/main`, including a project whose only remote is push-only - do not push the feature branch there), with main open in another worktree, integrate from the feature worktree instead';
    const checks = 'first run `npx --no ai-dev-helm integrate-check --main <main checkout>` in the feature worktree (read-only; it names a main checkout that does not have main open, uncommitted tracked changes there, a main that is not an ancestor of the feature, anything untracked or ignored at a path the feature adds, and skip-worktree / assume-unchanged files the feature changes - unrelated untracked files do not matter; if main is only not an ancestor, merge main into the feature, re-run quality-check and start over; on any other problem change nothing and report it, exception X3) and check that `git push` is usable in the project';
    for (const file of TEMPLATES) {
      expect([file, read(file).includes(remoteDefinition)]).toEqual([file, true]);
      expect([file, read(file).includes(checks)]).toEqual([file, true]);
    }
    const jaDefinition = 'リモートの無い導入先（trunk の remote-tracking ref が無い。push 専用の remote しか無い場合を含み、その remote に feature ブランチを push しない）は branch-workflow スキルの「リモートの無いプロジェクトの取り込み」';
    expect(read('README.md')).toContain(jaDefinition);
    expect(read('README.md')).toContain('先に feature の worktree で `npx --no ai-dev-helm integrate-check --main <main のチェックアウト>`（読み取りだけの事前確認。main のチェックアウトが main を開いていないこと・その追跡ファイルの未コミットの変更・main が feature の祖先でないこと・feature が足すパスにある未追跡や ignore 済みのもの・feature が変えるファイルに付いた skip-worktree / assume-unchanged を名前つきで出す。関係の無い未追跡ファイルは妨げにならない。祖先でないだけなら main を取り込んで quality-check と事前確認をやり直し、ほかの問題があれば何も変えずに止まって知らせる）');
    expect(read('README.md')).toContain('最後の行が `integrate-check: OK` / `integrate-check: NG …` の判定です（終了コードは 0 = 問題なし / 1 = 問題あり / 2 = 使い方の誤り。出力が `integrate-check:` で始まらなければ判定ではありません）。`--main` の相対パスはカレントディレクトリを基準にします。');
    expect(read('README.md')).toContain('npx @crearize/ai-dev-helm integrate-check --main <main のチェックアウト> [--trunk main]');
    expect(read('skills/project/quality-check/SKILL.md')).toContain(jaDefinition);
    expect(read('skills/project/quality-check/SKILL.md')).toContain('（先に feature の worktree で `integrate-check` を実行して main のチェックアウトの状態を確かめ、feature の worktree から `git push . HEAD:main`。');
    expect(read('shared/documents/development-policy.md')).toContain('リモートが無いプロジェクト（trunk の remote-tracking ref が無い。push 専用の remote しか無い場合を含み、その remote に feature ブランチを push しない。または導入先の規則で PR を使わないプロジェクト）では、(A)(B) とも push・PR 作成を省く。');
    expect(read('shared/documents/harness-upgrade.md')).toContain('`.gitignore` に `.claude/worktrees/`（Claude Code の標準の作業ツリーの置き場所）を足す');
    expect(read('shared/documents/harness-upgrade.md')).toContain('`"$(git rev-parse --git-common-dir)/info/exclude"` に `.claude/worktrees/` を足す（追跡されず、すべての作業ツリーに効く）');
    // The three templates carry the same remote-less sentence (cursorrules included).
    const remoteless = (text) => {
      const from = text.indexOf('Without a remote (no remote-tracking ref for the trunk');
      const to = text.indexOf('Delete `.quality-check-passed` after any merge into main.', from);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      return text.slice(from, to);
    };
    const sentences = TEMPLATES.map((file) => remoteless(read(file)));
    expect(sentences[1]).toBe(sentences[0]);
    expect(sentences[2]).toBe(sentences[0]);
    // implementation-report does not hand the missing quality-check back to the user.
    const report = read('skills/project/implementation-report/SKILL.md');
    expect(report).not.toContain('実行するよう促して処理を中断する');
    expect(report).toContain('レポートを作らずに先に `quality-check` スキルを実行し（AI が実行する。ユーザーに促さない — 前提条件と同じ）、そのレポートでこの手順をやり直す');
    expect(workflow).not.toContain('元に戻してから止まる');
  });

  test('the templates make the flag in the worktree of the branch being integrated, never on a main checkout (#199-6)', () => {
    for (const file of TEMPLATES) {
      const text = read(file);
      expect([file, text.includes('The only correct procedure for merging into a `main` checked out in a git worktree')]).toEqual([file, false]);
      expect([file, text.includes('creating the flag inside the worktree, then merge from there')]).toEqual([file, false]);
      expect([file, /Make the flag where the commit main receives was checked: run (`\/quality-check`|quality-check) in the worktree of the branch being integrated and integrate from there \(with a remote, `gh pr merge` from that worktree\)\. Do not make the flag on a main checkout\. Without a remote \(no remote-tracking ref for the trunk/.test(text)]).toEqual([file, true]);
    }
  });

  test('no template tells the agent to check or merge on main itself, or to make or copy the flag there (#199 cycle 5)', () => {
    for (const file of TEMPLATES) {
      const text = read(file);
      // M1: the hook refuses the merge when main moved on; nothing is re-checked on the merged main.
      expect([file, text.includes('on the merged main')]).toEqual([file, false]);
      expect([file, text.includes('the merge may succeed')]).toEqual([file, false]);
      expect([file, /If main advanced independently after the flag was issued, `git merge <branch>` on main is refused: merge main into the branch \(or rebase it\), re-run (`\/quality-check`|quality-check) there, then integrate\./.test(text)]).toEqual([file, true]);
      // S2: the only sentence that names both the flag and a main checkout is the prohibition.
      const sentences = text.split(/\n/).flatMap((line) => line.split(/(?<=[.!?])\s+/))
        .filter((sentence) => /\bflag\b|\.quality-check-passed/i.test(sentence) && /main checkout|checkout that has main open|main worktree/i.test(sentence));
      expect([file, sentences]).toEqual([file, ['Do not make the flag on a main checkout.']]);
    }
  });

  test('the PR body\'s Flag commit is updated right after the flag is made (#199 cycle 5 N2)', () => {
    const policy = read('shared/documents/development-policy.md');
    expect(policy).toContain('→ OK → フラグ作成 → PR 本文の Flag commit を更新 → マージ → 短い報告。(B)');
    expect(policy).toContain('→ PR 本文の再生成・更新 → フラグ作成 → PR 本文の Flag commit を更新 → push →');
    const qc = read('skills/project/quality-check/SKILL.md');
    expect(qc).toContain('PR 本文を更新してから Step 6 に進み、フラグを作ったら PR 本文の Flag commit を更新する');
    expect(qc).toContain('→ PR 本文の更新 → Step 6 → PR 本文の Flag commit を更新。');
    expect(read('skills/project/test-recommendation/SKILL.md')).toContain('その項目への OK を受けてから）→ PR 本文の Flag commit を更新。');
    // Step 6 covers every route that makes or remakes the flag after the PR exists.
    expect(between(qc, '### フラグファイル作成', 'フラグの性質:')).toContain('PR が既にあるときは、フラグを作った（作り直した）後に PR 本文の Flag commit を更新する。');
  });

  test('harness-upgrade keeps the 3.4.2 steps under their own heading (#199 cycle 5 N3)', () => {
    const upgrade = read('shared/documents/harness-upgrade.md');
    const section = between(upgrade, '## 3.4.2 の更新', '## 計測の範囲');
    for (const step of ['`.claude/worktrees/`（Claude Code の標準の作業ツリーの置き場所）を足す', 'info/exclude', '動作確認用の環境（staging 等）への自動デプロイは X2 に当たらない']) {
      expect([step, section.includes(step)]).toEqual([step, true]);
    }
    expect(between(upgrade, '## マージの既定（3.4.1）', '## 3.4.2 の更新').replace('## 3.4.2 の更新', '')).not.toContain('3.4.2');
  });

  // The distributed documents (and the CLI) checked by the sweeps below.
  const DOC_ROOTS = ['templates', 'shared', 'skills', 'scripts/skill-overlays', 'stacks', 'configs', 'README.md'];
  const filesUnder = (roots, include) => {
    const out = [];
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      if (fs.statSync(abs).isDirectory()) {
        for (const name of fs.readdirSync(abs)) walk(path.posix.join(rel, name));
        return;
      }
      if (!/\.test\.js$/.test(rel) && include.test(rel)) out.push(rel);
    };
    for (const rel of roots) walk(rel);
    return out;
  };

  test('the remote-less pre-check ignores unrelated untracked files; no document lists them with a bare status (3.4.3, E1 / E6)', () => {
    // Nowhere in the distributed documents: a status call (any short form) that lists untracked files without saying so.
    const plain = [];
    for (const file of filesUnder(DOC_ROOTS, /\.(md|mdc|template|toml|json|cjs|js|sh|ps1|ya?ml)$|README\.md$/)) {
      read(file).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\bstatus (?:--porcelain(?:=v[12])?|--short|-s[a-z]*)\b(?! (?:--untracked-files=|-u))/g)) plain.push(`${file}:${i + 1}: ${m[0]}`);
      });
    }
    expect(plain).toEqual([]);
    // worktree-parallel Step 0 may run in the main checkout: tracked changes only.
    expect(read('skills/project/worktree-parallel/SKILL.md')).toContain('git branch --show-current\ngit status --short --untracked-files=no\ngit worktree list');
    for (const file of [...TEMPLATES, ...FINISHING, 'skills/project/branch-workflow/SKILL.md', 'README.md']) {
      expect([file, read(file).includes('has no uncommitted changes, that main is an ancestor')]).toEqual([file, false]);
    }
    const upgrade = read('shared/documents/harness-upgrade.md');
    const section = between(upgrade, '## 3.4.3 の更新', '## 計測の範囲');
    for (const step of [
      'リモートの無い統合の事前確認は、読み取りだけの CLI `ai-dev-helm integrate-check --main <main のチェックアウト>` に変わった',
      '関係の無い未追跡ファイルには触れない。リモートの無い導入先は、独自に書いた統合の手順（status を見る・未追跡ファイルを退避する等）を、この CLI を使う配布元の手順への参照に置き換える。',
      '「リモートが無い」は、trunk の remote-tracking ref（例: `origin/main`）が無いことを言う。',
      '既存の package.json や CI に、`@crearize/` を付けない `npx` で `ai-dev-helm lint` を呼ぶ箇所が残っていれば置き換える（package.json の scripts の中なら `ai-dev-helm lint`、外なら `npx --no ai-dev-helm lint`',
      '`.gitignore` を確かめる。',
      'quality-check の共通コンテキスト（`quality-context`）は、未追跡ファイルを変更に含めず、件数と名前を別の節と WARNING に出す',
      '祖先でないだけなら止まらず、main を取り込んで quality-check と事前確認をやり直す。',
      '`@crearize/ai-dev-helm` を devDependency にしている導入先は、その版を 3.4.3 以上に上げる',
      'フラグの作成前に `quality-context --check-untracked` で、レビュー時に未追跡だったファイルが変更に入っていないことを確かめ、最後の行が `untracked-check: OK` のときだけフラグを作る',
    ]) expect([step, section.includes(step)]).toEqual([step, true]);
    expect(section).not.toContain('一覧を出さない');
    expect(upgrade).toContain('- 必要なら（`.gitignore` の更新を統合する前から `git status` の表示を整えたいとき）、`"$(git rev-parse --git-common-dir)/info/exclude"` に `.claude/worktrees/` を足す');
    expect(upgrade).not.toContain('が空にならず、リモートの無い統合が進まない');
    expect(read('lib/init.js')).not.toContain('which stops the\n  // remote-less integration');
    // E4: quality-check's common context keeps untracked files out of the change.
    const qc = read('skills/project/quality-check/SKILL.md');
    expect(qc).toContain('未追跡ファイルは変更に含めず、件数と名前を別の節「未コミットの新規ファイル」に示す');
    expect(qc).toContain('9. **スナップショット**: 変更ファイル（追跡ファイル。新規ファイルはコミット済み・`git add` 済みのもの。未追跡ファイルはコピーしない）');
    expect(between(qc, '#### 4-0. 共通コンテキストの生成', '1. 対象ブランチ')).toContain('**共通コンテキストの生成前に、変更の新規ファイルを `git add` する（MUST。`git add -N` でもよい）**');
    const step6 = between(qc, '### フラグファイル作成', '全チェック通過後');
    expect(step6).toContain('**フラグ作成の前に、最後のサイクルで未追跡だったファイルが変更に入っていないことを確かめる（MUST）**: `npx @crearize/ai-dev-helm quality-context --check-untracked --cycle <最後のサイクル> --out <scratchpad>/quality-check`');
    for (const rule of [
      '- フラグを作るのは、出力の最後の行が `untracked-check: OK` のときだけ',
      '- 最後の行が `untracked-check: NG` なら、フラグを作らない。出た名前ごとに、変更に属するかを確かめる',
      '  - 属するなら、共通コンテキストを作り直してレビューをやり直す（レビューされていないため）',
      '  - 属さない（ユーザーのファイル等）なら、ファイルは消さずに `git rm --cached -- <名前>` で変更から外してコミットし、もう一度この確認をする',
      '  - どちらか判断できなければ、名前を示して止まり、オーナーに確かめる',
      '- 出力が `untracked-check:` で始まらなければ、判定ではない（meta.json が読めない・古い形式、古い CLI の `Unknown argument` 等。終了コード 2）。`--out` と CLI の版を直し',
    ]) expect([rule, step6.includes(rule)]).toEqual([rule, true]);
    expect(qc).toContain('フラグ作成より前に、パスを指定してコミットする（MUST。`git add -A` / `git commit -a` を使わない');
    expect(read('skills/project/test-recommendation/SKILL.md')).toContain('パスを指定してコミットする**（`git add -A` / `git commit -a` を使わない');
    // L1: no description of the removed untracked cap, and one wording for "add, then rebuild".
    for (const gone of ['先頭 200 件', '修正差分から除外する', '初めて比較する', 'コミットしてから quality-check をやり直す']) expect([gone, qc.includes(gone)]).toEqual([gone, false]);
    expect(qc).toContain('未追跡ファイルは変更に含めず、スナップショット・修正差分にも含めない。');
    expect(read('lib/quality-check-context.js')).not.toContain('コミットしてから quality-check をやり直す');
    expect(read('shared/documents/harness-upgrade.md')).toContain('最後の行が `untracked-check: OK` のときだけフラグを作る（NG なら、変更に属するものはレビューをやり直し、属さないユーザーのファイルは消さずに `git rm --cached` で外す。');
  });

  test('no distributed text or CLI message runs the bare CLI in a way that could fetch another package (3.4.3, D10)', () => {
    const found = [];
    const RUNNERS = /\b(?:npx((?:\s+-{1,2}[\w-]+)*)|pnpm\s+dlx|bunx|yarn\s+dlx)\s+ai-dev-helm\b/g;
    const COMMANDS = '(?:init|personal|lint|link-skills|integrate-check|review-budget|hook-selftest|codex-trust|quality-report|quality-context|harness-inventory)';
    // Lines that are a bare command (a code block line) or a "run ..." hint for the bare CLI.
    const BARE_LINE = new RegExp(`^\\s*(?:\\$\\s+)?ai-dev-helm ${COMMANDS}\\b`);
    const RUN_HINT = new RegExp(`\\b[Rr]un:?\\s+\\\\?\`?ai-dev-helm ${COMMANDS}\\b`);
    const BARE_REVIEW_BUDGET = /(?<![\w@/-]|--no )`ai-dev-helm review-budget\b/;
    for (const file of filesUnder([...DOC_ROOTS, 'lib', 'bin'], /\.(md|mdc|template|toml|json|js|cjs|mjs|sh|ps1|ya?ml)$|README\.md$/)) {
      read(file).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(RUNNERS)) {
          if (m[0].startsWith('npx') && /\s--no\b/.test(m[1] || '')) continue;
          found.push(`${file}:${i + 1}: ${m[0]}`);
        }
        if (BARE_LINE.test(line) || RUN_HINT.test(line) || BARE_REVIEW_BUDGET.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found).toEqual([]);
    expect(read('skills/project/lint-scaffolding/SKILL.md')).toContain('package.json の scripts から `ai-dev-helm lint` を呼ぶ形で組み込む（scripts の外で直接呼ぶときは `npx --no ai-dev-helm lint`');
    expect(read('README.md')).toContain('`npx -y @crearize/ai-dev-helm@<更新先の version> init` を再実行する');
    expect(read('lib/harness-diagnostics.js')).toContain('npx -y @crearize/ai-dev-helm@${PACKAGE_VERSION} link-skills (or npx --no ai-dev-helm link-skills where the CLI is installed)');
  });

  test('new worktrees get the skill links pinned to the installed version (#199-2)', () => {
    for (const file of ['scripts/skill-overlays/using-git-worktrees/SKILL.md', 'skills/superpowers/using-git-worktrees/SKILL.md']) {
      expect(read(file)).toContain('run `npx -y @crearize/ai-dev-helm@<version> link-skills`, with `<version>` the `version` in `.ai-dev-helm.json`');
    }
    const parallel = read('skills/project/worktree-parallel/SKILL.md');
    expect(parallel).toContain('`npx -y @crearize/ai-dev-helm@<version> link-skills`');
    expect(parallel).not.toContain('`npx @crearize/ai-dev-helm link-skills`');
    for (const file of TEMPLATES) {
      expect([file, read(file).includes('If the link is missing (a new worktree, for example), run `link-skills` (the `using-git-worktrees` skill) or read `skills/<same relative path>/SKILL.md` directly.')]).toEqual([file, true]);
    }
  });

  test('the PR report and the PR template both carry the flag commit, in the quality-check summary (#199, D5)', () => {
    const line = '- Flag commit (`.quality-check-passed` `commit`): `<sha>`';
    const report = read('skills/project/implementation-report/SKILL.md');
    const template = read('templates/PULL_REQUEST_TEMPLATE.md');
    for (const [file, text, start, end] of [
      ['implementation-report', report, '### 品質チェック結果サマリ', '### ゲート上書き・承認'],
      ['PULL_REQUEST_TEMPLATE', template, '### Quality Check Summary', '### Gate Overrides and Approvals'],
    ]) {
      expect([file, between(text, start, end).includes(line)]).toEqual([file, true]);
    }
    expect(report).toContain('フラグの作成前に PR を作るとき（順序 B・設計との差異の確認待ち）は「未作成」と書き、フラグの作成後に PR 本文を更新する');
    expect(template).toContain('(before the flag exists, "not created yet"; update it after the flag is created)');
  });

  test('projects without a remote or PRs skip push and PR in both orders (#196)', () => {
    expect(read('shared/documents/development-policy.md')).toContain('または導入先の規則で PR を使わないプロジェクト）では、(A)(B) とも push・PR 作成を省く');
    expect(read('skills/superpowers/brainstorming/SKILL.md')).toMatch(/the PR and the merge when no deviation from the design was recorded/);
    expect(read('skills/project/test-recommendation/SKILL.md')).toMatch(/リモートや PR を使わないプロジェクトでは push・PR を省き/);
  });

  test('feature-documentation and quality-check Step 0 do not wait for the user', () => {
    expect(read('skills/project/feature-documentation/SKILL.md')).not.toMatch(/ユーザーの承認後にのみ/);
    expect(read('skills/project/quality-check/SKILL.md')).not.toMatch(/実行するようユーザーに促し/);
  });

  test('order B uses one ordinary PR: no draft, the confirmed tests go into the same PR (#194)', () => {
    for (const file of ['shared/documents/development-policy.md', 'skills/project/quality-check/SKILL.md', 'skills/project/test-recommendation/SKILL.md', 'skills/project/implementation-report/SKILL.md']) {
      expect([file, /gh pr ready|gh pr create --draft|draft で作/.test(read(file))]).toEqual([file, false]);
    }
    expect(read('shared/documents/development-policy.md')).toMatch(/\(B\) の PR は通常の PR で作る/);
    expect(read('skills/project/test-recommendation/SKILL.md')).toMatch(/同じ PR にコミット/);
    for (const file of ['shared/documents/development-policy.md', 'skills/project/test-recommendation/SKILL.md']) {
      expect(read(file)).toMatch(/別の作業ツリーから PR 番号を指定してマージしない/);
    }
  });

  test('implementation-report covers the PR made while Step 5 awaits confirmation', () => {
    const text = read('skills/project/implementation-report/SKILL.md');
    expect(text).toMatch(/Step 5 の確認待ちで PR を作る場合/);
    expect(text).toMatch(/PR 本文を更新する/);
    expect(text).toMatch(/### 設計・計画との差異/);
  });
});

describe('additional tests (#189)', () => {
  test('test-recommendation splits strong/recommended into automatic and confirmation', () => {
    const text = read('skills/project/test-recommendation/SKILL.md');
    expect(text).toMatch(/\| \*\*自動実施\*\* \|/);
    expect(text).toMatch(/\| \*\*確認\*\* \|/);
    expect(text).toMatch(/quality-policy §2「自動実施の範囲の上限」/);
    expect(text).not.toMatch(/対処範囲をユーザーと合意する/);
  });

  test('only a user decline counts as a decline in the ledger; AI carry-overs are marked', () => {
    const text = read('skills/project/test-recommendation/SKILL.md');
    expect(text).toMatch(/見送り回数は\*\*ユーザーが見送ったときだけ\*\*増やす/);
    expect(text).toMatch(/`自動持ち越し: 生存 N 件（unresolved）`/);
    expect(text).toMatch(/### ユーザーの見送りと AI の持ち越し/);
    expect(text).toMatch(/対象領域の行が無い、または「見送り回数」が 0/);
    expect(text).toMatch(/導線が `pending` かつ見送り回数 1 以上なら/);
  });

  test('automatic E2E runs stay on local, disposable targets', () => {
    expect(read('skills/project/test-recommendation/SKILL.md')).toMatch(/接続先が server-startup で起動したサーバーとローカル（使い捨て）の DB・モックに閉じ/);
  });

  test('after the confirmation answer, quality-check resumes from Step 5, not from Step 0', () => {
    expect(read('skills/project/quality-check/SKILL.md')).toMatch(/Step 0 からやり直さず、`\.quality-check-report\.json` も削除しない/);
    expect(read('skills/project/test-recommendation/SKILL.md')).toMatch(/Step 0 からやり直さず、ここから再開する/);
  });

  test('quality-policy holds the scope limits as the single source of the numbers', () => {
    const text = read('shared/documents/quality-policy.md');
    expect(text).toMatch(/\*\*自動実施の範囲の上限\*\*/);
    expect(text).toMatch(/production ファイル 10 個以下、かつ変更行 400 行以下/);
    expect(text).toMatch(/変更クラス 10 個以下/);
    expect(text).toMatch(/spec ファイルが 5 個以下/);
    expect(text).toMatch(/起草するシナリオが 2 本以下/);
    // The skill must not restate the numbers.
    expect(read('skills/project/test-recommendation/SKILL.md')).not.toMatch(/400 行|10 個以下|5 個以下|2 本以下|10 ファイル/);
  });

  test('the report schema records who decided, with a migration note', () => {
    const text = read('skills/project/_schemas/quality-check-report.schema.md');
    expect(text.match(/\| `decided_by` \|/g)).toHaveLength(2);
    expect(text).toMatch(/読み手は欠落を `user` とみなす/);
    expect(text).toMatch(/"decided_by": "auto"/);
  });

  test('quality-check completion waits only for the items that needed confirmation', () => {
    const text = read('skills/project/quality-check/SKILL.md');
    expect(text).toMatch(/自動実施分を実行し、確認の区分があればその返答（判断）を記録していること/);
    expect(text).not.toMatch(/Step 5（追加テスト提案）の提示とユーザー判断の記録が完了していること/);
  });
});
