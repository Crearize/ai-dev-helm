# .quality-check-report.json Schema

品質チェックスキル (`quality-check`) が出力し、実装レポートスキル (`implementation-report`) が入力として読み取るJSONファイルのスキーマ定義。

## フィールド定義

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `cycles` | `Cycle[]` | 必須 | quality-check サイクル（Step 2 → 3 → 3.5 → 4 → 統合指摘の対応 を1周とする。quality-policy.md §5）の配列 |
| `total_cycles` | `number` | 必須 | 完了したサイクル総数（`cycle_extensions` による追加サイクルを含む） |
| `cycle_abort_reason` | `"cycle_limit" \| "stagnation" \| null` | フェーズ2必須 [^lifecycle] | サイクルの打ち切り事由。`cycle_limit`: サイクル上限到達 / `stagnation`: 直前サイクルと同一の高指摘が再度残った（停滞検出）。高/中指摘と未達ゲートが解消して終了した場合は `null`。ユーザー承認で追加サイクルを実施し最終的に解消した場合も `null`（打ち切りの経緯は `cycle_extensions` に残る） |
| `cycle_extensions` | `CycleExtension[]` | フェーズ2必須 [^lifecycle] | 上限到達・停滞後にユーザー承認で追加サイクルを実施した記録。なければ空配列（§ CycleExtension オブジェクト 参照） |
| `e2e_result` | `"pass" \| "fail" \| "skipped"` | 必須 | E2Eテスト結果 |
| `e2e_issues` | `string[]` | 必須 | E2Eで検出された問題（なければ空配列） |
| `documentation` | `Documentation` | 必須 | `feature-documentation` スキルの実行状況（Step 0） |
| `self_improvement` | `SelfImprovement` | 必須 | `self-improvement` スキルの実行状況（Step 5.75） |
| `risk_level` | `"high" \| "medium" \| "low"` | フェーズ2必須 [^lifecycle] | Step 1 で判定したリスクレベル。判定基準は `quality-policy.md` §1、レベル別のゲート強度は同 §2 を参照 |
| `lint_cycles` | `number \| null` | フェーズ2必須 [^lifecycle] | 全サイクルを通じた Step 2 の AI 修正パスの累計（1パス = 静的チェックコマンド（`lint-scaffolding` 導入済みプロダクトでは `lint:all`、未導入では CLAUDE.md に登録されたコマンド）の実行 → AI による修正。各サイクルで最大1パス — quality-policy.md §5）。決定的自動修正のみで完結したパスは含めない。**Step 2 を実行しない領域（docs のみの変更等）では `null`** — `0`（実行したが AI 修正が不要だった）とは区別する。infra のみの変更では Step 2（該当ビルドコマンド）を実行する（`quality-check` SKILL.md 変更領域別ステップ適用テーブル） |
| `lint_abort_reason` | `"oscillation" \| null` | フェーズ2必須 [^lifecycle] | Step 2 の打ち切り事由。`oscillation`: 同一ルール×同一ファイルの違反が確認パスで再発（振動検出 — ルール自体が不適切な可能性）。該当なし、および `lint_cycles` が `null`（Step 2 未実行）の場合は `null`。確認パスで残った違反は統合指摘（高）として `cycles[].findings` に `source: "lint"` で記録する |
| `mutation` | `Mutation` | フェーズ2必須 [^lifecycle] | Step 3.5 ミューテーションテストの実行結果 |
| `test_design` | `TestDesign` | フェーズ2必須 [^lifecycle] | Step 3 のテスト設計メモ（`test-design` スキル）との照合結果（quality-policy.md §4）。詳細は § TestDesign オブジェクト を参照 |
| `gate_parameter_overrides` | `GateParameterOverrides \| null` | 必須（発生時） [^lifecycle] | ゲートパラメータ（ミューテーション閾値・実行時間バジェット・Medium の実行モード）を既定値から上書きした場合の記録（quality-policy.md §2「上書きの契約」）。上書きがなければ `null`。**打ち切り承認を記録する `gate_override` とは別物**（詳細は § GateParameterOverrides オブジェクト を参照） |
| `gate_override` | `GateOverride \| null` | 必須（発生時） [^lifecycle] | 打ち切り・閾値未達で終了した工程をユーザーの明示承認のもとで通した場合の記録。該当がなければ `null`（quality-policy.md §5「打ち切り時のゲート挙動」/ §6）。**ゲートパラメータの上書きを記録する `gate_parameter_overrides` とは別物** |
| `risk_level_downgrade` | `RiskLevelDowngrade \| null` | 必須（発生時） [^lifecycle] | `test-design` メモの自己判定より低いリスクレベルを Step 1 で採用した場合の記録。該当がなければ `null`（記録なしの引き下げは不可 — `quality-check` SKILL.md Step 1） |

