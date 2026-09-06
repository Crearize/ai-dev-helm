# .quality-check-report.json Schema

品質チェックスキル (`quality-check`) が出力し、実装レポートスキル (`implementation-report`) が入力として読み取るJSONファイルのスキーマ定義。

## フィールド定義

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `cycles` | `Cycle[]` | 必須 | quality-check サイクル（Step 2 → 3 → 4 → 統合指摘の対応 を1周とする。quality-policy.md §5）の配列 |
| `total_cycles` | `number` | 必須 | 完了したサイクル総数（`cycle_extensions` による追加サイクルを含む） |
| `cycle_abort_reason` | `"cycle_limit" \| "stagnation" \| "structural" \| null` | フェーズ2必須 [^lifecycle] | サイクルの打ち切り事由。`cycle_limit`: サイクル上限到達 / `stagnation`: 直前サイクルと同一の高指摘が再度残った（停滞検出）/ `structural`: 1サイクルで同一クラスの高指摘が閾値以上出た（構造的停滞 — quality-policy §5）。高/中指摘が解消して終了した場合は `null`。ユーザー承認で追加サイクルを実施し最終的に解消した場合も `null`（打ち切りの経緯は `cycle_extensions` に残る） |
| `cycle_extensions` | `CycleExtension[]` | フェーズ2必須 [^lifecycle] | 上限到達・停滞後にユーザー承認で追加サイクルを実施した記録。なければ空配列（§ CycleExtension オブジェクト 参照） |
| `e2e` | `E2E` | 必須 | Step 5（`test-recommendation` スキル）による E2E テストの提案・実行結果（quality-policy.md §2）。旧トップレベル `e2e_result` / `e2e_issues` を置き換える（§ E2E オブジェクト 参照） |
| `documentation` | `Documentation` | 必須 | `feature-documentation` スキルの実行状況（Step 0） |
| `self_improvement` | `SelfImprovement` | 任意 | 自己改善を実施した場合の記録。未実施なら省略でき、完了・通過条件にしない。旧レポートの値は保持する |
| `risk_level` | `"high" \| "medium" \| "low"` | フェーズ2必須 [^lifecycle] | Step 1 で判定したリスクレベル。判定基準は `quality-policy.md` §1、レベル別のゲート強度は同 §2 を参照 |
| `lint_cycles` | `number \| null` | フェーズ2必須 [^lifecycle] | 全サイクルを通じた Step 2 の AI 修正パスの累計（1パス = 静的チェックコマンド（`lint-scaffolding` 導入済みプロダクトでは `lint:all`、未導入では CLAUDE.md に登録されたコマンド）の実行 → AI による修正。各サイクルで最大1パス — quality-policy.md §5）。決定的自動修正のみで完結したパスは含めない。**Step 2 を実行しない領域（docs のみの変更等）では `null`** — `0`（実行したが AI 修正が不要だった）とは区別する。infra のみの変更では Step 2（該当ビルドコマンド）を実行する（`quality-check` SKILL.md 変更領域別ステップ適用テーブル） |
| `lint_abort_reason` | `"oscillation" \| null` | フェーズ2必須 [^lifecycle] | Step 2 の打ち切り事由。`oscillation`: 同一ルール×同一ファイルの違反が確認パスで再発（振動検出 — ルール自体が不適切な可能性）。該当なし、および `lint_cycles` が `null`（Step 2 未実行）の場合は `null`。確認パスで残った違反は統合指摘（高）として `cycles[].findings` に `source: "lint"` で記録する |
| `mutation` | `Mutation` | フェーズ2必須 [^lifecycle] | Step 5（`test-recommendation` スキル）によるミューテーションテストの提案・実行結果（quality-policy.md §2）。詳細は § Mutation オブジェクト を参照 |
| `test_design` | `TestDesign` | フェーズ2必須 [^lifecycle] | Step 3 のテスト設計メモ（`test-design` スキル）との照合結果（quality-policy.md §4）。詳細は § TestDesign オブジェクト を参照 |
| `gate_parameter_overrides` | `GateParameterOverrides \| null` | 必須（発生時） [^lifecycle] | ミューテーションテストの実行時間バジェットを既定値から上書きした場合の記録（quality-policy.md §2「上書きの契約」）。上書きがなければ `null`。**打ち切り承認を記録する `gate_override` とは別物**（詳細は § GateParameterOverrides オブジェクト を参照） |
| `gate_override` | `GateOverride \| null` | 必須（発生時） [^lifecycle] | サイクル上限到達・停滞でサイクルを打ち切ったにもかかわらずユーザーの明示承認のもとで完了扱いとした場合の記録。該当がなければ `null`（quality-policy.md §5「打ち切り時のゲート挙動」/ §6）。**ゲートパラメータの上書きを記録する `gate_parameter_overrides` とは別物** |
| `risk_level_downgrade` | `RiskLevelDowngrade \| null` | 必須（発生時） [^lifecycle] | `test-design` メモの自己判定より低いリスクレベルを Step 1 で採用した場合の記録。該当がなければ `null`（記録なしの引き下げは不可 — `quality-check` SKILL.md Step 1） |
| `_notes` | `string[]` | 任意 | 運用上の観測事実の記録先（ポート占有確認の結果 — #119、サブエージェント中断の時刻と影響 — #120 など）。各要素は記録元のステップを示す `[Step N]` を先頭に付ける（例: `"[Step 1] E2E 用ポート 3000 を他プロジェクトが占有中。Step 5 で停止予定"`）。該当がなければ省略または空配列 |

