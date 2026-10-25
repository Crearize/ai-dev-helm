# quality-check: レポートデータの例（Step 4-4）

本体の Step 4-4（各サイクルの結果の保存）で読む。

#### 4-4. レポートデータ蓄積

各サイクルの結果を `.quality-check-report.json` に保存する。

> 完全なスキーマ定義は [`_schemas/quality-check-report.schema.md`](../../_schemas/quality-check-report.schema.md) を参照。

JSONフォーマット例：

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
        { "persona": "セキュリティエンジニア", "applied": true, "basis": "認証・認可に関わる変更を含む（AuthService.java の authorize()。優先 1）" },
        { "persona": "要件・仕様整合性レビュアー", "applied": false, "basis": "優先順位により未起動（統合レビュアーの重点観点に昇格）" },
        { "persona": "パフォーマンスエンジニア", "applied": false, "basis": "起動条件（クエリ・ループ・キャッシュ・バンドル・高頻度経路）に該当するパスなし（変更ファイル一覧を確認）" }
      ],
      "findings": [
        {
          "source": "セキュリティエンジニア",
          "sources": ["セキュリティエンジニア"],
          "concern": "security",
          "severity": "高",
          "description": "SQLインジェクション対策確認",
          "action": "対応済",
          "detail": "バインドパラメータ使用を確認"
        },
        {
          "source": "統合レビュアー",
          "sources": ["統合レビュアー"],
          "concern": "design",
          "severity": "中",
          "description": "リポジトリ層の例外の変換を固定するテストが無い",
          "action": "PR に記録",
          "detail": "PR の本文の「レビューの中の指摘」に記載"
        }
      ]
    }
  ],
  "total_cycles": 1,
  "cycle_abort_reason": null,
  "cycle_extensions": [],
  "e2e": {
    "recommendation": "none",
    "recommendation_basis": ["バックエンドのみの変更"],
    "user_decision": "not_proposed",
    "decided_by": null,
    "decline_reason": null,
    "result": "skipped",
    "issues": [],
    "new_scenarios": []
  },
  "risk_level": "high",
  "lint_cycles": 1,
  "lint_abort_reason": null,
  "test_design": {
    "status": "verified",
    "memo_path": "docs/superpowers/plans/2026-08-20-user-authentication-test-design.md",
    "gaps_addressed": 0
  },
  "mutation": {
    "executed": false,
    "reason": "not_configured"
  },
  "documentation": {
    "status": "updated",
    "files": ["documents/features/user-authentication.md"]
  },
  "self_improvement": {
    "status": "not_required",
    "candidates": []
  }
}
```
