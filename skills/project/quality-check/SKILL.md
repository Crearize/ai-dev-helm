---
name: quality-check
description: マージ前に必ず実行。静的チェック・テスト・体制レビュー（変更内容で決まる統合レビュアー＋反証型QA＋専門家最大1体、最大2巡で高の指摘だけを直して確かめる）と追加テスト（test-recommendation）を実施し、通過後のみmainへのマージ・直接pushが可能。指示に「スピード優先」とあれば、レビューと追加テストの実行を後回しの Issue にする。
---

# Quality Check Skill - マージ前品質チェック

導入先の補足ファイル `documents/development/project/quality-check.md` があれば、その段で読む。

この本体には毎回守る規則（流れ・完了条件・止まる場面・どの段でどの参照ファイルを読むか）を置く。各段の手順は、その段に入るときに下の「段ごとに読む参照ファイル」の表のファイルを読んでから行う（覚えている内容で進めない）。

レビュー・品質チェックの規則（優先度の基準、巡の数、検証の巡、スピード優先モード、後回しのレビュー、完了条件、hook の完全な契約）の本文は、このスキル（本体と references）だけに置く。ほかの文書（テンプレート・README・配布文書・他のスキル）は規則の名前とここへの参照だけを持つ。

## 最重要ルール

**hook（quality-gate.cjs）は main 相当への直接 push / merge を止める静的分類器であり、`gh pr merge` / main 上での `git merge` / main への直接 `git push` の前に必ずこのスキルを実行することを強制する。同期 3 形（引数なし `git pull` / 現在トランクへの `git pull origin <trunk>` / `git merge origin/<trunk>`。`master` トランクなら `master` 形）以外は（ゲート対象となる行では）要フラグ。フラグは `commit` のみで判定する（`branch` は診断用）。全チェック通過後のみマージ可能。hook の無条件ブロック・fail-open・worktree 手順の完全な定義は [references/hook-contract.md](references/hook-contract.md)（「hook の完全な契約」）を単一ソースとする — 他ドキュメントはここを参照し、転記しない。**

- **feature ブランチへの `git push` にフラグは不要**（ゲート対象外。refspec に `%` を含む語・`~` で始まる語がある場合を除く（「hook の完全な契約」の「対象」参照）。ゲート語を含むコマンドは「判定する形」に従う）。レビュー前の push・バックアップ push は自由に行える
- CIはビルド確認のみ。静的チェック・テスト・レビューは全てローカルで実施する
- 実行開始時（Step 0 冒頭）に既存の `.quality-check-passed` と `.quality-check-report.json` を削除する（古い許可証・レポートの残留防止）

---

## 実行フロー

```
Step -1: ハーネスのみの変更（ゲートのパラメータ・制御面に当たる差分を除く。定義は「ハーネスのみ変更の免除」節）か判定 → 該当なら終了
  ↓
Step 0: 既存フラグ・レポートの削除（レポート初期化）+ ドキュメント更新の確認（feature-documentation）
  ↓
Step 1: 変更領域の判定 + リスクレベル判定（High/Medium/Low）+ ゲートパラメータ上書きの読み取り
  ↓
┌─ サイクル（上限は quality-policy §5）──────────────────────────────────┐
│ Step 2: 静的チェック = 決定的チェック層（該当領域。修正1パス + 確認1パス）      │
│   ↓                                                                    │
│ Step 3: ユニットテスト（該当領域。失敗は即時修正）+ テスト設計メモとの照合（High/Medium） │
│   ↓                                                                    │
│ Step 4: 体制レビュー（統合レビュアー＋反証型 QA＋専門家最大 1 体。並列。Step 2〜3 の結果を入力に含める。Step 2〜3 に残存があれば実行しない。サイクル2以降は検証レビュアー 1 体） │
│   ↓                                                                    │
│ 統合指摘（Lint 残存・テスト失敗・レビュアー指摘）の対応（直すのは高だけ。中は PR 本文へ）  │
│   ├── 高指摘なし → サイクル終了、Step 5へ                                    │
│   ├── 高が残っている & 上限未満 & 直前と同一の高指摘でない → 次サイクル（Step 2 から） │
│   └── 上限到達 or 停滞 → ユーザー判断（受容 / 方針変更して追加サイクル / 中断）         │
└──────────────────────────────────────────────────────────────────────┘
  ↓
Step 5: 追加テスト（test-recommendation スキルを参照実行）
  ├── ヒューリスティクス判定 → 自動実施 / 確認 / 記録のみ に区分
  ├── 自動実施分を実行（E2E 実行時のサーバー起動・停止を内包）→ 差分をコミット
  ├── 確認の対象があれば PR を作って最後の 1 通で聞き、返答の後に実行・記録
  └── 見送りは記録（非ブロック。E2E を実施して失敗した場合のみ修正必須）
  ↓
Step 6: レポートデータ保存 + フラグファイル作成（設計との差異があれば、その OK の後）→ マージ可能
```

指示に「スピード優先」とあれば、Step 4 のレビュアーの起動と Step 5 の実行を後回しにする（「スピード優先モード」 — [references/speed-mode.md](references/speed-mode.md)）。

## 段ごとに読む参照ファイル

