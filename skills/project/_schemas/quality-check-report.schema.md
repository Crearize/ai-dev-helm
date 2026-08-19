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
| `risk_level` | `"high" \| "medium" \| "low"` | 必須 | Step 1 で判定したリスクレベル（Step 1 へのリスクレベル判定の追加はフェーズ2）。判定基準は `shared/documents/quality-policy.md` §1、レベル別のゲート強度は同 §2 を参照 |
| `lint_cycles` | `number \| null` | 必須 | Step 2 の AI 修正サイクル数（1サイクル = `lint:all` 実行 → AI による修正）。決定的自動修正のみで完結したパスは含めない。上限は3（quality-policy.md §5）。**Step 2 を実行しない領域（docs / infra のみの変更等）では `null`** — `0`（実行したが AI 修正が不要だった）とは区別する |
| `mutation` | `Mutation` | 必須 | Step 3.5 ミューテーションテストの実行結果 |
| `test_design` | `TestDesign` | 予約 [^reserved] | Step 3 のテスト設計メモ（`test-design` スキル）との照合結果。**キー構成はフェーズ2（quality-check 改修 + test-design スキル）で確定する**（§ TestDesign オブジェクト 参照） |
| `gate_override` | `GateOverride \| null` | 必須 | 打ち切り・閾値未達で終了した工程をユーザーの明示承認のもとで通した場合の記録。該当がなければ `null`（quality-policy.md §5「打ち切り時のゲート挙動」/ §6） |

[^reserved]: 「予約」は必須／任意とは別の軸（フィールドのライフサイクル）を表す。キー構成が確定していないため、必須・任意のいずれとしても判定できない段階にあることを示す。フェーズ2でキーを確定する際に必須／任意を割り当てる。

> **フェーズ1時点の注記**: `risk_level` / `lint_cycles` / `mutation` / `test_design` は本スキーマ上の定義であり、`quality-check` SKILL.md 側の出力配線はフェーズ2で行う。それまでに生成されたレポートにこれらのフィールドが存在しないことは、レポート不正ではなく未配線を意味する。
>
> ただし `gate_override` は例外で、打ち切り承認が実際に発生した場合の記録義務は quality-policy.md §5「打ち切り時のゲート挙動」により**現時点から拘束力を持つ**（同 :10 のとおり §5 のゲート規範は配線の有無に関わらず有効）。承認が発生していない通常のレポートで本フィールドが存在しないことは未配線として扱ってよい。

> **フェーズ2で追加予定**: Step 2 の**打ち切り事由**キー（3サイクル上限到達 / 同一ルール×同一ファイルの振動検出）はフェーズ2で追加する。`lint_cycles` はサイクル**数**のみを表し、打ち切り事由は表現しない。quality-policy.md §6 が求める全工程の打ち切り事由の記録のうち、Step 2 分は現時点では未充足である（Step 3.5 分は `mutation.aborted_reason` が充足する）。

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
| `threshold` | `number` | 任意 | 適用した閾値（%）。既定は High 80 / Medium 70（プロダクトの CLAUDE.md で上書き可 — 下記「上書きの契約」注記を参照）。`executed` が `true` の場合は必須 |
| `loops` | `number` | 任意 | 「生存ミュータント分析 → テスト追加 → 再実行」のループ回数。上限は5（quality-policy.md §5）。`executed` が `true` の場合は必須 |
| `survived_addressed` | `number` | 任意 | テスト追加で対処した生存ミュータント数。`executed` が `true` の場合は必須 |
| `equivalent_excluded` | `number` | 任意 | 等価ミュータント（動作が変わらない変異）として対象から除外した**数**。`executed` が `true` の場合は必須。quality-policy.md §5 が求める**除外理由**の記録キーはフェーズ2で確定する（それまでは該当サイクルの `findings` またはレポート外の作業メモに理由を残す） |
| `scope_reduced` | `boolean` | 任意 | 実行時間バジェット（既定15分。CLAUDE.md で上書き可 — 下記「上書きの契約」注記を参照）超過見込みにより、リスクの高いファイル優先で対象を絞ったか。`executed` が `true` の場合は必須 |
| `aborted_reason` | `"budget_exceeded" \| "stagnation" \| "loop_limit" \| null` | 任意 | 打ち切り事由。`budget_exceeded`: 実行時間バジェット超過 / `stagnation`: 2ループ連続でスコア改善なしによる早期打ち切り / `loop_limit`: 5ループ上限到達。完走した場合は `null`。`executed` が `true` の場合は必須 |