[^lifecycle]: 「フェーズ2必須」「必須（発生時）」は必須／任意と同じ軸ではなく、**いつから必須になるか**（フィールドのライフサイクル）を併記したもの。「フェーズ2必須」の SKILL.md 側の出力配線はフェーズ2で完了しており、以降に生成されるレポートでは必須。「必須（発生時）」は承認・上書きが発生した場合に必ず記録する（発生しなければ `null`）。

> **移行注記**: フェーズ2の配線完了以前に生成されたレポートに `risk_level` / `lint_cycles` / `lint_abort_reason` / `mutation` / `test_design` が存在しないことは、レポート不正ではなく未配線を意味する。ただし `gate_override` の記録義務は quality-policy.md §5「打ち切り時のゲート挙動」により配線に先行して有効だったため、承認が発生したレポートでは配線前でも記録されている。

### Cycle オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `cycle_number` | `number` | 必須 | サイクル番号（1始まり） |
| `findings` | `Finding[]` | 必須 | このサイクルで検出された指摘事項 |
| `review_mode` | `"full" \| "staged" \| "reduced"` | 任意 | 適用ペルソナセットの種別。`full`: 6ペルソナ / `staged`: 差分規模200行未満による3ペルソナ段階化 / `reduced`: docs/infraのみの変更による縮退（省略時は `full` 扱い） |
| `personas` | `string[]` | 任意 | このサイクルで実行したペルソナ名一覧（`review_mode` が `staged` または `reduced` の場合は必須） |
| `diff_line_count` | `number` | 任意 | 段階化判定に使った差分行数（追加+削除、生成ファイル除外後。`review_mode` が `staged` または `full` でコード変更を含む場合に記録） |

