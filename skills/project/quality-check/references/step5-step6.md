# quality-check: Step 5・Step 6

本体の Step 5（追加テスト）と Step 6（レポートデータ保存 + フラグファイル作成）に入るときに読む。

## Step 5: 追加テスト（test-recommendation）

サイクル完了後（統合指摘に高が残っていない状態）、`test-recommendation` スキル
（`skills/project/test-recommendation/SKILL.md`）を実行する。判定・提示・実行・台帳・記録の
手順は同スキルを正とし、本スキルには転記しない。

- 判定は 3 区分（自動実施 / 確認 / 記録のみ）。自動実施分は確認せずに実行する。確認の対象があるときは、自動実施分と Step 5 の差分のコミット → `--check-untracked` で未追跡の確認（最初の push の前。Step 6 の手順）→ push → PR 作成の後に、最後の 1 通（`documents/development/development-policy.md` §1.0「承認後の進め方」）で聞き、返答を受けて実行・記録し、同じ PR にコミットし、PR 本文を更新してから Step 6 に進み、フラグを作ったら PR 本文の Flag commit を更新する（返答までフラグは作らない）。返答を受けたら Step 5 の続き（実施と決まったものの実行・記録・同じ PR へのコミット → PR 本文の更新 → Step 6 → PR 本文の Flag commit を更新 → push（その後にマージ）。設計との差異の項目がある場合は、その項目への OK を受けてから Step 6）から再開する。Step 0 からやり直さず、`.quality-check-report.json` も削除しない
- 見送りはフラグ作成をブロックしない（推奨度・根拠・判断と `decided_by` を `.quality-check-report.json` に記録する）
- スピードモードでは判定だけ行い、`strong` / `recommended` の対象は実行せず後回しの Issue に書く（「スピード優先モード」節）
- **E2E を実施して失敗した場合のみ例外**: 実バグとして修正 + 影響範囲のみ再検証（静的チェック・該当テスト・E2E 再実行。サイクルには含めない）を経ないとフラグを作成できない
- 実施したミューテーションの生存への対処（テスト追加 / 台帳持ち越し / 対処不要）はいずれもフラグ作成をブロックしない
- E2E 実行時のサーバー起動・停止（server-startup 参照・実行後必ず停止）はスキル内の手順に従う
- **Step 5 で生じた差分（永続台帳の更新・撃殺テスト・新規 E2E シナリオ・E2E 失敗の修正）は、フラグ作成より前に、パスを指定してコミットする（MUST。`git add -A` / `git commit -a` を使わない — ユーザーの未追跡ファイルや関係の無い変更を巻き込まないため）**（台帳はハーネス免除の対象外のため、フラグ発行後のコミットはフラグを無効化する — Step 6「フラグの性質」参照）

---

## Step 6: レポートデータ保存 + フラグファイル作成

### レポートデータ保存

Step 0 以降の各ステップで蓄積してきた`.quality-check-report.json`に最終結果フィールドを追記する。

### フラグファイル作成

**フラグ作成の前に、Step 5 で生じた差分（永続台帳の更新・撃殺テスト・新規 E2E シナリオ・E2E 失敗の修正）がコミット済みであることを確認する（MUST）**（台帳はハーネス免除の対象外のため、フラグ発行後のコミットはフラグを無効化する — 下記「フラグの性質」）。あわせて、**追跡ファイルに未コミットの変更が無いこと**（`git status --short --untracked-files=no` が空）を確かめる（MUST）。フラグは HEAD を記録するので、未コミットの追跡ファイルの変更は、レビューされても PR に入らない。出たら、変更に属するものはパスを指定してコミットし（レビューの後の変更ならサイクルの規則に従う）、属さないものは消さずにオーナーに確かめる（例外 X3）。未追跡ファイルの扱いは次の確認による。

**その後、フラグ作成の前に、最後のサイクルで未追跡だったファイルが変更に入っていないことを確かめる（MUST）**: `npx @crearize/ai-dev-helm quality-context --check-untracked --cycle <最後のサイクル> --out <scratchpad>/quality-check`（基準 ref は 4-0 と同じ）。この後にコミットを足したら、この確認をやり直す。

**最初の push の前にも同じ確認をする（MUST）**: Step 5 のコミットの後、push・PR 作成より前（development-policy §1.0「承認後の進め方」7 の (A) 差異あり・(B) は push がフラグより前に来る）。push するのは最後の行が `untracked-check: OK` のときだけ。NG の扱いは下と同じ（push 前なので、外す手順が使える）。フラグの前の確認はそのまま行う。

