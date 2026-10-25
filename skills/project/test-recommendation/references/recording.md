# test-recommendation: 記録

本体の Step 5（記録）で読む。

## 記録

### quality-check から実行された場合（Step 5）

`.quality-check-report.json` の `mutation` / `e2e` オブジェクトに記録する。**フィールド定義は [`_schemas/quality-check-report.schema.md`](../../_schemas/quality-check-report.schema.md) を正とする**（値の閉集合・必須性はスキーマに従う）。

| オブジェクト | 内容 |
|---|---|
| `mutation` | `recommendation`（`strong` / `recommended` / `none`）/ `recommendation_basis`（該当ヒューリスティクス項目。判定不能の事実・確認の区分にした理由を含む）/ `user_decision`（`executed` / `declined` / `not_proposed` / `deferred`。自動実施を含む。`deferred` はスピードモードの後回し）/ `decided_by`（`auto` / `user`）/ `decline_reason`。実行時は `scope` / `base_ref` / `mutants_total` / `score_raw` / `survivors` / `incremental`（最後の実行がキャッシュを再利用したか）等の実行時フィールドを併せて記録する（実行モード・スコア基準等の旧キーは廃止 — 記録しない） |
| `e2e` | `recommendation` / `recommendation_basis` / `user_decision` / `decided_by` / `result` / `issues` / `new_scenarios`（起草したシナリオと 3 択の判断）。旧トップレベルの `e2e_result` / `e2e_issues` を置き換える |

- 推奨度 `none` の対象も判定結果を記録する（`recommendation` / `recommendation_basis`、`user_decision: "not_proposed"`）
- スピードモードで後回しにした対象は `user_decision: "deferred"`・`decided_by: "user"`（e2e は `result: "skipped"`、mutation は `executed: false`・`reason: null`）を記録する
- 新規導線で「シナリオ追加のみ（実行見送り）」を選んだ場合は `e2e.user_decision: "added_only"`・`e2e.result: "skipped"`・`new_scenarios[].decision: "added_only"` を記録する

### 単体実行時

**`.quality-check-report.json` には触れない**（レポートは quality-check の実行単位のため）。実行結果・判断は永続台帳とセッション出力に記録する。