[^lifecycle]: 「フェーズ2必須」「必須（発生時）」は必須／任意と同じ軸ではなく、**いつから必須になるか**（フィールドのライフサイクル）を併記したもの。「フェーズ2必須」の SKILL.md 側の出力配線はフェーズ2で完了しており、以降に生成されるレポートでは必須。「必須（発生時）」は承認・上書きが発生した場合に必ず記録する（発生しなければ `null`）。

> **移行注記**: フェーズ2の配線完了以前に生成されたレポートに `risk_level` / `lint_cycles` / `lint_abort_reason` / `mutation` / `test_design` が存在しないことは、レポート不正ではなく未配線を意味する。ただし `gate_override` の記録義務は quality-policy.md §5「打ち切り時のゲート挙動」により配線に先行して有効だったため、承認が発生したレポートでは配線前でも記録されている。

> **移行注記（`review_mode` の旧値）**: 旧レポートに残る `review_mode: "staged"` / `"reduced"` は、いずれも現行の `"full"` として読み替える。旧レポートに付随する `diff_line_count`（差分行数による段階化の名残）は無視する。いずれも新規レポートには出力しない。
>
> **移行注記（レビュー体制の再編 #131 以前の語彙）**: 旧レポートの `personas` / `findings[].source` に残る `ソフトウェアアーキテクト` / `統合アーキテクチャレビュー` は `統合レビュアー`（`concern: "design"`）として読み替える。旧レポートの `persona_selection_basis` が `applied` 行 6 行の旧構成でも検証しない。旧レポートの `QA エンジニア（ファルシフィケーション型）`（空白入り）は `QAエンジニア（ファルシフィケーション型）` として読み替える。新規レポートには現行の語彙のみを出力する。

### Cycle オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `cycle_number` | `number` | 必須 | サイクル番号（1始まり） |
| `findings` | `Finding[]` | 必須 | このサイクルで検出された指摘事項。指摘がなければ `[]`。「指摘なし」を severity 付きの行にしない |
| `review_mode` | `"full" \| "verification"` | 任意 | レビュー体制の種別。`full`: Step 1「レビュー体制の決定」による選択（統合レビュアー ＋（コード変更時）QAエンジニア（ファルシフィケーション型）＋（該当時）専門家 1 体）/ `verification`: サイクル2以降、直前サイクルで Step 4 を実行し高/中指摘が出た場合の、検証レビュアー 1 体による修正差分レビュー（`quality-check` SKILL.md 4-3「サイクルと `review_mode`」）。`full` の Step 4 がそのブランチでまだ一度も実行されていない場合（直前サイクルが Step 2〜3 の残存で Step 4 を実行せず終了した場合を含む）、次サイクルは必ず `full` として決定表から選び直す。省略時は `full` 扱い |
| `personas` | `string[]` | 任意 | このサイクルで起動したレビュアー名一覧。値は `quality-check` SKILL.md Step 4「役割定義」の名称（`統合レビュアー` / `QAエンジニア（ファルシフィケーション型）` / `セキュリティエンジニア` / `要件・仕様整合性レビュアー` / `パフォーマンスエンジニア` / `検証レビュアー`）に完全一致させる（`review_mode` が `verification` の場合は必須。`full` で Step 4 を実行したサイクルも必須）。`review_mode` が `verification` で前サイクルの残存指摘が非レビュアー由来のみ（レビュアーの高/中指摘が0件）**かつ前サイクルの修正差分がテスト・フォーマット・セキュリティに無関係な設定のみ（production コード非該当）**の場合に Step 4 をスキップし、検証対象なしとして `personas: []`（空配列）を記録する（ゲート制御面ファイル、セキュリティ起動条件に該当する設定、ハーネス設定ファイル（ゲートパラメータの上書きを含む）、静的チェック・ミューテーション計測範囲・実行時間バジェットを緩める設定に触れる修正差分はこの条件でもスキップ不可 — 検証レビュアー 1 体（セキュリティを重点観点）で検証レビューを行う）。修正差分が production コード（Step 1「コード変更」からテストコードを除いたもの。コメント・空白のみは非該当だが、静的チェック・型チェック・ミューテーション計測の抑止コメントとコメントアウトの解除は production コード該当 — `quality-check` SKILL.md 4-3）に及ぶ場合はスキップせず、検証レビュアー 1 体（セキュリティ・反証を重点観点として明示）で検証レビューを行い、さらに Step 1 のセキュリティエンジニア起動条件に該当する場合は `QAエンジニア（ファルシフィケーション型）` を併走させて両方を記録する（`quality-check` SKILL.md 4-3 を正とする）。Step 2〜3 の残存で Step 4 を実行せず終了したサイクルも `personas: []`（`review_mode: "full"` と組み合わせて「Step 4 未実行」を意味する） |
| `persona_selection_basis` | `{ persona: string, applied: boolean, basis: string }[]` | 任意 | Step 1「レビュー体制の決定」の根拠。統合レビュアー・QAエンジニア（ファルシフィケーション型）・専門家 3 種（セキュリティエンジニア / 要件・仕様整合性レビュアー / パフォーマンスエンジニア）の 5 行全件を含め、`applied: false` の行には理由を `basis` に書く（起動条件に該当したが優先順位で見送った専門家のみ「優先順位により未起動（統合レビュアーの重点観点に昇格）」と書き、該当しない専門家は非該当の理由を書く。QA・専門家の行の `basis` は変更ファイル一覧のパスまたは差分中のシンボルを 1 つ以上引用し、`applied: false` の行は確認した起動条件の項目名を挙げる — 引用も項目名もない一語の `basis` は不可。`quality-check` SKILL.md Step 1「レビュー体制の決定」）。`review_mode: "full"` で Step 4 を実行したサイクルでは必須。`verification`、および Step 4 未実行（`personas: []`）のサイクルでは省略可。**`persona` は `quality-check` SKILL.md Step 4「役割定義」表の名称と完全一致させる**（専門家は括弧内の個別名を用いる）。`applied: true` の行の集合は同サイクルの `personas` と一致しなければならない |
| `notes` | `string[]` | 任意 | サイクル単位の観測事実の記録先。トップレベル `_notes` と同じ `[Step N]` 接頭辞規則に従う（各要素の先頭にそのサイクル内の記録元ステップを示す `[Step N]` を付ける）。該当がなければ省略または空配列 |