- フラグを作るのは、出力の最後の行が `untracked-check: OK` のときだけ
- 最後の行が `untracked-check: NG` なら、フラグを作らない。出た名前ごとに、変更に属するかを確かめる
  - 属するなら、共通コンテキストを新しいサイクルで作り直してレビューをやり直す（レビューされていないため）
  - 属さない（ユーザーのファイル等）なら、ファイルは消さない。中身は feature の履歴に残り、push すればリモートに上がるので、変更から外す。外したら、もう一度この確認をする
    - まだコミットしていない（ステージしただけ）なら、`git rm --cached -- <名前>` だけでよい
    - まだ push していない直前のコミットに入っているなら、`git rm --cached -- <名前…>` → `git commit --amend --no-edit`。そのコミットが NG に出たファイル（ユーザーのファイル）だけなら（amend は空のコミットになって失敗する）、`git reset --soft HEAD~1` → `git rm --cached -- <名前…>`。push 済みかは、そのコミットが `git log --oneline "@{upstream}..HEAD"` に出るか（upstream が無ければ未 push）で確かめる（引用符は PowerShell 5.1 のため）
    - それより前のコミットに入っている、またはすでに push している場合は、名前を示して止まる（例外 X3）
  - どちらか判断できなければ、名前を示して止まり、オーナーに確かめる（ユーザーのファイルを変更に入れる・外す判断のため。例外 X3）
- 出力が `untracked-check:` で始まらなければ、判定ではない（meta.json が読めない・古い形式、`--check-untracked` を知らない古い CLI 等）。`--out` と CLI の版を直し（`npx -y @crearize/ai-dev-helm@<.ai-dev-helm.json の version> quality-context …`）、実行し直す。そのサイクルの meta.json が無い・古いために context を作り直すなら、新しいサイクルとして作り直し、レビューもやり直す（同じサイクルを作り直すと、レビュー時の未追跡の一覧が失われ、確認を素通りする）

サイクルを打ち切って終了した場合（上限到達・停滞）は、`documents/development/quality-policy.md` §5 に従いユーザーの明示承認なしにフラグを作成しない。承認時は `.quality-check-report.json` の `gate_override` に記録する（スキーマ参照）。

設計との差異（`documents/development/development-policy.md` §1.0「承認後の進め方」 1。spec・計画の記録と PR 本文の差異欄）があるときは、最後の 1 通の「この差異を認めてマージしてよいか」への OK を受けるまでフラグを作成しない。フラグの作成後に差異が見つかった場合は、`.quality-check-passed` を削除してから確認する。差異の記録のコミットでフラグは無効になるので、OK を受けてから、その HEAD で Step 6 を行う（前回のチェックからの差分が記録だけのとき。ほかの変更があれば quality-check をやり直す）。

全チェック通過後、現在ブランチ名と HEAD ハッシュを記録した JSON フラグを作成する：

```bash
node -e "const c=require('child_process'),f=require('fs');const g=a=>c.execSync('git '+a).toString().trim();f.writeFileSync('.quality-check-passed',JSON.stringify({branch:g('branch --show-current'),commit:g('rev-parse HEAD')})+'\n')"
```

PR が既にあるときは、フラグを作った（作り直した）後に PR 本文の Flag commit を更新する。スピードモードのフラグは「スピード優先モード」節のコマンドで作る（このコマンドでは `mode` が抜ける）。

フラグの性質:

- hook はフラグを**消費（削除）しない**。マージ時に「記録コミット以降の差分がハーネスファイルのみか」で有効性を検証する
- 通過後に self-improvement 等で**ハーネスファイルのみを追加修正してもフラグは有効なまま**（再サイクル不要）。ただし**ゲート制御面ファイル**（「ハーネスのみ変更の免除」節のカーブアウト対象）に触れる追加コミットは例外で、フラグを無効化する（hook が `Gate control-plane changed:` でブロックする — 再実行が必要）
- 記録コミット以降に非ハーネスファイルの変更が入るとフラグは無効になり、再実行が必要
- **フラグ発行後に main 側が独立して進んでいた場合**、main 上の `git merge <feature>` は「main をブランチに取り込むか rebase して quality-check をやり直す」と理由を示してブロックされる（取り込む commit とフラグを照合するため。H-11）
- **merge が終わったら `.quality-check-passed` を削除する**（前回のフラグを残さない。hook はファイルに書き込まない）
- `branch` フィールドは診断用であり、hook の判定には使用されない
