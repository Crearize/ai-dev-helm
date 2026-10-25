---
name: frontend-development
description: フロントエンド実装時に使用。コーディング規約準拠。コンポーネント設計。
---

# Frontend Development Skill - フロントエンド開発

導入先の補足ファイル `documents/development/project/frontend-development.md` があれば、その段で読む。補足ファイルは製品への当てはめ（コマンド・パス・ポート等）だけを持ち、本スキルの規則を緩めない。食い違えば本スキルが優先する。

## 禁止事項（最重要）

> **以下は絶対に禁止。違反は許容されない。**

- **any型使用禁止**: `unknown`型を使用（TypeScript の場合）
- **React.forwardRef使用禁止**: 将来非推奨化予定（React の場合）

## コンポーネント設計

### UIライブラリ優先

新規コンポーネント作成前に、プロジェクトで採用しているUIライブラリの既存コンポーネントで要件を満たせるか確認。

### 状態管理

プロジェクトで採用している状態管理ライブラリに従う。

## 非同期処理ガイドライン

- **async/await優先**: Promiseチェーン（`.then()`）は避ける
- **独立した非同期処理はPromise.allで並列実行**
- **エラーハンドリング**: try-catch + 適切なUI表示

## テスト方針: 仕様ベーステスト

- テストは実装の内部状態ではなく、機能要件に基づいて設計する
- useState等の内部stateを直接検証しない
- Testing Libraryのロールベースセレクタ優先（`getByRole` > `getByTestId`）
- モック対象は外部依存（API、ブラウザAPI等）に限定する

## 実装完了時の必須チェック

プロジェクトの CLAUDE.md に定義されたフロントエンド品質チェックコマンドを実行する。

## 参照ドキュメント

- フロントエンド規約: `documents/development/coding-rules/frontend-rules.md`
- 開発ガイドライン: `documents/development/development-policy.md`
