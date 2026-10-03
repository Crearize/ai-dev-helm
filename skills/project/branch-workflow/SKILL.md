---
name: branch-workflow
description: 作業開始時に使用。mainブランチでの作業禁止。Issue先行作成必須。
---

# Branch Workflow Skill - ブランチ・Issue作業フロー

## 禁止事項（最重要）

> **以下は絶対に禁止。違反は許容されない。**

- **mainブランチでの直接作業禁止**: すべての変更は機能ブランチで行う
- **Issue番号なしのブランチ作成禁止**: 必ずIssue番号をブランチ名に含める

## 作業開始前の必須チェック

### Step 1: 現在のブランチを確認

```bash
git branch --show-current
```

- `main` と表示された場合 → **作業禁止！** Step 2へ
- `main` 以外の場合 → 作業内容とブランチ名が一致しているか確認

### Step 2: Issue作成（mainの場合必須）

```bash
gh issue create --title "機能名" --body "詳細説明"
```

### Step 3: ブランチ作成

```bash
git checkout -b [タイプ]/[作業内容]-[Issue番号]
```

## ブランチ命名規則

| タイプ | 用途 | 例 |
|--------|------|-----|
| `feature/` | 新機能開発 | `feature/add-login-123` |
| `fix/` | バグ修正 | `fix/auth-bug-456` |
| `docs/` | ドキュメント更新 | `docs/update-readme-789` |
| `refactor/` | リファクタリング | `refactor/user-service-101` |
| `test/` | テスト追加・修正 | `test/add-api-tests-102` |

## main への取り込み

main への取り込みは quality-check を完走してから行う。quality-gate の hook は、フラグ（`.quality-check-passed`）が**取り込む commit** を指しているかを確かめる（前回のフラグが残っていても、チェックしていないブランチは取り込めない）。

| 状況 | 手順 |
|------|------|
| リモートがある | feature ブランチを push して PR を作る（`git push -u origin HEAD` → `gh pr create`）。merge は PR で行う |
| リモートが無く、1 つのチェックアウトで作業している | feature 上で quality-check を完走する → `git switch main` → `git merge <feature>`（`--no-ff` 可。main が feature に無いコミットを持っていれば拒否されるので、main を feature に取り込んで quality-check をやり直す）→ `.quality-check-passed` を削除する |
| リモートが無く、main を別の worktree で開いている | 下の「リモートの無いプロジェクトの取り込み」 |

### リモートの無いプロジェクトの取り込み

1. feature の worktree で quality-check を完走し、フラグを作る（フラグは feature の HEAD を指す）
2. main を開いているチェックアウトで `git switch --detach` を実行する（チェックアウト中のブランチは更新できないため）
3. feature の worktree で `git push . HEAD:main` を実行する（fast-forward 以外は git が拒否する。hook はフラグ = HEAD で通す）
4. main のチェックアウトで `git switch main` を実行する
5. `.quality-check-passed` を削除する

`git branch -f main <feature>`・`git update-ref refs/heads/main <feature>`・`git fetch . <feature>:main` も、フラグが `<feature>` の先端を指していれば通るが、手順は上の 1 つにそろえる。

## PR作成時の必須事項

```bash
git commit -m "feat: [機能名]の実装 (closes #[Issue番号])"
```
