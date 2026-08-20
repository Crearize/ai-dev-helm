# .quality-check-report.json Schema

品質チェックスキル (`/quality-check`) が出力し、実装レポートスキル (`/implementation-report`) が入力として読み取るJSONファイルのスキーマ定義。

## フィールド定義

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `cycles` | `Cycle[]` | 必須 | レビューサイクルの配列 |
| `total_cycles` | `number` | 必須 | 完了したサイクル総数 |
| `e2e_result` | `"pass" \| "fail" \| "skipped"` | 必須 | E2Eテスト結果 |
| `e2e_issues` | `string[]` | 必須 | E2Eで検出された問題（なければ空配列） |
| `documentation` | `Documentation` | 必須 | `feature-documentation` スキルの実行状況（Step 0） |
| `self_improvement` | `SelfImprovement` | 必須 | `self-improvement` スキルの実行状況（Step 5.75） |
| `risk_level` | `"high" \| "medium" \| "low"` | フェーズ2必須 [^lifecycle] | Step 1 で判定したリスクレベル。判定基準は `quality-policy.md` §1、レベル別のゲート強度は同 §2 を参照 |
| `lint_cycles` | `number \| null` | フェーズ2必須 [^lifecycle] | Step 2 の AI 修正サイクル数（1サイクル = 静的チェックコマンド（`lint-scaffolding` 導入済みプロダクトでは `lint:all`、未導入では CLAUDE.md に登録されたコマンド）の実行 → AI による修正）。決定的自動修正のみで完結したパスは含めない。上限は3（quality-policy.md §5）。**Step 2 を実行しない領域（docs のみの変更等）では `null`** — `0`（実行したが AI 修正が不要だった）とは区別する。infra のみの変更では Step 2（該当ビルドコマンド）を実行する（`quality-check` SKILL.md 変更領域別ステップ適用テーブル） |
| `lint_abort_reason` | `"loop_limit" \| "oscillation" \| null` | フェーズ2必須 [^lifecycle] | Step 2 の打ち切り事由。`loop_limit`: 3サイクル上限到達 / `oscillation`: 同一ルール×同一ファイルの違反が2サイクル連続で再発（振動検出）。完走した場合、および `lint_cycles` が `null`（Step 2 未実行）の場合は `null`。語彙は `mutation.aborted_reason` の `loop_limit` と統一する |
| `mutation` | `Mutation` | フェーズ2必須 [^lifecycle] | Step 3.5 ミューテーションテストの実行結果 |
| `test_design` | `TestDesign` | フェーズ2必須 [^lifecycle] | Step 3 のテスト設計メモ（`test-design` スキル）との照合結果（quality-policy.md §4）。詳細は § TestDesign オブジェクト を参照 |
| `gate_parameter_overrides` | `GateParameterOverrides \| null` | 必須（発生時） [^lifecycle] | ゲートパラメータ（ミューテーション閾値・実行時間バジェット）を既定値から上書きした場合の記録（quality-policy.md §2「上書きの契約」）。上書きがなければ `null`。**打ち切り承認を記録する `gate_override` とは別物**（詳細は § GateParameterOverrides オブジェクト を参照） |
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
| `source` | `string` | 必須 | 指摘元ペルソナ名（例: "セキュリティエンジニア"） |
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
| `reason` | `"not_configured" \| "low_risk" \| "out_of_scope" \| null` | 必須 | 未実行の理由。`not_configured`: プロダクトにミューテーションテスト設定（Stryker / PIT）が存在しない / `low_risk`: Low リスク変更のため実行対象外 / `out_of_scope`: 変更領域別ステップ適用テーブルで Step 3（ユニットテスト）が `-` の領域のため対象外（quality-policy.md §2 マトリクス優先順位原則）。`executed` が `true` の場合は `null` |
| `score` | `number` | 任意 | 変更コードのミューテーションスコア（%）。`executed` が `true` の場合は必須 |
| `threshold` | `number` | 任意 | 適用した閾値（%）。既定は High 80 / Medium 70（プロダクトのハーネス設定ファイル（quality-policy.md §2「上書きの契約」）で上書き可 — 下記「上書きの契約」注記を参照）。`executed` が `true` の場合は必須 |
| `loops` | `number` | 任意 | 「生存ミュータント分析 → テスト追加 → 再実行」のループ回数。上限は5（quality-policy.md §5）。`executed` が `true` の場合は必須 |
| `survived_addressed` | `number` | 任意 | テスト追加で対処した生存ミュータント数。`executed` が `true` の場合は必須 |
| `equivalent_excluded` | `number` | 任意 | 等価ミュータント（動作が変わらない変異）として対象から除外した**数**。`executed` が `true` の場合は必須。`equivalent_exclusions` の要素数と一致する |
| `equivalent_exclusions` | `EquivalentExclusion[]` | 任意 | 除外した等価ミュータントの対象と理由の一覧（quality-policy.md §5）。`executed` が `true` の場合は必須（除外がなければ空配列） |
| `scope_reduced` | `boolean` | 任意 | 実行時間バジェット（既定15分。ハーネス設定ファイル（quality-policy.md §2「上書きの契約」）で上書き可 — 下記「上書きの契約」注記を参照）超過見込みにより、リスクの高いファイル優先で対象を絞ったか。`executed` が `true` の場合は必須 |
| `aborted_reason` | `"budget_exceeded" \| "stagnation" \| "loop_limit" \| null` | 任意 | 打ち切り事由。`budget_exceeded`: 実行時間バジェット超過 / `stagnation`: 2ループ連続でスコア改善なしによる早期打ち切り / `loop_limit`: 5ループ上限到達。完走した場合は `null`。`executed` が `true` の場合は必須 |

