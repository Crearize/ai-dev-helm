# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0](https://github.com/Crearize/ai-dev-helm/compare/v1.5.0...v1.6.0) (2026-06-10)

### Added

- `worktree-parallel` スキルを追加し、Git worktree 並列開発時の配置、ポート割当、環境コピー、クリーンアップを標準化
- `self-improvement` スキルを追加し、作業完了前に改善候補をユーザー判断でルール・スキル・ドキュメントへ反映するハーネスを導入
- Claude / Codex / Cursor テンプレートに、自律動作原則とサーバーポート固定・停止確認ルールを追加

### Changed

- `quality-check` のレビューサイクルを最低3回から最低2回に変更し、レビューエージェントを4並列から6並列へ拡充
- レビューペルソナにパフォーマンスエンジニアと要件・仕様整合性レビュアーを追加
- `server-startup` スキルを強化し、E2E・ブラウザ検証・開発サーバー起動時の既存プロセス停止と作業後停止確認を必須化
- README の SuperPowers 表記を現在同期中の v5.1.0 に更新

## [1.5.0](https://github.com/Crearize/ai-dev-helm/compare/v1.4.0...v1.5.0) (2026-05-28)


### Added

* グローバル設定テンプレートのモデルを claude-opus-4-8 に更新 ([#28](https://github.com/Crearize/ai-dev-helm/issues/28)) ([a25c06b](https://github.com/Crearize/ai-dev-helm/commit/a25c06baa07304f92ab80c2909c8a561df46acad)), closes [#27](https://github.com/Crearize/ai-dev-helm/issues/27)

## [1.4.0](https://github.com/Crearize/ai-dev-helm/compare/v1.3.5...v1.4.0) (2026-05-20)


### Added

* Codex CLI 対応をハーネスに追加 ([#25](https://github.com/Crearize/ai-dev-helm/issues/25)) ([d803253](https://github.com/Crearize/ai-dev-helm/commit/d803253936ca74295e75781cffdbe3e726d30df2)), closes [#24](https://github.com/Crearize/ai-dev-helm/issues/24)

## [1.3.5](https://github.com/Crearize/ai-dev-helm/compare/v1.3.4...v1.3.5) (2026-05-17)


### Changed

* **ci:** rename release-please.yml to publish.yml ([#22](https://github.com/Crearize/ai-dev-helm/issues/22)) ([d42a8c5](https://github.com/Crearize/ai-dev-helm/commit/d42a8c5084cc0057487ac23cf08bf0d3b0ca9b0c))

## [1.3.4](https://github.com/Crearize/ai-dev-helm/compare/v1.3.3...v1.3.4) (2026-05-17)


### Fixed

* **ci:** inline publish step into release-please workflow ([#19](https://github.com/Crearize/ai-dev-helm/issues/19)) ([3737b13](https://github.com/Crearize/ai-dev-helm/commit/3737b132baaafd3b905c8c1fb394c42c3f9ef125))
* **ci:** unify publish into release-please.yml (single trusted publisher) ([#21](https://github.com/Crearize/ai-dev-helm/issues/21)) ([2838a71](https://github.com/Crearize/ai-dev-helm/commit/2838a713146b7c14daf710a3bb5a55c92f284f8b))

## [1.3.3](https://github.com/Crearize/ai-dev-helm/compare/v1.3.2...v1.3.3) (2026-05-17)


### Fixed

* **ci:** chain publish from release-please via workflow_call ([#17](https://github.com/Crearize/ai-dev-helm/issues/17)) ([739e8df](https://github.com/Crearize/ai-dev-helm/commit/739e8df4cae99481cbcc234995efbaea6cad4d74))

## [1.3.2](https://github.com/Crearize/ai-dev-helm/compare/v1.3.1...v1.3.2) (2026-05-17)


### Fixed

* **ci:** use Node 24 + latest npm for Trusted Publishing ([#14](https://github.com/Crearize/ai-dev-helm/issues/14)) ([938c463](https://github.com/Crearize/ai-dev-helm/commit/938c463af6aa1bb07c8df04a2245ff717d1f1a0d))


### CI

* introduce release-please for automated version & release PRs ([#15](https://github.com/Crearize/ai-dev-helm/issues/15)) ([8687de3](https://github.com/Crearize/ai-dev-helm/commit/8687de32b9ac66d3cd4dd0ab898b3153876990f8))

## [Unreleased]

## [1.3.1] - 2026-05-17

### Added

- **`.github/workflows/publish.yml`**: GitHub Release が `published` になった時に npm へ自動公開するワークフローを追加 (#12)
  - トリガー: `release: published`（主） / `workflow_dispatch`（手動リカバリ用）
  - リリースタグと `package.json.version` の整合性を `npm publish` 前に検証
  - publish 前に `npm ci` と `npm test` を実行して品質ゲートを担保
  - 認証は **Trusted Publishing (OIDC)** を使用（`id-token: write` 権限のみで `NPM_TOKEN` 不要）
  - `npm publish --provenance` で発行元の証明（provenance attestation）を付与

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