未実行時は `{ "executed": false, "reason": "not_configured" }` のように `executed` と `reason` のみを記録する（他キーは**省略**する — 本オブジェクトの未実行時の表現はキーの省略に一本化し、`null` は置かない。`reason` / `aborted_reason` の `null` は「実行した上で該当なし」を表す別の意味である）。

`aborted_reason` が `null` 以外の場合（打ち切り）、または `score` が `threshold` 未満のまま終了した場合（閾値未達）、`.quality-check-passed` の作成にはユーザーの明示承認が必要であり、承認した場合は `gate_override` に記録する。

> **上書きの契約**（quality-policy.md §2）: `threshold` とバジェットの上書きキーの記載形式はフェーズ2で確定する。それまでは quality-policy.md の既定値が拘束力を持ち、High リスクのゲートを弱める方向の上書きは行わない。

### TestDesign オブジェクト（予約）

High / Medium リスクの変更では、実装前に `test-design` スキルでテスト設計メモを作成し、Step 3 でテストと照合する（quality-policy.md §4）。その照合結果を記録するトップレベルフィールドとして `test_design` を予約する。

**キー構成はフェーズ2（quality-check 改修 + test-design スキル）で確定する。** 本フェーズでは名前と用途のみを確保し、キーの追加・確定はフェーズ2の実装計画で行う。確定前のレポートではこのフィールドを省略してよく、後述の JSON 例にも含めない。Low リスクの変更および `test-design` が不要な領域での扱い（省略か明示的な非該当マーカーか）もフェーズ2で確定する。

### GateOverride オブジェクト

打ち切り・閾値未達の工程が存在するにもかかわらずユーザー承認のもとで通過させた場合にのみ記録する（quality-policy.md §5「打ち切り時のゲート挙動」）。該当がなければトップレベル `gate_override` を `null` にする。

**このオブジェクトの存在自体が「ユーザーの明示承認を得た」ことの記録である。** 承認を得ていない状態で本オブジェクトを記録してはならず、そのとき `.quality-check-passed` も作成しない（承認の有無を表す真偽値フィールドは持たない — `null` か、承認済みオブジェクトが存在するかの二値で表現する）。

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `steps` | `string[]` | 必須 | 承認対象となった打ち切り・閾値未達の工程（例: `["step_2", "step_3.5"]`） |
| `reason` | `string` | 必須 | 承認の理由（ユーザーが示した判断根拠をそのまま記録する） |

`steps` の要素は `quality-check` のステップ番号を `step_<番号>` 形式で表記する（`step_2` / `step_3.5` など。小数点はそのまま用いる）。取りうる値の enum 化はフェーズ2で確定する。

```json
{
  "gate_override": {
    "steps": ["step_3.5"],
    "reason": "残存ミュータントは監査ログ整形のみで、リリース期日を優先すると判断（ユーザー承認）"
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

### 完全例（リスクレベル・ミューテーション・ループ防護記録を含む）

High リスクの backend 変更で、Step 3.5 が閾値を満たして完走したケース。`test_design` はキー構成が未確定のため含めていない。

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
  "mutation": {
    "executed": true,
    "reason": null,
    "score": 82.5,
    "threshold": 80,
    "loops": 2,
    "survived_addressed": 5,
    "equivalent_excluded": 1,
    "scope_reduced": false,
    "aborted_reason": null
  },
  "gate_override": null
}
```
