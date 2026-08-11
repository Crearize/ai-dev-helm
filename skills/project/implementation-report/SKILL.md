---
name: implementation-report
description: PR作成時に使用。実装レポート（計画との対応、品質チェック結果、レビュー指摘対応）をPR descriptionに出力する。
---

# Implementation Report Skill - 実装レポート生成

## 概要

PR作成時に実装レポートを生成するスキル。`/quality-check`通過後、push → PR作成時に実行する（push 自体はゲートされない。品質ゲートはマージ時に `.quality-check-passed` を検証する）。

実装計画と実際の変更差分を比較し、品質チェック結果・レビュー指摘への対応をまとめたレポートを生成する。

---

## 前提条件

- `/quality-check` が完了し `.quality-check-report.json` が存在すること
- `.quality-check-report.json` が見つからない場合はエラーとし、先に `/quality-check` を実行するよう促す

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

**ファイルが存在しない場合**: エラーを出力し、先に `/quality-check` を実行するよう促して処理を中断する。

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
- 品質チェックサイクル数: N回（N回目で指摘ゼロ達成）
- E2Eテスト: 全件パス / N件失敗

### レビュー指摘への対応
| サイクル | 指摘内容 | ペルソナ | 対応 |
|---------|---------|---------|------|
| N回目 | [指摘内容] | [ペルソナ名] | 対応済: [詳細] / 対応不要（理由後述） |

### 対応不要と判断したもの
- **[指摘内容]**（[ペルソナ名]指摘）: [判断理由]
```

---

## Step 5: PR descriptionに実装レポートを含めてPR作成

- 既存のPRテンプレート（`.github/PULL_REQUEST_TEMPLATE.md`）がある場合、テンプレートの実装レポートセクションを実データで埋める
- テンプレートがない場合、Step 4で生成したレポートをそのままPR descriptionに含める

```bash
gh pr create --title "[PRタイトル]" --body "[テンプレート + 実装レポート]"
```
