---
name: implementation-report
description: PR作成時に使用。実装レポート（計画との対応、品質チェック結果、レビュー指摘対応）をPR descriptionに出力する。
---

# Implementation Report Skill - 実装レポート生成

## 概要

PR作成時に実装レポートを生成するスキル。`quality-check` スキル通過後、push → PR作成時に実行する（**feature ブランチへの push はゲートされない**。品質ゲートはマージ時および main への直接 push 時に `.quality-check-passed` を検証する）。

実装計画と実際の変更差分を比較し、品質チェック結果・レビュー指摘への対応をまとめたレポートを生成する。

---

## 前提条件

- `quality-check` スキルが完了し `.quality-check-report.json` が存在すること
- `.quality-check-report.json` が見つからない場合はエラーとし、先に `quality-check` スキルを実行するよう促す

---

## 実行手順

```
Step 1: .quality-check-report.json を読み取る
  ↓
Step 2: 実装計画ドキュメントを検索・参照
  ↓
Step 3: 計画とGit変更差分を比較し判定
  ↓
Step 4: レポートを生成
  ↓
Step 5: PR descriptionに実装レポートを含めてPR作成
```

---

## Step 1: `.quality-check-report.json` を読み取る

プロジェクトルートの `.quality-check-report.json` を読み取る。

> フォーマットの詳細は [`_schemas/quality-check-report.schema.md`](../_schemas/quality-check-report.schema.md) を参照。

**ファイルが存在しない場合**: エラーを出力し、先に `quality-check` スキルを実行するよう促して処理を中断する。

---

## Step 2: 実装計画ドキュメントを検索・参照

`docs/superpowers/plans/` 配下の計画ドキュメントを検索し、現在のブランチ・Issue に関連する計画を特定する。

- **計画ドキュメントが見つかった場合**: その内容を参照する
- **見つからない場合**: 会話コンテキスト内の計画情報を使用し、レポートに「計画ドキュメント参照不可（会話コンテキストから生成）」と注記する

---

## Step 3: 計画とGit変更差分を比較・判定

```bash
git diff origin/main...HEAD
```

各Phaseについて以下を判定する：

| 判定 | 条件 |
|------|------|
| 計画通り | 計画に記載された変更内容がdiffに反映されている |
| 差分あり | 計画と実際の変更に差異がある（追加・省略・変更） |

---

## Step 4: レポートを生成

「品質チェック結果サマリ」「ゲート上書き・承認」の各項目は、**該当なしの場合も「なし」と明記する**（記載の省略と該当なしを区別できるようにする）。レポートに該当フィールドが存在しない場合は「未記録」と明記する。

### レポートテンプレート

```markdown
## 実装レポート

### 計画との対応
| Phase | 計画内容 | 状態 | 備考 |
|-------|---------|------|------|
| Phase N | [計画内容] | 計画通り / 差分あり | [備考] |

### 計画からの差分
- **Phase N**: [差分の説明]

### 品質チェック結果サマリ
- リスクレベル: high / medium / low（`risk_level`）
- 静的チェック AI 修正パス: N回（打ち切り事由: なし / oscillation）（`lint_cycles` / `lint_abort_reason`）
- テスト設計メモ: verified / retroactive / out_of_scope / not_required（メモ: [パス] または なし）（`test_design.status` / `test_design.memo_path`）
- ミューテーションテスト: 提案 strong / recommended / none（根拠: [`recommendation_basis`]）、ユーザー判断 executed / declined / not_proposed（`mutation.recommendation` / `mutation.user_decision`）。`declined` の場合は見送り理由（`mutation.decline_reason`）を明記する。実施した場合はスコア N%（生スコア、参考情報。最後の実行がキャッシュを再利用した計測なら「incremental」と付記 — `mutation.incremental`）、実行 N回、生存 N 件（killed n / equivalent n / accepted n / unresolved n / untriaged n / tool_false_negative n）（`mutation.score_raw` / `mutation.runs` / `mutation.survivors`）。判定・実行そのものが不能だった場合は理由（`mutation.reason`: not_configured / out_of_scope / empty_scope / scope_error / tool_error）
- 品質チェックサイクル数: N回（N回目で高/中指摘ゼロ達成 / 打ち切り事由: なし / cycle_limit / stagnation / 追加サイクル: N回）（`total_cycles` / `cycle_abort_reason` / `cycle_extensions`）
- E2Eテスト: 提案 strong / recommended / none（根拠: [`recommendation_basis`]）、ユーザー判断 executed / declined / added_only / not_proposed（`e2e.recommendation` / `e2e.user_decision`）。`declined` の場合は見送り理由（`e2e.decline_reason`）を明記する。結果: pass / fail / skipped、検出した問題（`e2e.result` / `e2e.issues`）。新規シナリオがある場合は `e2e.new_scenarios` の各件（シナリオ名と判断: added_and_run / added_only / declined）を明記する
- ドキュメント更新: updated / not_required（`documentation.status`、updated の場合は対象ファイル）
- self-improvement: applied / skipped / not_required（`self_improvement.status`）

### ゲート上書き・承認
- ゲートパラメータ上書き: なし / [キー: 値]（理由: [理由]）（`gate_parameter_overrides`）
- 打ち切り承認: なし / [打ち切り事由（`gate_override.abort_reasons`: cycle_limit / stagnation）]（理由: [ユーザーの判断根拠]）
- リスクレベル引き下げ: なし / [メモ自己判定 → 採用レベル]（理由: [根拠]）（`risk_level_downgrade`）

### レビュー指摘への対応
| サイクル | 指摘内容 | レビュアー | 対応 |
|---------|---------|---------|------|
| N回目 | [指摘内容] | [レビュアー名（統合レビュアーは観点も）] | 対応済: [詳細] / 対応不要（理由後述） |

### 対応不要と判断したもの
- **[指摘内容]**（[レビュアー名]指摘）: [判断理由]
```

---

## Step 5: PR descriptionに実装レポートを含めてPR作成

- 既存のPRテンプレート（`.github/PULL_REQUEST_TEMPLATE.md`）がある場合、テンプレートの実装レポートセクションを実データで埋める
- テンプレートがない場合、Step 4で生成したレポートをそのままPR descriptionに含める

```bash
gh pr create --title "[PRタイトル]" --body "[テンプレート + 実装レポート]"
```