| 段 | 読むファイル | 中身 |
|---|---|---|
| Step -1 | [references/harness-exemption.md](references/harness-exemption.md) | ハーネスのみ変更の免除、リリースの差分の免除、免除しない差分（ゲートパラメータ・ゲート制御面） |
| Step 0・1 | [references/step0-step1.md](references/step0-step1.md) | レポート初期化、ドキュメント更新の確認、変更領域、レビュー体制の決定（起動条件の表）、E2E 用ポート、リスクレベル、ゲートパラメータの上書き |
| Step 2・3 | [references/step2-step3.md](references/step2-step3.md) | 静的チェックと修正手順、`audit:prod`、テスト、テスト設計メモとの照合、リワードハッキングの分担 |
| Step 4 | [references/step4-review.md](references/step4-review.md) | 予約、使用モデル、レビューガイド、役割定義、共通コンテキスト（4-0）、統合（4-2）、中断時の再開（4-2.5）、サイクルと `review_mode`（4-3） |
| Step 4-1 | [references/reviewer-prompts.md](references/reviewer-prompts.md) | レビュアーの指示文の雛形（優先度の基準の写しを含む） |
| Step 4-4 | [references/report-example.md](references/report-example.md) | `.quality-check-report.json` の例（定義はスキーマ） |
| Step 5・6 | [references/step5-step6.md](references/step5-step6.md) | 追加テスト、フラグ作成の前の確認（未追跡の確認を含む）、フラグの性質 |
| push / merge の前、hook に止められたとき | [references/hook-contract.md](references/hook-contract.md) | hook の完全な契約（対象・判定する形・無条件ブロック・通す条件・fail-open・worktree） |
| 指示に「スピード優先」があるとき | [references/speed-mode.md](references/speed-mode.md) | スピード優先モード |
| 後回しの Issue のレビューを頼まれたとき | [references/deferred-review.md](references/deferred-review.md) | 後回しのレビューの実行 |
| 終える前 | [references/checklist.md](references/checklist.md) | チェックリスト |

レポートのフィールドの定義は [`_schemas/quality-check-report.schema.md`](../_schemas/quality-check-report.schema.md)、数値（上限・範囲の上限・バジェット）は `documents/development/quality-policy.md` を正とする（**数値は本スキルに置かない**）。

## Step 4: 体制レビューの基準

### 指摘の優先度（基準）

レビュアーは次の基準で優先度を付ける（「全レビュアー共通の観点」として全テンプレートに転記する。quality-policy §5 はここを参照する）。

| 優先度 | 基準 | 扱い |
|---|---|---|
| 高 | 具体的な入力・手順で起きる誤動作。または次のどれか: 認証・認可、課金・決済、個人情報、セキュリティの脆弱性（秘密情報の露出、既知の脆弱性がある依存、CSP・CORS・セキュリティヘッダの緩和を含む）、データの破損・消失、退行（以前は動いていたものが壊れる）、CI の失敗、受け入れ条件を満たさない。**起きる確率は問わない**。壊れる入力・手順を必ず書く | 直して、確認の巡（`verification`）を回す |
| 中 | テストの不足（重要な経路でも）、文書の古さ・食い違い、条件付きの軽い不具合（高の分類に当たらないもの） | 直さない。PR の本文に一覧で残す（`action: "PR に記録"`） |
| 低 | 好み・書き方・将来の拡張 | 出さない |

- 差分より前からある問題（差分が悪化させていないもの）・Lint 担保済みの項目・好みは指摘しない。差分より前からある問題で高の分類に当たるものだけは「既存（差分外）」と明記して出す（`preexisting: true`。直さずに PR の本文と最後の報告に書き、完了条件・停滞・構造的停滞の数に入れない）
- 前段工程の高（Step 2 の残存違反・Step 3 の失敗テスト）と、共通コンテキストと実差分の不一致（4-1）は、この表によらず高とする

## 完了条件

**統合指摘に高指摘（`preexisting` を除く）が残っておらず、中と既存（差分外）の高を PR の本文に記録し、最低1サイクル完了し、Step 5（追加テスト）の判定を終え、自動実施分を実行し、確認の区分があればその返答（判断）を記録していること。**

**スピードモード**（「スピード優先モード」節）では次を完了条件とする: Step 2〜3 に残存が無い、Step 4-0 の共通コンテキストを作った、Step 5 の判定を終えて後回しの対象を台帳に記録した、後回しの Issue を作り PR にリンクした、レポートに `mode: "speed"` と `deferred_review` を記録した。

どちらのモードでも、上限到達・停滞で打ち切った場合はユーザー承認（`gate_override`）をもって完了とみなす。完了したとき（確認待ちのときも）は、`documents/development/development-policy.md` §1.0「承認後の進め方」の最後の 1 通で終える。本節が quality-check の完了条件の唯一の定義箇所であり、quality-policy §5.5 等からは本節を参照する。

## 途中で止まる場面（例外）

途中で止まるのは `documents/development/development-policy.md` §1.0「承認後の進め方」の例外だけ。このスキルで当たるのは次のとおり（手順は各参照ファイル）:

- X1: レビュー回数の上限到達・停滞・構造的停滞（Step 4-3）。打ち切ったときのフラグは Step 6 の規則に従う
- X3: Step 6 の未追跡の確認で、変更に属さないファイルが前のコミット・push 済みのコミットに入っている、または変更に属するかを決められない
- X5: Step 5 で実施した E2E が、直しても緑にならない（test-recommendation）
- X7: ゲートパラメータの上書きの値が複数のファイルで食い違う（Step 1）

Step 5 の確認の区分と、設計との差異があるときのマージは、途中で区切らず最後の 1 通で扱う（development-policy §1.0）。

---

## 任意: 自己改善候補

`self-improvement` は通常の完了条件ではない。繰り返す問題や明示された改善依頼がある場合に使い、現在のスコープ外の候補は既存の記録先へ残して Step 6 に進む。候補の採否待ちや「候補なし」の記録をフラグ作成の条件にしない。原因が機械処理にある場合は、文章ルールの追加より設定・ラッパー・hook の修正を優先する。