### Finding オブジェクト

統合で検出元を失わないよう、新規レポートでは `sources` に全検出者を保存する。`source` は既存ツールとの互換性のため代表値として残す。根拠を確認して採否を裁定し、`action: "対応済"` だけから「実在した欠陥」と推定しない。過去記録の欠落は `unknown` とし、集計では未判定を分母・内訳に明示する。

`ai-dev-helm quality-report --input <report.json>` は正規化結果を標準出力へ返す。元ファイルを変更せず、欠落した検出者の名前や裁定根拠は復元しない。同一箇所というだけで異なる問題を自動統合しない。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `source` | `string` | 必須 | 指摘元。レビュアー名（例: "統合レビュアー"、"セキュリティエンジニア"）、または前段工程を表す固定値 `"lint"`（Step 2 の残存違反）/ `"test"`（Step 3 の失敗テスト）/ `"test_design"`（照合の持ち越し不足分）。レビュアー名は `quality-check` SKILL.md Step 4「役割定義」表の名称と完全一致させる（`persona` と同じ）。ミューテーション・E2E は Step 5（`test-recommendation` スキル）による非ブロックの提案ベース工程であり、quality-check の統合指摘（`cycles[].findings`）には含めない — 結果は `mutation` / `e2e` オブジェクトに記録する |
| `severity` | `"高" \| "中" \| "低"` | 必須 | 優先度 |
| `sources` | `string[]` | 必須（新規） | この問題を検出した全ての元レビュアー・工程。統合時は配列の和集合を取り、代表の `source` も含める。旧記録は存在する情報だけで補う |
| `adjudication` | `"confirmed" \| "false_positive" \| "unknown"` | 任意 | 根拠に照らした裁定。未判定・旧記録の欠落は `unknown`。確認した根拠は既存の `detail` に短く記す |
| `recurrence` | `"new" \| "repeated" \| "unknown"` | 任意 | 新規検出か既出の再掲か。同じ `id` の既出指摘は `repeated`、履歴が不明なら `unknown`。件数だけから推定しない |
| `description` | `string` | 必須 | 指摘内容の概要 |
| `action` | `"対応済" \| "未対応" \| "対象外"` | 必須 | 対応状況 |
| `detail` | `string` | 任意 | 対応の詳細説明 |
| `id` | `string` | 任意 | 指摘の追跡 ID。検証レビュー（`review_mode: "verification"`）で前サイクルの指摘を参照する際に用いる |
| `concern` | `"design" \| "security" \| "performance" \| "requirements" \| "docs" \| "falsification"` | 必須（レビュアー由来の指摘） | 指摘の観点。`source` がレビュアー名の指摘では必須（`source` が `lint` / `test` / `test_design` の指摘では省略する）。統合レビュアーの指摘では観点別セクションから決まる（`design`: 設計・保守性 / `security` / `performance` / `requirements`: 要件整合 / `docs`: 文書整合）。QAエンジニア（ファルシフィケーション型）の指摘は `falsification`、専門家の指摘は各自の観点、検証レビュアーの指摘は元の指摘の観点を引き継ぐ。旧レポートには存在しない |

### E2E オブジェクト

E2E テストは `test-recommendation` スキル（quality-policy.md §2）による**提案ベース**の追加テストであり、通過判定を持たない。唯一の例外は**実施して失敗した場合**で、実バグとして修正必須となる（追加テストで唯一のブロック要素。`quality-check` SKILL.md Step 5 / `test-recommendation` SKILL.md Step 4）。トップレベルの旧 `e2e_result` / `e2e_issues` を置き換える。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `recommendation` | `"strong" \| "recommended" \| "none" \| null` | 必須（判定した場合） | `test-recommendation` スキルの提案ヒューリスティクス判定結果（quality-policy.md §2 / `test-recommendation` SKILL.md Step 1）。判定自体を行っていない場合は `null` |
| `recommendation_basis` | `string[]` | 必須（判定した場合） | 該当したヒューリスティクス項目（判定不能だった事実を含む — `test-recommendation` SKILL.md「判定不能の対象は `recommended` に倒す」）。`recommendation` が `null` の場合は空配列または省略 |
| `user_decision` | `"executed" \| "declined" \| "added_only" \| "not_proposed" \| null` | 必須（判定した場合） | ユーザー判断。`executed`: 少なくとも1つのシナリオ（既存シナリオ経路、または `new_scenarios` の `added_and_run`）の実施を承認 / `declined`: 提示のうえ見送り（`decline_reason` 必須）/ `added_only`: 新規シナリオを追加したが実行は見送り（`result: "skipped"`・`new_scenarios[].decision: "added_only"` と整合させる）/ `not_proposed`: `recommendation` が `none` のため提示せず記録のみ。`recommendation` が `null` の場合は `null` |
| `decline_reason` | `string \| null` | 必須（判定した場合） | 見送り理由。`user_decision` が `"declined"` の場合のみ必須、それ以外は `null` |
| `result` | `"pass" \| "fail" \| "skipped"` | 必須 | E2E テストの結果。`skipped`: `user_decision` が `"declined"` / `"added_only"` / `"not_proposed"`、または `new_scenarios` に `added_and_run` がなく既存シナリオも未実施の場合 / `pass` \| `fail`: 実施したシナリオ（既存シナリオ経路 + `added_and_run` の新規シナリオ）の結果。失敗が残ったまま記録してはならない — 失敗は `test-recommendation` SKILL.md Step 4 の手順で修正し、影響範囲を再検証した上での最終結果を記録する |
| `issues` | `string[]` | 必須 | E2E で検出された問題（実施中に発見し修正したものを含む）。なければ空配列 |
| `new_scenarios` | `NewScenario[]` | 必須 | 新規導線の検出でシナリオを起草した場合の記録（3択の判断を含む。§ NewScenario オブジェクト 参照）。該当がなければ空配列 |

