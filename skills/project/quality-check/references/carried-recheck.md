# 取り込みの再確認（main を取り込んだだけのとき）

前回の quality-check を終えてフラグを作った後に、したことが基準（main）の取り込み（merge・rebase）だけなら、レビューと追加テストをやり直さず、機械チェックだけでフラグを作り直す（3.7.0、#225）。PR 自体の中身が変わっていないことは、決定的な CLI で確かめる（AI が目で比べない）。

## 入り方（Step 0 の削除より前）

1. 前回の `.quality-check-passed` が残っていて、前回のフラグに `gate_override`（打ち切りの承認）が付いていない（`.quality-check-report.json` の `gate_override` が null）ことを確かめる。付いていれば、この道は使わない（通常の quality-check）。
2. 次を実行する（比べるのは前回のフラグ `.quality-check-passed` の `commit`。`--since` で書くときもその commit と同じでなければ判定しない。基準 ref は 4-0 と同じ規則。`--base` で指定できる）:

```bash
npx @crearize/ai-dev-helm quality-context --merge-only
```

- 最後の行が `merge-only: YES`（終了コード 0）のときだけ、この道に入る。前回のフラグとレポートは消さない（Step 0 の削除をしない）。
- `merge-only: NO`（1）または判定でない（2。git が 2.38 より古い・基準 ref が無い・commit が無い・前回のフラグが無い・`--since` が前回のフラグの commit と違う）ときは、通常の quality-check を Step 0 から行う。

判定の中身: 前回のフラグの commit と、今の HEAD が含む基準のコミット（`git merge-base HEAD <基準 ref>`）を `git merge-tree --write-tree` で自動でマージした結果が、衝突なしで、今の HEAD の tree と完全に一致すること。衝突を手で解いた取り込み（PR の行の位置・順序を変えたものを含む）、取り込みの後に足したコミット、バイナリを含むどのファイルの変更も、一致しないので NO になる。

## 行うこと

1. Step 2〜3（ビルド・静的チェック・ユニット / 結合テスト）だけを行う。変更領域とリスクレベルは前回のレポートの値を使う。Step 4（レビュー）と Step 5（追加テストの判定と実行）はやり直さない。review-budget の予約はしない。
2. Step 2〜3 が落ちたら、直す変更で tree が変わるので、この道をやめて通常の quality-check を Step 0 から行う。
3. 通ったら、新しい HEAD でフラグを作り直す。前回のフラグに `mode: "speed"` があれば、同じ `mode` と `deferredReviewIssue` を付け、後回しの Issue の基準のコミットと PR の HEAD を書き直す（[speed-mode.md](speed-mode.md)「後回しの Issue」）。フラグに `carriedFrom: { "commit": "<前回のフラグの commit>", "base": "<基準のコミット>" }` を足す（記録のため。hook は読まない）。
4. レポートに `review_mode: "carried"` のサイクルを足す（`personas: []`。前のサイクルの記録は残す。スキーマ参照）。
5. PR 本文の Flag commit を更新する。PR テンプレートの Quality check cycles は、レビューのサイクル数のまま書き、「取り込みの再確認 N 回」（carried re-checks: N）を添える。この道では、push の前の未追跡の確認（Step 6）は上の CLI の `YES` で代える（tree の一致は、前回のレビューの後に追跡に入ったファイルが無いことも示すため）。

## 残る限界

main 側の変更が、文字としては PR の行と重ならないまま PR の振る舞いを変える場合（呼んでいる関数の仕様が main で変わった等）は、レビューでは見ず、Step 2〜3 の機械チェックだけが拾う。2026-10-25 にオーナーが決めた割り切り。気になる取り込み（main 側で大きな変更が入った等）は、この道を使わずに通常の quality-check を行ってよい。
