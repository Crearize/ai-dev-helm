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

  test('without a remote: check the main checkout and git push before detaching; otherwise merge where the flag is (#199-3)', () => {
    for (const file of FINISHING) {
      const text = read(file);
      inOrder(text, [
        'check that `git -C <main checkout> status --porcelain` prints nothing - if it prints anything, do not detach; stop integrating',
        'check, in the feature worktree, that `git merge-base --is-ancestor main HEAD` succeeds - if it fails, do not detach: merge main into the feature, re-run quality-check, then integrate',
        'check that `git push . HEAD:main` is usable in this project',
        'in the checkout that has main open, run `git switch --detach`',
        'if it is not, or a deny rule refuses the push after the detach, keep main detached and use the local merge of the `branch-workflow` skill, run where the flag is',
        'in the feature worktree, `git switch main`, `git merge --no-ff <feature>`, `git switch <feature>`; in the main checkout, `git switch main`',
        'If the push or the merge is refused for a reason other than a deny rule (the quality gate, git\'s non-fast-forward refusal and the like), put both checkouts back',
      ]);
      expect(text).toContain('and re-run quality-check (after merging main into the feature if main has moved on); never leave the main checkout detached');
      expect(text).not.toContain('before stopping');
    }
    const workflow = read('skills/project/branch-workflow/SKILL.md');
    inOrder(workflow, [
      '`git -C <main のチェックアウト> status --porcelain` が空であること。空でなければ detach せずに統合を止める',
      'feature の worktree で `git merge-base --is-ancestor main HEAD` が成功すること。失敗したら detach せず、main を feature に取り込み、quality-check をやり直してから統合する',
      'このプロジェクトで `git push . HEAD:main` が使えること',
      '3. main を開いているチェックアウトで `git switch --detach` を実行する',
      'deny 規則で止められたら、detach したまま下の「`git push` が使えない場合」の 2 に進む',
      '**`git push` が使えない場合**: 上の表の「1 つのチェックアウト」と同じローカルのマージ（`git merge --no-ff <feature>`）を、フラグのある feature の worktree で行う',
      '2. feature の worktree で `git switch main` → `git merge --no-ff <feature>` → `git switch <feature>` を実行する',
      'deny 以外の理由（quality gate、git の non-fast-forward 拒否 等）で push / merge が拒否されたら、両方を元に戻し',
    ]);
    expect(workflow).toContain('quality-check をやり直す（main が先に進んでいれば、main を取り込んでから）。main のチェックアウトを detached のまま残さない');
    // L2: the summaries carry the same checks.
    for (const file of ['templates/CLAUDE.md.template', 'templates/AGENTS.md.template']) {
      expect([file, read(file).includes('first check that the main checkout has no uncommitted changes, that main is an ancestor of the feature (`git merge-base --is-ancestor main HEAD`) and that `git push` is usable in the project')]).toEqual([file, true]);
    }
    expect(read('README.md')).toContain('先に main のチェックアウトに未コミットの変更が無いこと・main が feature の祖先であること・`git push` が使えることを確かめ');
    expect(read('shared/documents/harness-upgrade.md')).toContain('`.gitignore` に `.claude/worktrees/`（Claude Code の標準の作業ツリーの置き場所）を足す');
    // cycle 3: the update itself, made in a .claude/worktrees/ worktree, reaches main only after info/exclude covers it.
    expect(read('shared/documents/harness-upgrade.md')).toContain('リモートの無い導入先で `.claude/worktrees/` に作業ツリーがあるときは、更新を統合する前に `"$(git rev-parse --git-common-dir)/info/exclude"` に `.claude/worktrees/` を足す（追跡されず、すべての作業ツリーに効く）');
    expect(workflow).toContain('2. main のチェックアウトに触る前に、次の 3 つを確かめる');
    // The three templates carry the same remote-less sentence (cursorrules included).
    const remoteless = (text) => {
      const from = text.indexOf('Without a remote, with main open in another worktree, integrate from the feature worktree instead');
      const to = text.indexOf('Delete `.quality-check-passed` after any merge into main.', from);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      return text.slice(from, to);
    };
    const sentences = TEMPLATES.map((file) => remoteless(read(file)));
    expect(sentences[0]).toContain('first check that the main checkout has no uncommitted changes, that main is an ancestor of the feature');
    expect(sentences[1]).toBe(sentences[0]);
    expect(sentences[2]).toBe(sentences[0]);
    // implementation-report does not hand the missing quality-check back to the user.
    const report = read('skills/project/implementation-report/SKILL.md');
    expect(report).not.toContain('実行するよう促して処理を中断する');
    expect(report).toContain('レポートを作らずに先に `quality-check` スキルを実行し（AI が実行する。ユーザーに促さない — 前提条件と同じ）、そのレポートでこの手順をやり直す');
    expect(workflow).not.toContain('元に戻してから止まる');
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
    expect(read('shared/documents/development-policy.md')).toMatch(/リモートが無いプロジェクト（または導入先の規則で PR を使わないプロジェクト）では、\(A\)\(B\) とも push・PR 作成を省く/);
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