未判定・未提案の場合（`recommendation` が `null`）は `{ "recommendation": null, "recommendation_basis": [], "user_decision": null, "decline_reason": null, "result": "skipped", "issues": [], "new_scenarios": [] }` のように記録する。

### NewScenario オブジェクト

新規導線に対して起草したシナリオ1件と、その3択判断（`test-recommendation` SKILL.md Step 2）を記録する。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `scenario` | `string` | 必須 | 起草したシナリオの概要（対象の導線・画面がわかる表記） |
| `decision` | `"added_and_run" \| "added_only" \| "declined"` | 必須 | ユーザー判断。`added_and_run`: シナリオ追加 + 実行 / `added_only`: シナリオ追加のみ（実行は見送り）/ `declined`: シナリオ追加自体を見送り |

シナリオの見送り理由は永続台帳（`documents/development/test-recommendation-ledger.md`）に記録し、本オブジェクトには含めない（`test-recommendation` SKILL.md 記録節）。

### Documentation オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `status` | `"updated" \| "not_required"` | 必須 | ドキュメント更新の状況。`updated`: 機能ドキュメントを新規作成または更新済み / `not_required`: 純粋な内部リファクタやバグ修正等で対象外と判定 |
| `files` | `string[]` | 必須 | 新規作成または更新したドキュメントファイルのパス一覧（`status` が `not_required` の場合は空配列） |

### SelfImprovement オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `status` | `"applied" \| "skipped" \| "not_required"` | 必須 | 自己改善候補の扱い。`applied`: 承認済み候補を反映（内容修正のうえ適用した `decision: "modified"` を含む）/ `skipped`: 候補はあったがユーザー判断で全件見送り / `not_required`: 候補なし |
| `candidates` | `SelfImprovementCandidate[]` | 必須 | 抽出した改善候補。候補がない場合は空配列 |

### SelfImprovementCandidate オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `title` | `string` | 必須 | 改善候補のタイトル |
| `target_files` | `string[]` | 必須 | 反映先候補または実際に反映したファイル |
| `decision` | `"applied" \| "skipped" \| "modified"` | 必須 | ユーザー判断と適用結果 |
| `reason` | `string` | 必須 | 候補化した根拠、または見送り理由 |

### Mutation オブジェクト

