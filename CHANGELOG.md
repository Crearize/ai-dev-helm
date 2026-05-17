# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-05-17

### Changed

- superpowers スキルを v5.0.6 → v5.1.0 に同期 (#1)
  - `finishing-a-development-branch`: ワークスペース状態を判別する Step 2「Detect Environment」を追加。通常リポジトリ／named-branch worktree／detached HEAD の3パターンに応じてメニューと cleanup 処理を切り替え
  - `using-git-worktrees`: 「REQUIRED で worktree を作成」から「分離されたワークスペースを保証する（既存の worktree があれば検証する）」運用に緩和
  - `executing-plans`: `using-git-worktrees` への依存表現を緩和方針に追従
  - `requesting-code-review` / `code-reviewer.md`: レビュアー手順とプロンプト構成を刷新
  - `subagent-driven-development` / `code-quality-reviewer-prompt.md`: サブエージェント運用のガイダンスを更新
  - `systematic-debugging/root-cause-tracing.md`: 表現修正
  - `using-superpowers` / `writing-plans`: 軽微な修正

### Added

- `skills/superpowers/writing-skills/persuasion-principles.md`: スキル設計時に活用する「説得の原則」リファレンスを新規追加

## [1.2.0] - 2026-04-19

### Added

- `feature-documentation` スキル: 機能・サービス・要件・プロジェクト前提条件などを「永続ドキュメント」として蓄積する運用を必須化
  - 新規ならドキュメント作成、既存があれば更新（全面書き換え禁止）
  - 保存場所は既存ディレクトリを自動検索、なければユーザーに候補提示して確認
  - 詳細テンプレート（概要 / 目的 / スコープ / アーキテクチャ / API / データモデル / 設計判断 / 運用上の注意）。変更履歴セクションは git で追跡可能なため除外
- `quality-check` に Step 0「ドキュメント更新の確認」ゲートを追加
  - 機能変更（新規ファイル / API 変更 / 振る舞いの変更）があるのにドキュメント更新差分が `git diff` に存在しない場合はエラーで停止し、`feature-documentation` を促す
- `.quality-check-report.json` スキーマに `documentation` フィールドを追加（`status: "updated" | "not_required"`、対象ファイル一覧）

### Changed

- `shared/documents/quick-checklist.md` の「During Implementation」「Documentation Update Checks」に `feature-documentation` への参照を追加
- `README.md` のスキル一覧表に `feature-documentation` を追加

## [1.1.0] - 2026-04-09

### Added

- `personal` コマンドに Claude モデルバージョン自動検出＆アップグレード機能
  - 既存設定の `model` がテンプレートと異なる場合、対話プロンプトで確認
  - `--upgrade-model` フラグで非対話アップグレード対応
- `mergeSettings` に `upgradeKeys` オプション（指定キーをテンプレート値で強制上書き）

### Changed

- グローバル設定テンプレートのモデルを `claude-opus-4-6` → `claude-opus-4-7` に更新

## [1.0.0] - 2026-04-09

### Added

- Node.js CLI with `init` and `personal` subcommands
- Interactive setup for Claude Code and Cursor
- superpowers skills (14 development process skills)
- Project skills (8 project operation skills)
- Tech stack support: java-springboot, nextjs-react
- Shared development documents and review guides
- PR template generation
- Global safety settings for personal environments
- `--help`, `--version`, `--dry-run`, `--verbose` CLI options
- Vitest test suite (unit and integration tests)
- OSS standard files (LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT)
- Automated superpowers sync via GitHub Actions with auto-merge

### Security

- Input validation for project names (reject control characters)
- Safe template replacement (escape regex special characters)
- EOF handling to prevent infinite loops in prompts
- Error handling with cleanup for partial file operations