### Finding オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `source` | `string` | 必須 | 指摘元。ペルソナ名（例: "セキュリティエンジニア"）、または前段工程を表す固定値 `"lint"`（Step 2 の残存違反）/ `"test"`（Step 3 の失敗テスト）/ `"test_design"`（照合の持ち越し不足分）/ `"mutation"`（Step 3.5 の通過条件未達・打ち切り、および `untriaged` / `unresolved` 生存の個別項目） |
| `severity` | `"高" \| "中" \| "低"` | 必須 | 優先度 |
| `description` | `string` | 必須 | 指摘内容の概要 |
| `action` | `"対応済" \| "未対応" \| "対象外"` | 必須 | 対応状況 |
| `detail` | `string` | 任意 | 対応の詳細説明 |

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

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `executed` | `boolean` | 必須 | Step 3.5 を実行したか |
| `reason` | `"not_configured" \| "low_risk" \| "out_of_scope" \| "mode_off" \| "empty_scope" \| "scope_error" \| null` | 必須 | 未実行の理由。`not_configured`: プロダクトにミューテーションテスト設定（Stryker / PIT）が存在しない / `low_risk`: Low リスク変更のため実行対象外 / `out_of_scope`: 変更領域別ステップ適用テーブルで Step 3（ユニットテスト）が `-` の領域のため対象外（quality-policy.md §2 マトリクス優先順位原則）/ `mode_off`: Medium リスクで `mutation_mode_medium: off` が宣言されている / `empty_scope`: 差分スコープが空（変更が除外対象のみ・production クラスの変更なし・実行結果のミュータント数 0。正規シグナルは差分実行の終了コード 0 + 明示メッセージ）/ `scope_error`: 差分スコープの導出失敗（ベース ref 未解決等で差分実行が**非 0 終了** — `empty_scope` と記録してはならない。quality-policy.md §2「空スコープと導出失敗の区別」）。`executed` が `true` の場合は `null` |
| `mode` | `"gate" \| "advisory"` | 任意 | 実行モード（quality-policy.md §2「ミューテーションテストの実行モード」）。High は常に `gate`、Medium も既定 `gate`（`mutation_mode_medium` で `advisory` に変更可）。`executed` が `true` の場合は必須 |
| `scope` | `"changed_lines" \| "changed_classes" \| "changed_files"` | 任意 | 差分スコープの粒度。`changed_lines`: Stryker の変更行スコープ / `changed_classes`: PIT の変更クラススコープ / `changed_files`: 旧配線のままファイル単位で実行した場合の暫定値 — `gate` モードの通過判定には使えない（quality-policy.md §2「差分スコープの定義」）。`executed` が `true` の場合は必須 |
| `base_ref` | `string` | 任意 | 差分スコープの基準 ref（既定 `origin/main`。Step 1 の差分判定と同一でなければならない）。`executed` が `true` の場合は必須 |
| `mutants_total` | `number` | 任意 | スコープ内で生成・実行されたミュータント数。集計外 status（`Ignored`・`CompileError` 等 — quality-policy.md §2「ツール status との対応」）は含めない。実行結果が 0 の場合は `empty_scope`（本オブジェクトは未実行表現になる）。`executed` が `true` の場合は必須 |
| `score_raw` | `number` | 任意 | **初回実行時点**のツール算出スコア（%）。killed / 生存 / 集計外の status 対応は quality-policy.md §2「ツール status との対応」を正とする（`NoCoverage` は生存）。`executed` が `true` の場合は必須 |
| `score` | `number` | 任意 | 調整後スコア（%）= killed ÷ (killed + `unresolved` + `untriaged`)。killed は初回実行で検出されたミュータントと `survivors` で `killed` になったものの合計で、`equivalent` / `accepted` は分母から除外する。分母が 0 の場合は 100 とする（quality-policy.md §2「通過条件とトリアージ」）。`advisory` ではトリアージ義務がないため `score_raw` と同値でよい。`executed` が `true` の場合は必須 |
| `threshold` | `number` | 任意 | 適用した閾値（%）。既定値とモード別の適用（`advisory` では判定に使わない参考値）は quality-policy.md §2 を正とする。上書きはプロダクトのハーネス設定ファイル（quality-policy.md §2「上書きの契約」）で可 — 下記「上書きの契約」注記を参照。`executed` が `true` の場合は必須 |
| `runs` | `number` | 任意 | 全サイクルを通じた Step 3.5 の実行回数（各サイクルで最大1回 — quality-policy.md §5。工程内の是正ループは存在しない）。本オブジェクトのスコア等は**最後の実行**の値、`survivors` は全サイクルを通じた最終状態を記録する。`executed` が `true` の場合は必須 |
| `survivors` | `Survivor[]` | 任意 | 初回実行で生存したミュータントの台帳（quality-policy.md §2）。生存がなければ空配列。`executed` が `true` の場合は必須 |
| `scope_reduced` | `boolean` | 任意 | 実行時間バジェット（既定15分。ハーネス設定ファイル（quality-policy.md §2「上書きの契約」）で上書き可 — 下記「上書きの契約」注記を参照）超過により、リスクの高いファイル優先で対象を絞ったか。`executed` が `true` の場合は必須 |
| `aborted_reason` | `"budget_exceeded" \| "tests_failing" \| null` | 任意 | 最後の実行の打ち切り事由。`budget_exceeded`: 実行時間バジェット超過（途中結果を記録） / `tests_failing`: Step 3 のユニットテストが失敗したままのため実行できずスキップ（`gate` ではいずれも統合指摘（高）として扱う。定義は quality-policy.md §5 を正とする）。`advisory` は是正ループを持たないため `stagnation` / `loop_limit` は発生しない。完走した場合は `null`。`executed` が `true` の場合は必須 |

未実行時は `{ "executed": false, "reason": "not_configured" }` のように `executed` と `reason` のみを記録する（他キーは**省略**する — 本オブジェクトの未実行時の表現はキーの省略に一本化し、`null` は置かない。`reason` / `aborted_reason` の `null` は「実行した上で該当なし」を表す別の意味である）。打ち切り（`budget_exceeded` 等）でツールのレポートが得られなかった場合は、`mutants_total` / `score_raw` / `score` を `null` とし、`survivors` は空配列でよい。

サイクル上限（quality-policy.md §5）まで `mode` が `gate` で `aborted_reason` が `null` 以外（打ち切り）、または quality-policy.md §2 の通過条件（調整後スコア ≥ `threshold` ∧ `untriaged` の生存 = 0 ∧ `memo_linked` の生存が `killed` 以外で残っていない）を満たさないまま終了した場合、`.quality-check-passed` の作成にはユーザーの明示承認が必要であり、承認した場合は `gate_override` に記録する。`mode` が `advisory` の場合は判定を持たないため承認は不要である（打ち切りは `aborted_reason` に記録するのみ）。