ミューテーションテストは `test-recommendation` スキル（quality-policy.md §2）による**提案ベース**の追加テストであり、通過判定を持たない。実施の見送り・実施後の生存ミュータントは**記録のみ・非ブロック**である（quality-policy.md §2 / §6）。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `executed` | `boolean` | 必須 | ミューテーションテストの実行を開始し、計測（部分結果を含む）が得られたか |
| `reason` | `"not_configured" \| "out_of_scope" \| "empty_scope" \| "scope_error" \| "tool_error" \| null` | 必須 | **判定・実行そのものが不能だった理由に限る**（ユーザーが見送った・提示されなかった事実は `reason` ではなく `user_decision` 側で表現する）。`not_configured`: プロダクトにミューテーションテスト設定（Stryker / PIT）が存在せず提案自体を行わない / `out_of_scope`: 変更領域別ステップ適用テーブルで Step 3（ユニットテスト）が `-` の領域のため対象外（quality-policy.md §2 マトリクス優先順位原則）/ `empty_scope`: 差分スコープが空（変更が除外対象のみ・production クラスの変更なし・実行結果のミュータント数 0。正規シグナルは差分実行の終了コード 0 + 明示メッセージ）/ `scope_error`: 差分スコープの導出失敗（ベース ref 未解決等で差分実行が**非 0 終了** — `empty_scope` と記録してはならない。quality-policy.md §2「空スコープと導出失敗の区別」）/ `tool_error`: 実施を承認したがツールが起動できず、計測が一切得られなかった（`test-recommendation` SKILL.md「実行の失敗」）。`not_configured` / `out_of_scope` はヒューリスティクス判定自体を行わないため `recommendation` 以下のキーを省略する最小表現になる（下記）。`empty_scope` / `scope_error` / `tool_error` はユーザー承認を得て実行を試みた（`user_decision: "executed"`）が計測が得られなかった場合に記録する。`executed` が `true`、または `user_decision` が `"declined"` / `"not_proposed"` の場合は `null` |
| `recommendation` | `"strong" \| "recommended" \| "none" \| null` | 必須（判定した場合） | `test-recommendation` スキルの提案ヒューリスティクス判定結果（quality-policy.md §2 / `test-recommendation` SKILL.md Step 1）。`not_configured` / `out_of_scope` で判定自体を行っていない場合は `null` |
| `recommendation_basis` | `string[]` | 必須（判定した場合） | 該当したヒューリスティクス項目（判定不能だった事実を含む — `test-recommendation` SKILL.md「判定不能の対象は `recommended` に倒す」）。`recommendation` が `null` の場合は空配列または省略 |
| `user_decision` | `"executed" \| "declined" \| "not_proposed" \| null` | 必須（判定した場合） | ユーザー判断。`executed`: 実施を承認（結果が `empty_scope` / `scope_error` になった場合を含む）/ `declined`: 提示のうえ見送り（`decline_reason` 必須）/ `not_proposed`: `recommendation` が `none` のため提示せず記録のみ。`recommendation` が `null` の場合は `null` |
| `decline_reason` | `string \| null` | 必須（判定した場合） | 見送り理由。`user_decision` が `"declined"` の場合のみ必須、それ以外は `null` |
| `scope` | `"changed_lines" \| "changed_classes" \| "changed_files"` | 任意 | 差分スコープの粒度。`changed_lines`: Stryker の変更行スコープ / `changed_classes`: PIT の変更クラススコープ / `changed_files`: 旧配線のままファイル単位で実行した場合の暫定値 — 計測結果の解釈に使ってはならない（quality-policy.md §2「差分スコープの定義」）。`executed` が `true` の場合は必須 |
| `base_ref` | `string` | 任意 | 差分スコープの基準 ref（既定 `origin/main`。Step 1 の差分判定と同一でなければならない。`HEAD` は Step 1 の基幹になり得ないため無効 — 作業ツリーのみを測った実行は `executed` として記録しない）。`executed` が `true` の場合は必須 |
| `mutants_total` | `number` | 任意 | スコープ内で生成・実行されたミュータント数。集計外 status（`Ignored`・`CompileError` 等 — quality-policy.md §2「ツール status との対応」）は含めない。`executed` が `true` の場合は必須 |
| `score_raw` | `number` | 任意 | ツール算出スコア（%、参考情報）。**最後の実行の値**を記録する（再計測を含む。`runs` と整合）。killed / 生存 / 集計外の status 対応は quality-policy.md §2「ツール status との対応」を正とする（`NoCoverage` は生存）。判定には用いない。`executed` が `true` の場合は必須 |
| `runs` | `number` | 任意 | Step 5 内での再計測を含む実行回数（初回計測 + 縮退再試行 + 撃殺テスト追加後の再計測。上限は `test-recommendation` SKILL.md「実行回数の上限」）。本オブジェクトの `score_raw` 等は**最後の実行**の値、`survivors` は最終状態を記録する。`executed` が `true` の場合は必須 |
| `survivors` | `Survivor[]` | 任意 | 生存したミュータントの台帳（quality-policy.md §2）。生存がなければ空配列。`executed` が `true` の場合は必須 |
| `scope_reduced` | `boolean` | 任意 | 実行時間バジェット（quality-policy.md §2「ミューテーションテストの実行時間バジェット」の既定値。`gate_parameter_overrides` の `mutation_budget_minutes` で上書き可 — 下記「上書きの契約」注記を参照）超過により、リスクの高いファイル優先で対象を絞ったか。`executed` が `true` の場合は必須 |
| `aborted_reason` | `"unmeasurable_within_budget" \| null` | 任意 | 縮退再試行後も実行時間バジェット内で完走できなかった場合の正規 outcome（quality-policy.md §2「ミューテーションテストの実行時間バジェット」。非ブロック。途中結果を記録）。完走した場合は `null`。`executed` が `true` の場合は必須 |
| `incremental` | `boolean` | 任意 | **最後の実行**が前回のキャッシュを再利用した計測か（Stryker: `MUTATION_INCREMENTAL=1` で実行し stderr に `[mutation:diff] incremental: reusing the diff cache` が出た場合 `true`。`starting the diff cache`・`disabled for this run`（前回キャッシュを削除できずキャッシュ無しで実行）やフラグなしの実行は `false`。PIT: `historyInputLocation` を用いた場合 `true`）。キャッシュ再利用は計測を弱め得るスイッチであり環境変数のため差分に残らないので、`score_raw` の解釈に必要な事実としてここに残す。`executed` が `true` の場合は必須 |

**未実行時の表現はキーの省略に一本化し、`null` は置かない**（`reason` / `aborted_reason` の `null` は「該当なし」を表す別の意味である）。mutation は判定自体が行われないケース（`out_of_scope` / `not_configured`）があるためキー省略で最小化する。e2e は判定が常に走るため全キーを常在させ `null` を用いる（意図的な非対称）。

