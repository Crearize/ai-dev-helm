---
name: backend-development
description: バックエンド実装時に使用。DRY原則遵守。コーディング規約準拠。
---

# Backend Development Skill - バックエンド開発

導入先の補足ファイル `documents/development/project/backend-development.md` があれば、その段で読む。補足ファイルは製品への当てはめ（コマンド・パス・ポート等）だけを持ち、本スキルの規則を緩めない。食い違えば本スキルが優先する。

## 禁止事項（最重要）

> **以下は絶対に禁止。違反は許容されない。**

- **不要なTry-Catch禁止**: 共通例外ハンドラーに委譲する
- **車輪の再発明禁止**: 既存ユーティリティを活用
- **ワイルドカードimport禁止**: `import java.util.*;` は使用しない（Java の場合）

## コーディング規約要点

### レイヤー構成

- **Controller層**: ルーティングとバリデーションのみ。ビジネスロジック記述禁止
- **Service層**: ビジネスロジック集約。トランザクション管理
- **Repository層**: データアクセスのみ。SELECT * 禁止（必要なカラムのみ）。N+1問題の回避

## テスト方針: 仕様ベーステスト

- テストは実装の内部状態ではなく、機能要件に基づいて設計する
- privateメソッドやキャッシュ等の内部実装を直接テストしない
- モック対象は外部依存（DB、外部API等）に限定する

## 実装完了時の必須チェック

プロジェクトの CLAUDE.md に定義されたバックエンド品質チェックコマンドを実行する。

## 参照ドキュメント

- バックエンド規約: `documents/development/coding-rules/backend-rules.md`
- API設計規約: `documents/development/coding-rules/api-design-rules.md`
- 共通規約: `documents/development/coding-rules/common-rules.md`