未実行時は `{ "executed": false, "reason": "not_configured" }` のように `executed` と `reason` のみを記録する（他キーは**省略**する — 本オブジェクトの未実行時の表現はキーの省略に一本化し、`null` は置かない。`reason` / `aborted_reason` の `null` は「実行した上で該当なし」を表す別の意味である）。

`aborted_reason` が `null` 以外の場合（打ち切り）、または `score` が `threshold` 未満のまま終了した場合（閾値未達）、`.quality-check-passed` の作成にはユーザーの明示承認が必要であり、承認した場合は `gate_override` に記録する。

> **上書きの契約**（quality-policy.md §2）: `threshold` とバジェットの既定値からの上書きは `gate_parameter_overrides`（トップレベル、§ GateParameterOverrides オブジェクト 参照）に記録する。ハーネス設定ファイルに上書きの記載がないキーは quality-policy.md の既定値が適用され、High リスクのゲートを弱める方向の上書きは行わない。

### EquivalentExclusion オブジェクト

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `mutant` | `string` | 必須 | 除外対象のミュータントの識別（ファイル・行・変異内容がわかる表記） |
| `reason` | `string` | 必須 | 等価ミュータント（動作が変わらない変異）と判断した理由 |

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
| `reason` | `string` | 必須 | 上書きの理由 |

キー名はハーネス設定ファイルの `### Quality Gate Overrides` 記法（`mutation_threshold_high` / `mutation_threshold_medium` / `mutation_budget_minutes`）と一致させる。

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

High リスクの backend 変更で、Step 3.5 が閾値を満たして完走し、ミューテーションの実行時間バジェットを既定値から上書きしたケース。全フィールドを含む。

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
    "score": 82.5,
    "threshold": 80,
    "loops": 2,
    "survived_addressed": 5,
    "equivalent_excluded": 1,
    "equivalent_exclusions": [
      {
        "mutant": "backend/src/auth/token.service.ts:48（条件境界の反転）",
        "reason": "ログ出力のみに影響する分岐で外部から観測可能な挙動が変わらないため"
      }
    ],
    "scope_reduced": false,
    "aborted_reason": null
  },
  "gate_parameter_overrides": {
    "mutation_threshold_high": null,
    "mutation_threshold_medium": null,
    "mutation_budget_minutes": 20,
    "reason": "認証まわりの差分規模が大きく、既定値ではドライラン段階でバジェット超過が見込まれたため延長"
  },
  "gate_override": null,
  "risk_level_downgrade": null
}
```
