---
name: generate-docs
description: git logからCHANGELOGとリリースノートを自動生成する。リリース作業時に使用。
---

# Document Generation - ドキュメント自動生成

導入先の補足ファイル `documents/development/project/generate-docs.md` があれば、その段で読む。補足ファイルは製品への当てはめ（コマンド・パス・ポート等）だけを持ち、本スキルの規則を緩めない。食い違えば本スキルが優先する。

git logから CHANGELOG とリリースノートを自動生成する。リリース時に手動呼び出しして使用する。

## 実行フロー

```
Step 1: バージョン情報の確認
  ↓
Step 2: git log の解析
  ↓
Step 3: CHANGELOG.md の更新
  ↓
Step 4: リリースノート生成
  ↓
Step 5: ユーザー確認
```

---

## Step 1: バージョン情報の確認

### 前回リリースタグの取得

```bash
# タグ命名規則: vX.Y.Z
git describe --tags --abbrev=0
```

タグがない場合（初回リリース）は全コミットを対象とする。

### 次のバージョンの決定

ユーザーに確認する。デフォルト提案としてコミットタイプから推定：

| コミット内容 | バージョンアップ | 例 |
|-------------|----------------|-----|
| `feat:` が含まれる | マイナー | v1.0.0 -> v1.1.0 |
| `fix:` のみ | パッチ | v1.0.0 -> v1.0.1 |
| breaking change（`!` suffix） | メジャー | v1.0.0 -> v2.0.0 |

---

## Step 2: git log の解析

```bash
# 前回タグからのコミット取得
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$PREV_TAG" ]; then
  git log --oneline --no-merges
else
  git log ${PREV_TAG}..HEAD --oneline --no-merges
fi
```

コミットメッセージの type でカテゴリ分類する（Conventional Commits形式を前提とする。コミットメッセージ規約は `documents/development/coding-rules/common-rules.md` Section 1 を参照）：

| Type | カテゴリ | CHANGELOG セクション |
|------|---------|---------------------|
| `feat:` | 新機能 | Added |
| `fix:` | バグ修正 | Fixed |
| `refactor:` / `perf:` | 変更 | Changed |
| `docs:` | ドキュメント | Documentation |
| `test:` / `chore:` / `style:` | その他 | Other (CHANGELOGには含めない) |

---

## Step 3: CHANGELOG.md の更新

[Keep a Changelog](https://keepachangelog.com/) 形式に準拠する。

`CHANGELOG.md` がなければ新規作成、あれば先頭に追記する。

### フォーマット

```markdown
# Changelog

## [X.Y.Z] - YYYY-MM-DD

### Added
- feat: コミットからの機能追加一覧

### Fixed
- fix: コミットからのバグ修正一覧

### Changed
- refactor/perf: コミットからの変更一覧

### Documentation
- docs: コミットからのドキュメント変更一覧
```

**ルール:**
- 空のセクションは含めない（例: fix コミットがなければ Fixed セクションは省略）
- コミットメッセージの type プレフィックスは除去してエントリに記載
- Issue番号やPR番号がある場合はリンクとして含める

---

## Step 4: リリースノート生成

GitHub Releases に投稿可能な形式で生成する。

### フォーマット

```markdown
## What's Changed

### New Features
- 機能1の説明 (#PR番号)
- 機能2の説明 (#PR番号)

### Bug Fixes
- 修正1の説明 (#PR番号)

### Other Changes
- その他の変更

**Full Changelog**: https://github.com/[owner]/[repo]/compare/[前回タグ]...[新タグ]
```

**ルール:**
- コミットメッセージをそのまま使わず、ユーザー向けに読みやすく書き直す
- 技術的な詳細（リファクタリング、テスト追加等）はリリースノートから除外
- 空のセクションは含めない

---

## Step 5: ユーザー確認

以下を出力してユーザーに確認する：

1. **CHANGELOG.md の差分を表示** - 追記された内容を確認
2. **リリースノートをコンソールに出力** - GitHub Releases に投稿する内容を確認
3. **次のアクション提案:**
   - `git tag vX.Y.Z` でタグ作成
   - `gh release create vX.Y.Z --notes-file <file>` でGitHub Release作成
   - または手動でGitHub Releases に投稿

ユーザーの承認後にのみ、CHANGELOG.md をコミットする。
