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

  test('a deviation found after the flag is recorded like any other and the flag is deleted before asking (#199-1)', () => {
    const policy = read('shared/documents/development-policy.md');
    expect(policy).not.toMatch(/フラグの後に分かった差異は PR 本文にだけ書く/);
    expect(policy).toContain('フラグの後に分かった差異も、同じ記録先（spec / 計画 / 作業メモ）と PR 本文に書き、1 に従って `.quality-check-passed` を削除してから確認する');
    for (const file of ['scripts/skill-overlays/brainstorming/SKILL.md', 'skills/superpowers/brainstorming/SKILL.md']) {
      expect(read(file)).toMatch(/A deviation found after the flag is recorded there and in the PR body too; delete the flag/);
    }
  });

  test('X2 is a release to production; an automatic deploy to staging is not X2 (#199-4)', () => {
    const policy = read('shared/documents/development-policy.md');
    expect(policy).toContain('| X2 | リリース（マージで自動的に本番（客先・利用者に影響する環境）へのリリース・公開・デプロイが起きる場合を含む。動作確認用の環境（staging 等）への自動デプロイは X2 に当たらない）');
    expect(policy).toMatch(/共有環境の変更（staging の環境変数の手作業の変更など）/);
    expect(policy).not.toMatch(/共有環境へのデプロイ/);
    for (const file of TEMPLATES) {
      expect([file, read(file).includes('deploys to production - an environment that customers or users rely on; an automatic deploy to an environment for checking behavior, such as staging, is not X2')]).toEqual([file, true]);
      expect([file, read(file).includes('deploys to a shared environment')]).toEqual([file, false]);
    }
    for (const file of ['scripts/skill-overlays/finishing-a-development-branch/SKILL.md', 'skills/superpowers/finishing-a-development-branch/SKILL.md']) {
      expect(read(file)).toContain('deploys to production - an environment that customers or users rely on (exception X2; an automatic deploy to an environment for checking behavior, such as staging, is not X2)');
    }
    expect(read('shared/documents/harness-upgrade.md')).toMatch(/動作確認用の環境（staging 等）への自動デプロイは X2 に当たらない/);
  });

  test('the OK for a promotion to production covers the whole range, fixed at one SHA (#199-5)', () => {
    const policy = read('shared/documents/development-policy.md');
    expect(policy).toContain('8. **本番への反映の OK の範囲（X2）**');
    expect(policy).toMatch(/聞く前に `git fetch origin` し、反映元（main）の終点の SHA を固定する/);
    expect(policy).toMatch(/反映はその SHA で行う。聞いてから OK までに増えた分と、OK の後に増えた分は含めない/);
    expect(policy).toMatch(/一覧に「この PR（マージ後）」を加える/);
    expect(policy).toMatch(/OK の後のマージ・反映は AI が行う/);
    for (const file of ['scripts/skill-overlays/finishing-a-development-branch/SKILL.md', 'skills/superpowers/finishing-a-development-branch/SKILL.md']) {
      const text = read(file);
      expect(text).toMatch(/the X2 question covers everything that goes out/);
      expect(text).toMatch(/Promote exactly that SHA; anything that lands before or after the OK stays out/);
      expect(text).toContain('add "this PR (after merge)" to the list');
      expect(text).toMatch(/After the OK, the AI merges and promotes/);
    }
  });

  test('without a remote, check that git push is usable before detaching main; otherwise merge where the flag is (#199-3)', () => {
    for (const file of ['scripts/skill-overlays/finishing-a-development-branch/SKILL.md', 'skills/superpowers/finishing-a-development-branch/SKILL.md']) {
      const text = read(file);
      expect(text.indexOf('check that `git push . HEAD:main` is usable')).toBeGreaterThan(-1);
      expect(text.indexOf('check that `git push . HEAD:main` is usable')).toBeLessThan(text.indexOf('run `git switch --detach`'));
      expect(text).toMatch(/if it is not, use the local merge of the `branch-workflow` skill, run where the flag is/);
      expect(text).toMatch(/put both checkouts back/);
    }
    const workflow = read('skills/project/branch-workflow/SKILL.md');
    expect(workflow.indexOf('が使えるかを確かめる')).toBeLessThan(workflow.indexOf('main を開いているチェックアウトで `git switch --detach`'));
    expect(workflow).toContain('**`git push` が使えない場合**');
    expect(workflow).toMatch(/detached のまま残さない/);
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