- **判定・実行そのものが不能**（`reason` が `not_configured` / `out_of_scope`）: `{ "executed": false, "reason": "not_configured" }` のように `executed` と `reason` のみを記録する（`recommendation` 以下のキーは**省略**する — ヒューリスティクス判定自体を行っていないため）。
- **提示のうえ見送り、または `none` のため未提示**（`user_decision` が `"declined"` / `"not_proposed"`）: `executed: false`・`reason: null` とし、`recommendation` / `recommendation_basis` / `user_decision`（`"declined"` の場合は `decline_reason` も）を記録する。実行時フィールド（`scope` 以下）は省略する。
- **実施を承認したが計測が一切得られなかった**（`reason` が `empty_scope` / `scope_error` / `tool_error`）: `executed: false` とし、`recommendation` / `recommendation_basis` / `user_decision: "executed"` を記録する。実行時フィールドは省略してよい。
- **承認して実行したがバジェット内に完走しなかった（部分結果あり）**: `executed: true`・`aborted_reason: "unmeasurable_within_budget"` とし、部分結果（`score_raw` 等）と台帳（`survivors`）を記録する。計測が一切得られなかった場合はこのケースではなく `executed: false` / `reason: "tool_error"` を記録する。
- **実行が完了した**（`executed: true`）: `reason: null` とし、`recommendation` / `recommendation_basis` / `user_decision: "executed"` と実行時フィールド（`scope` 以下）を記録する。

トリアージ・対処範囲（その場でテスト追加 / 台帳に持ち越し / 対処不要）の合意は quality-policy.md §2 および `test-recommendation` SKILL.md を正とする。**通過判定はなく、いずれの選択もフラグ作成をブロックしない。**

> **上書きの契約**（quality-policy.md §2）: 実行時間バジェットの既定値からの上書きは `gate_parameter_overrides`（トップレベル、§ GateParameterOverrides オブジェクト 参照）に記録する。ハーネス設定ファイルに上書きの記載がなければ quality-policy.md の既定値が適用される。

### Survivor オブジェクト

生存したミュータント1件の記録（`mutation.survivors`）。トリアージに通過判定はなく、対処範囲はユーザーと合意する（quality-policy.md §2 / `test-recommendation` SKILL.md）。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `mutant` | `string` | 必須 | ミュータントの識別（ファイル・行・変異内容がわかる表記） |
| `decision` | `"killed" \| "equivalent" \| "accepted" \| "unresolved" \| "untriaged" \| "tool_false_negative"` | 必須 | トリアージの決定（値の意味の定義は quality-policy.md §2、判定手続き — red-green 検証の手順・`equivalent` の判定基準の詳細・`tool_false_negative` の機械判定条件 — は `test-recommendation` SKILL.md「トリアージ規律」を正とする）。`killed`: red-green 検証を経て、追加したテストが検出できるようになったことを確認した変異 / `equivalent`: 動作が変わらない変異（判断根拠を1件ずつ記録する）/ `accepted`: 振る舞いに影響しないことが確認できる変異（`category` 必須）/ `unresolved`: 振る舞いに影響するがテストによる検出に至らなかった変異（台帳に持ち越し可） / `untriaged`: 未判断のまま台帳に持ち越し可（非ブロック）/ `tool_false_negative`: ツール偽陰性。`score_raw` はツール算出の生値でありこれを含む。件数を台帳に明示し、スコアの解釈時に差し引いて読む |
| `category` | `"logging" \| "defensive_guard" \| "type_only" \| "ui_text" \| "dev_only" \| null` | 必須 | `decision` が `accepted` のときのカテゴリ（閉集合）。それ以外は `null` |
| `reason` | `string` | 必須 | 判断の理由（`untriaged` / `tool_false_negative` では空文字でよい） |
| `memo_linked` | `boolean` | 必須 | テスト設計メモの「保証すべき状態遷移・不変条件」「ファルシフィケーション項目」に対応する変更行のミュータントか。`true` の生存は対処提案の優先度を上げる（quality-policy.md §2） |

### TestDesign オブジェクト

High / Medium リスクの変更では、実装前に `test-design` スキルでテスト設計メモを作成し、Step 3 でテストと照合する（quality-policy.md §4）。その照合結果を記録する。`verified` を名乗れるのは、メモの作成が対象実装の最初のコミットより前であることを確認できた場合のみで、確認できないときは `retroactive` に倒す。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `status` | `"verified" \| "retroactive" \| "out_of_scope" \| "not_required"` | 必須 | 照合結果の種別。`verified`: 実装前に作成済みのメモとテストを Step 3 で照合し充足を確認 / `retroactive`: メモが存在せず Step 3 で `test-design` を遡及実行し、洗い出した不足テストを補完 / `out_of_scope`: 変更領域別ステップ適用テーブルで Step 3 が `-` の領域のため対象外（quality-policy.md §2 マトリクス優先順位原則）/ `not_required`: Low リスクの変更のため不要 |
| `memo_path` | `string \| null` | 必須 | テスト設計メモのパス（`docs/superpowers/plans/*-test-design.md` のグロブで発見される命名規則。`test-design` スキルの仕様）。`status` が `verified` / `retroactive` の場合は必須。`out_of_scope` / `not_required` では `null` |
| `gaps_addressed` | `number` | 必須 | 照合・遡及実行で洗い出し補完した不足テストの件数。不足がなければ `0`。`out_of_scope` / `not_required` では `0` |

### GateParameterOverrides オブジェクト

quality-policy.md §2「上書きの契約」に基づき、プロダクトのハーネス設定ファイル（`CLAUDE.md` / `AGENTS.md` / `.cursorrules` の `### Quality Gate Overrides` ブロック）でミューテーションテストの実行時間バジェットを既定値から上書きした場合に、その事実と理由を記録する。上書きがなければトップレベル `gate_parameter_overrides` を `null` にする。HTML コメント（`<!-- -->`）の内側やコードスパン・コードフェンス内に置かれた `### Quality Gate Overrides` ブロックは宣言とみなさない（無効。既定値が適用され、本オブジェクトには記録しない）。