> **上書きの契約**（quality-policy.md §2）: `threshold`・バジェット・Medium の実行モードの既定値からの上書きは `gate_parameter_overrides`（トップレベル、§ GateParameterOverrides オブジェクト 参照）に記録する。ハーネス設定ファイルに上書きの記載がないキーは quality-policy.md の既定値が適用され、High リスクのゲートを弱める方向の上書きは行わない。

### Survivor オブジェクト

初回実行で生存したミュータント1件の記録。`gate` モードではトリアージの結果を、`advisory` モードでは一覧（`decision` は `untriaged` のままでよい）を表す。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `mutant` | `string` | 必須 | ミュータントの識別（ファイル・行・変異内容がわかる表記） |
| `decision` | `"killed" \| "equivalent" \| "accepted" \| "unresolved" \| "untriaged"` | 必須 | トリアージの決定（quality-policy.md §2）。`killed`: 統合指摘対応で追加したテストが検出できるようになった / `equivalent`: 動作が変わらない変異 / `accepted`: 振る舞いに影響しない変異（`category` 必須）/ `unresolved`: 振る舞いに影響するが是正ループ内で殺せなかった（分母に残る。`memo_linked` には使えない）/ `untriaged`: 未判断（`gate` では通過不可、`advisory` では既定） |
| `category` | `"logging" \| "defensive_guard" \| "type_only" \| "ui_text" \| "dev_only" \| null` | 必須 | `decision` が `accepted` のときのカテゴリ（閉集合）。それ以外は `null` |
| `reason` | `string` | 必須 | 判断の理由（`untriaged` では空文字でよい） |
| `memo_linked` | `boolean` | 必須 | テスト設計メモの「保証すべき状態遷移・不変条件」「ファルシフィケーション項目」に対応する変更行のミュータントか。`true` のものは `accepted` / `unresolved` にできず、`gate` では `killed` / `equivalent` 以外で通過できない（`equivalent` の判断理由は QA エンジニアペルソナの検証対象 — quality-policy.md §2） |

### TestDesign オブジェクト

High / Medium リスクの変更では、実装前に `test-design` スキルでテスト設計メモを作成し、Step 3 でテストと照合する（quality-policy.md §4）。その照合結果を記録する。`verified` を名乗れるのは、メモの作成が対象実装の最初のコミットより前であることを確認できた場合のみで、確認できないときは `retroactive` に倒す。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `status` | `"verified" \| "retroactive" \| "out_of_scope" \| "not_required"` | 必須 | 照合結果の種別。`verified`: 実装前に作成済みのメモとテストを Step 3 で照合し充足を確認 / `retroactive`: メモが存在せず Step 3 で `test-design` を遡及実行し、洗い出した不足テストを補完 / `out_of_scope`: 変更領域別ステップ適用テーブルで Step 3 が `-` の領域のため対象外（quality-policy.md §2 マトリクス優先順位原則）/ `not_required`: Low リスクの変更のため不要 |
| `memo_path` | `string \| null` | 必須 | テスト設計メモのパス（`docs/superpowers/plans/*-test-design.md` のグロブで発見される命名規則。`test-design` スキルの仕様）。`status` が `verified` / `retroactive` の場合は必須。`out_of_scope` / `not_required` では `null` |
| `gaps_addressed` | `number` | 必須 | 照合・遡及実行で洗い出し補完した不足テストの件数。不足がなければ `0`。`out_of_scope` / `not_required` では `0` |

### GateParameterOverrides オブジェクト

quality-policy.md §2「上書きの契約」に基づき、プロダクトのハーネス設定ファイル（`CLAUDE.md` / `AGENTS.md` / `.cursorrules` の `### Quality Gate Overrides` ブロック）でゲートパラメータを既定値から上書きした場合に、その事実と理由を記録する。上書きがなければトップレベル `gate_parameter_overrides` を `null` にする。HTML コメント（`<!-- -->`）の内側やコードスパン・コードフェンス内に置かれた `### Quality Gate Overrides` ブロックは宣言とみなさない（無効。既定値が適用され、本オブジェクトには記録しない）。

