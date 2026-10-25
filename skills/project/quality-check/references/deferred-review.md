# quality-check: 後回しのレビューの実行

後回しの Issue（ラベル `deferred-review`）を示してレビューを頼まれたときに読む。後回しの Issue の作り方は [speed-mode.md](speed-mode.md)。

## 後回しのレビューの実行

後回しの Issue（ラベル `deferred-review`）を示してレビューを頼まれたとき:

1. Issue に書いた PR の HEAD（マージのコミットではない。ブランチが消えていれば `git fetch origin pull/<PR 番号>/head`）からブランチ `deferred-review/<Issue 番号>` を作る（`review-budget` の予約はブランチごとなので、ほかの Issue と巡を共有しない）。マージのコミットから作らない（基準のコミットからマージのコミットまでには、その間に trunk に入ったほかの PR の変更が含まれるため）
2. Issue に書いた基準のコミットを基準 ref として（`git diff --name-only <基準のコミット>...HEAD`、`quality-context --base <基準のコミット>`）、その PR の差分だけに Step 1・4 を通常のモードで行い（Step 4 は 1 巡。直す場所は次の手順のブランチなので、このブランチでは確認の巡を回さない）、Step 5 は判定と対象の確定だけを行う（実行しない）。このブランチには何もコミットしない。結果（高・中・Step 5 の対象）を Issue のコメントに一覧で書く
3. 高があるか、Step 5 の対象（`strong` / `recommended`）があれば、今の trunk から作ったブランチ `deferred-fix/<Issue 番号>` で、高を直し、Step 5 の対象を実行する（台帳の更新・撃殺テスト・新規の E2E シナリオ・E2E の失敗の修正もこのブランチにコミットする）。Step 5 の対象は通常の Step 5 と同じ区分（test-recommendation Step 2）に分け、自動実施の区分は確認せずに実行し、確認の区分（共有環境への書き込み・外部への送信・AI が自分で用意できない認証情報が要るもの等）は、通常の Step 5 と同じく PR を作った後の最後の 1 通で示し、返答を受けてから実行する（返答までフラグは作らない）。通常のモードで quality-check を通して PR にする（その quality-check が直した差分を 2 巡まででレビューする）。中は直さない
4. 高と Step 5 の対象が残っていない（`deferred-fix/<Issue 番号>` の PR をマージした、またはどちらも無かった）ら、結果をコメントして Issue を閉じる。`deferred-review/<Issue 番号>` のブランチは消す（何もコミットしていないので失うものは無い）