**サイクル打ち切りをユーザー承認のもとで通過させた記録である `gate_override` とは別物。** 本オブジェクトは「既定パラメータを変更して運用している」事実の記録であり、承認の有無を問わない。サイクルの打ち切りを承認した場合の記録は `gate_override` を参照。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `mutation_budget_minutes` | `number \| null` | 必須 | ミューテーションテストの実行時間バジェットの上書き値（分）。上書きしていない場合は `null`（quality-policy.md の既定値が適用される） |
| `reason` | `string` | 必須 | 上書きの理由 |

キー名はハーネス設定ファイルの `### Quality Gate Overrides` 記法（`mutation_budget_minutes`）と一致させる。上書きキーはこの1つのみとする（quality-policy.md §2「上書きの契約」— `mutation_threshold_high` / `mutation_threshold_medium` / `mutation_mode_medium` はゲートが存在しないため廃止）。

### CycleExtension オブジェクト

サイクル上限到達または停滞でユーザーに判断を仰ぎ、**方針を変えて追加サイクルを実施する**選択がなされた場合にのみ記録する（quality-policy.md §5）。方針の変更を伴わない再実行は認めない（同じ手を繰り返しても収束しないため）。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `after_cycle` | `number` | 必須 | 打ち切り時点のサイクル番号（この番号の次から追加サイクルが始まる） |
| `abort_reason` | `"cycle_limit" \| "stagnation"` | 必須 | 打ち切りの事由 |
| `approach_change` | `string` | 必須 | 追加サイクルで変更する方針（ユーザーが示した内容をそのまま記録する。例: 「生存ミュータントのうち境界値系は accepted に分類し、状態遷移のテストに集中する」） |

### RiskLevelDowngrade オブジェクト

`test-design` メモ冒頭の自己判定レベルより低いレベルを Step 1 の実差分判定で採用した場合にのみ記録する（`quality-check` SKILL.md Step 1「リスクレベル判定」）。該当がなければトップレベル `risk_level_downgrade` を `null` にする。引き下げはゲート強度そのものを弱める操作であるため、`gate_parameter_overrides` と同様に必ず追跡可能にする。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `memo_level` | `"high" \| "medium"` | 必須 | テスト設計メモ冒頭に記録された自己判定レベル |
| `adopted_level` | `"medium" \| "low"` | 必須 | Step 1 の実差分判定で採用したレベル（= `risk_level` と一致する） |
| `reason` | `string` | 必須 | 引き下げの根拠（実差分のどの点が quality-policy.md §1 のどの基準に照らして低いと判断したか） |

### GateOverride オブジェクト

サイクル上限到達・停滞でサイクルを打ち切ったにもかかわらずユーザー承認のもとで `.quality-check-passed` を作成した場合にのみ記録する（quality-policy.md §5「打ち切り時のゲート挙動」）。該当がなければトップレベル `gate_override` を `null` にする。

**このオブジェクトの存在自体が「ユーザーの明示承認を得た」ことの記録である。** 承認を得ていない状態で本オブジェクトを記録してはならず、そのとき `.quality-check-passed` も作成しない（承認の有無を表す真偽値フィールドは持たない — `null` か、承認済みオブジェクトが存在するかの二値で表現する）。**ゲートパラメータの上書き（実行時間バジェットの変更）を記録する `gate_parameter_overrides` とは別物**（上書きの運用自体はユーザー承認の有無を問わない。§ GateParameterOverrides オブジェクト 参照）。

ミューテーション・E2E は Step 5（`test-recommendation` スキル）による提案ベースの非ブロック工程であり通過判定を持たないため、本オブジェクトの対象は quality-check の**サイクル打ち切り承認**（quality-policy.md §5）に限られる。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `abort_reasons` | `("cycle_limit" \| "stagnation" \| "structural")[]` | 必須 | 承認対象となったサイクル打ち切りの事由（`cycle_abort_reason` と同一の事由を記録する。通常は要素数1） |
| `reason` | `string` | 必須 | 承認の理由（ユーザーが示した判断根拠をそのまま記録する） |

```json
{
  "gate_override": {
    "abort_reasons": ["stagnation"],
    "reason": "直前サイクルと同一の高指摘（境界値未検証の再発）が残ったが、影響範囲が限定的であることを確認したため受容（ユーザー承認）"
  }
}
```

## JSON 例

### 基本例（フェーズ2の配線前）

```json
{
  "cycles": [
    {
      "cycle_number": 1,
      "findings": [
        {
          "source": "統合レビュアー",
          "sources": ["統合レビュアー"],
          "concern": "security",
          "severity": "高",
          "description": "SQLインジェクション対策確認",
          "action": "対応済",
          "detail": "バインドパラメータ使用を確認"
        }
      ]
    }
  ],
  "total_cycles": 2,
  "cycle_abort_reason": null,
  "cycle_extensions": [],
  "e2e": {
    "recommendation": "none",
    "recommendation_basis": ["バックエンドのみの変更"],
    "user_decision": "not_proposed",
    "decline_reason": null,
    "result": "skipped",
    "issues": [],
    "new_scenarios": []
  },
  "documentation": {
    "status": "updated",
    "files": ["documents/features/user-authentication.md"]
  },
  "self_improvement": {
    "status": "applied",
    "candidates": [
      {
        "title": "サーバー停止確認を必須化",
        "target_files": ["skills/project/server-startup/SKILL.md"],
        "decision": "applied",
        "reason": "E2E後の停止確認が曖昧だったため"
      }
    ]
  }
}
```