**打ち切り・閾値未達をユーザー承認のもとで通過させた記録である `gate_override` とは別物。** 本オブジェクトは「既定パラメータを変更して運用している」事実の記録であり、承認の有無を問わない。工程の打ち切り・閾値未達を承認した場合の記録は `gate_override` を参照。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `mutation_threshold_high` | `number \| null` | 必須 | High リスクのミューテーションスコア閾値の上書き値（%）。上書きしていない場合は `null`（quality-policy.md の既定値が適用される） |
| `mutation_threshold_medium` | `number \| null` | 必須 | Medium リスクのミューテーションスコア閾値の上書き値（%）。上書きしていない場合は `null`（quality-policy.md の既定値が適用される） |
| `mutation_budget_minutes` | `number \| null` | 必須 | ミューテーションテストの実行時間バジェットの上書き値（分）。上書きしていない場合は `null`（quality-policy.md の既定値が適用される） |
| `mutation_mode_medium` | `"gate" \| "advisory" \| "off" \| null` | 必須 | Medium リスクのミューテーション実行モードの上書き値。上書きしていない場合は `null`（quality-policy.md の既定値 `advisory` が適用される） |
| `reason` | `string` | 必須 | 上書きの理由 |

キー名はハーネス設定ファイルの `### Quality Gate Overrides` 記法（`mutation_threshold_high` / `mutation_threshold_medium` / `mutation_budget_minutes` / `mutation_mode_medium`）と一致させる。

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

打ち切り・閾値未達の工程が存在するにもかかわらずユーザー承認のもとで通過させた場合にのみ記録する（quality-policy.md §5「打ち切り時のゲート挙動」）。該当がなければトップレベル `gate_override` を `null` にする。

**このオブジェクトの存在自体が「ユーザーの明示承認を得た」ことの記録である。** 承認を得ていない状態で本オブジェクトを記録してはならず、そのとき `.quality-check-passed` も作成しない（承認の有無を表す真偽値フィールドは持たない — `null` か、承認済みオブジェクトが存在するかの二値で表現する）。**ゲートパラメータの上書き（既定閾値・バジェットの変更）を記録する `gate_parameter_overrides` とは別物**（上書きの運用自体はユーザー承認の有無を問わない。§ GateParameterOverrides オブジェクト 参照）。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `steps` | `("step_2" \| "step_3" \| "step_3.5" \| "step_4" \| "step_5")[]` | 必須 | 承認対象となった打ち切り・閾値未達の工程（例: `["step_2", "step_3.5"]`） |
| `reason` | `string` | 必須 | 承認の理由（ユーザーが示した判断根拠をそのまま記録する） |

```json
{
  "gate_override": {
    "steps": ["step_3.5"],
    "reason": "生存ミュータントは全て等価ミュータントと判断したが自動判定できないため、手動確認のうえ通過（ユーザー承認）"
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
          "source": "セキュリティエンジニア",
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
  "e2e_result": "pass",
  "e2e_issues": [],
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

### 完全例（リスクレベル・テスト設計照合・ミューテーション・上書き記録を含む）

High リスクの backend 変更で、Step 3.5（`gate`）が生存4件のうちメモ紐付きの1件を次サイクルの再実行で殺し、2件を `accepted`、1件を `unresolved` として調整後スコア 11 ÷ (11 + 1) = 91.7% で閾値を満たして完走し、ミューテーションの実行時間バジェットを既定値から上書きしたケース。全フィールドを含む。

```json
{
  "cycles": [
    {
      "cycle_number": 1,
      "review_mode": "staged",
      "personas": ["セキュリティエンジニア", "QAエンジニア", "統合アーキテクチャレビュー"],
      "diff_line_count": 164,
      "findings": [
        {
          "source": "QAエンジニア",
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
  "e2e_result": "pass",
  "e2e_issues": [],
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
    "mode": "gate",
    "scope": "changed_lines",
    "base_ref": "origin/main",
    "mutants_total": 14,
    "score_raw": 71.4,
    "score": 91.7,
    "threshold": 70,
    "runs": 2,
    "survivors": [
      {
        "mutant": "backend/src/auth/token.service.ts:52（`expiresAt <= now` → `<`）",
        "decision": "killed",
        "category": null,
        "reason": "失効境界のテストを追加（メモ §2 不変条件「失効時刻ちょうどのトークンは拒否」）",
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
        "reason": "外部 IdP のリトライ回数は契約テストの整備（#123）が必要で、今回のループ内では検出テストを書けなかった",
        "memo_linked": false
      }
    ],
    "scope_reduced": false,
    "aborted_reason": null
  },
  "gate_parameter_overrides": {
    "mutation_threshold_high": null,
    "mutation_threshold_medium": null,
    "mutation_budget_minutes": 20,
    "mutation_mode_medium": null,
    "reason": "認証まわりの差分規模が大きく、既定値ではドライラン段階でバジェット超過が見込まれたため延長"
  },
  "gate_override": null,
  "risk_level_downgrade": null
}
```