### 完全例（リスクレベル・テスト設計照合・ミューテーション/E2E 提案・上書き記録を含む）

High リスクの backend 変更で、`test-recommendation` スキル（Step 5）がミューテーションテストを `strong` 推奨として提示し、ユーザーが実施を承認したケース。生存5件のうちメモ紐付きの1件を追加テストで撃殺（`killed`。再計測により killed 10 → 11 となり、`score_raw: 73.3` は最後の実行の値・`runs: 2`）、2件を `accepted`、1件を `unresolved`、1件を `tool_false_negative` としてトリアージした（通過判定なし・非ブロック）。E2E は既存シナリオ経路の変更に該当し `strong` 推奨で実施・合格。ミューテーションの実行時間バジェットを既定値から上書きしたケース。全フィールドを含む。

```json
{
  "cycles": [
    {
      "cycle_number": 1,
      "review_mode": "full",
      "personas": ["統合レビュアー", "QAエンジニア（ファルシフィケーション型）", "セキュリティエンジニア"],
      "persona_selection_basis": [
        { "persona": "統合レビュアー", "applied": true, "basis": "常に起動" },
        { "persona": "QAエンジニア（ファルシフィケーション型）", "applied": true, "basis": "コード変更を含む（backend/src/main/java/.../AuthService.java とそのテスト）" },
        { "persona": "セキュリティエンジニア", "applied": true, "basis": "認証・認可・入力処理の変更を含む（優先 1）" },
        { "persona": "要件・仕様整合性レビュアー", "applied": false, "basis": "優先順位により未起動（統合レビュアーの重点観点に昇格）" },
        { "persona": "パフォーマンスエンジニア", "applied": false, "basis": "起動条件（クエリ・ループ・キャッシュ・バンドル・高頻度経路）に該当するパスなし（変更ファイル一覧を確認）" }
      ],
      "findings": [
        {
          "id": "cycle1-qa-01",
          "source": "QAエンジニア（ファルシフィケーション型）",
          "sources": ["QAエンジニア（ファルシフィケーション型）"],
          "concern": "falsification",
          "severity": "中",
          "description": "失効済みトークンでの更新拒否を証明する入力が未検証",
          "action": "対応済",
          "detail": "期限切れトークンでのリフレッシュ拒否テストを追加"
        }
      ]
    }
  ],
  "total_cycles": 1,
  "cycle_abort_reason": null,
  "cycle_extensions": [],
  "e2e": {
    "recommendation": "strong",
    "recommendation_basis": ["既存 E2E シナリオの通過経路（画面・ルート・導線）に触れるフロント変更"],
    "user_decision": "executed",
    "decline_reason": null,
    "result": "pass",
    "issues": [],
    "new_scenarios": []
  },
  "documentation": {
    "status": "updated",
    "files": ["documents/features/user-authentication.md"]
  },
  "self_improvement": {
    "status": "not_required",
    "candidates": []
  },
  "risk_level": "high",
  "lint_cycles": 1,
  "lint_abort_reason": null,
  "test_design": {
    "status": "verified",
    "memo_path": "docs/superpowers/plans/2026-08-12-user-authentication-test-design.md",
    "gaps_addressed": 0
  },
  "mutation": {
    "executed": true,
    "reason": null,
    "recommendation": "strong",
    "recommendation_basis": ["High リスク領域の中核ロジックのまとまった実装差分（認証・認可）"],
    "user_decision": "executed",
    "decline_reason": null,
    "scope": "changed_lines",
    "base_ref": "origin/main",
    "mutants_total": 15,
    "score_raw": 73.3,
    "runs": 2,
    "survivors": [
      {
        "mutant": "backend/src/auth/token.service.ts:52（`expiresAt <= now` → `<`）",
        "decision": "killed",
        "category": null,
        "reason": "失効境界のテストを追加し red-green 検証を実施（メモ §2 不変条件「失効時刻ちょうどのトークンは拒否」）",
        "memo_linked": true
      },
      {
        "mutant": "backend/src/auth/token.service.ts:48（ログ分岐の条件反転）",
        "decision": "accepted",
        "category": "logging",
        "reason": "ログ出力のみに影響する分岐で外部から観測可能な挙動が変わらないため",
        "memo_linked": false
      },
      {
        "mutant": "backend/src/auth/token.service.ts:61（`if (!payload)` の除去）",
        "decision": "accepted",
        "category": "defensive_guard",
        "reason": "呼び出し元で検証済みの値で、契約上 null は到達しない",
        "memo_linked": false
      },
      {
        "mutant": "backend/src/auth/token.service.ts:77（リトライ回数 `3` → `4`）",
        "decision": "unresolved",
        "category": null,
        "reason": "外部 IdP のリトライ回数は契約テストの整備（#123）が必要で、今回は検出テストを書けなかったため台帳に持ち越し",
        "memo_linked": false
      },
      {
        "mutant": "backend/src/auth/token.service.ts:90（`static` 初期化子の比較演算子反転）",
        "decision": "tool_false_negative",
        "category": null,
        "reason": "Stryker が `static: true` の Survived として機械分類（`score_raw` に含まれる生値 — 解釈時に差し引いて読む）",
        "memo_linked": false
      }
    ],
    "scope_reduced": false,
    "aborted_reason": null
  },
  "gate_parameter_overrides": {
    "mutation_budget_minutes": 20,
    "reason": "認証まわりの差分規模が大きく、既定値ではドライラン段階でバジェット超過が見込まれたため延長"
  },
  "gate_override": null,
  "risk_level_downgrade": null
}
```
