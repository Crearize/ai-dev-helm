---
name: worktree-parallel
description: Git worktree を使った並列開発時に使用。配置・ポート割当・環境コピー・クリーンアップを標準化する。
---

# Worktree Parallel Skill - Git Worktree 並列開発支援

## 目的

同一リポジトリ内で複数の独立タスクを並列に進める際、worktree の配置、ブランチ、ポート、環境ファイル、終了処理を統一する。

SuperPowers の `using-git-worktrees` で分離ワークスペースを確保したうえで、このスキルのプロジェクト固有ルールを適用する。

---

## 最重要ルール

- **1 worktree = 1 ブランチ = 1 Issue** を原則とする
- worktree はリポジトリルートの `.worktrees/` 配下に作成する
- worktree 名はブランチ名の `/` を `-` に置換したものにする
- worktree 内のエージェントは自分の worktree 外のファイルを変更しない
- worktree でサーバーを起動する場合は、必ずメインチェックアウト直下のポートレジストリで割り当てられたポートのみを使う
- 作業完了後は `git worktree remove` と `git worktree prune` で孤児状態を残さない

---

## Step 0: 前提確認

```bash
git branch --show-current
git status --short
git worktree list
```

確認すること:

- 現在のブランチが `main` / `master` ではない、またはこれから新規ブランチを作る
- 未コミット変更がある場合、その変更が現在のタスクに関係する
- 既に同じ Issue / ブランチ用の worktree が存在しない

---

## Step 1: `.worktrees/` の安全確認

`.worktrees/` は必ず Git 追跡対象外にする。

**bash:**
```bash
# パスは末尾スラッシュ付きで指定すること（ディレクトリ未作成でも正しく判定するため）
git check-ignore -q .worktrees/ || echo ".worktrees/" >> .gitignore
```

**PowerShell:**
```powershell
git check-ignore -q .worktrees/
if ($LASTEXITCODE -ne 0) { Add-Content -Path .gitignore -Value ".worktrees/" }
```

`.gitignore` を変更した場合は、worktree 作成前にその変更をコミット対象として扱う。未追跡の worktree 内容が誤ってコミットされないことを最優先する。

---

## Step 2: Worktree 作成

**bash:**
```bash
BRANCH_NAME="[type]/[description]-[issue-number]"
WORKTREE_NAME="${BRANCH_NAME//\//-}"
WORKTREE_PATH=".worktrees/${WORKTREE_NAME}"

git worktree add "${WORKTREE_PATH}" -b "${BRANCH_NAME}"
```

**PowerShell:**
```powershell
$BranchName = "[type]/[description]-[issue-number]"
$WorktreeName = $BranchName -replace '/', '-'
$WorktreePath = ".worktrees/$WorktreeName"

git worktree add $WorktreePath -b $BranchName
```

既にブランチが存在する場合は `-b` を外して同じパスに追加する:

```bash
git worktree add "${WORKTREE_PATH}" "${BRANCH_NAME}"
```

作成後は対象 worktree に移動し、以降の変更はその中だけで行う。

---

## Step 3: ポートレジストリ

worktree ごとのポートは、**メインチェックアウト直下**の `.worktrees/.ports.json` で管理する。

worktree 内からの相対パス（`../.ports.json` など）は worktree の配置に依存して壊れやすいため、メインチェックアウトで作成時に絶対パスを控えてエージェントへ渡す。

**bash:**
```bash
PORT_REGISTRY="$(pwd -P)/.worktrees/.ports.json"
```

**PowerShell:**
```powershell
$PortRegistry = Join-Path (Get-Location).Path ".worktrees/.ports.json"
```

### 形式

```json
{
  "base": {
    "frontend": 3000,
    "backend": 8080
  },
  "allocations": {
    "feat-example-123": {
      "slot": 2,
      "frontend": 3010,
      "backend": 8090
    }
  }
}
```

### 割当ルール

- メインチェックアウトは常にプロジェクト標準のベースポートを使う
- worktree は空いている `slot` を 2 から順に割り当てる
- `slot` ごとのポートは `base + ((slot - 1) * 10)` とする
- 既存割当がある worktree は同じポートを再利用する
- 割当ポートで既存プロセスが動いている場合、別ポートに逃げずに既存プロセスを停止する

### 手順

1. `CLAUDE.md` / `AGENTS.md` / `.cursorrules` の Development Server Ports を確認する
2. メインチェックアウト直下の `.worktrees/.ports.json` がなければ作成する
3. 現在の worktree 名に対応する割当を追加または再利用する
4. `.env.local` などの PORT 系変数に割当ポートを反映する

---

## Step 4: 環境ファイルと依存関係

worktree 作成後、メインチェックアウトから未追跡のローカル設定をコピーする。

対象例:

- `.env`
- `.env.local`
- `.env.development`
- `*.local`

注意:

- 秘密情報を含むファイルをコミットしない
- worktree ごとのポート割当がある場合、コピー後に PORT 系変数だけ上書きする
- DB 名、Redis DB、キュー名など共有状態を壊す可能性がある値は worktree ごとに分離する

依存関係はプロジェクトに応じて自動検出して準備する。

```bash
if [ -f pnpm-lock.yaml ]; then
  pnpm install
elif [ -f yarn.lock ]; then
  yarn install
elif [ -f package-lock.json ]; then
  npm ci
elif [ -f package.json ]; then
  npm install
fi

if [ -f build.gradle ] || [ -f build.gradle.kts ]; then ./gradlew build -x test; fi
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi
```

---

## Step 5: 並列エージェント運用

2 つ以上の独立タスクを並列化する場合は、`dispatching-parallel-agents` と組み合わせて worktree 単位で分離する。

各エージェントへの必須指示:

```text
あなたの作業場所は <worktree path> です。
ポートレジストリは <absolute path to .worktrees/.ports.json> です。
この worktree 外のファイルを変更してはいけません。
サーバーを起動する場合はポートレジストリの割当ポートだけを使用してください。
作業完了時は起動したサーバーを停止し、変更内容と検証結果を報告してください。
```

独立していないタスク、共有ファイルへの頻繁な変更が必要なタスク、DB マイグレーション競合が起きるタスクは並列化しない。

---

## Step 6: サーバー起動時の連携

worktree 内で E2E テスト、ブラウザ検証、開発サーバー起動が必要な場合は、必ず `server-startup` スキルを併用する。

順序:

1. メインチェックアウト直下の `.worktrees/.ports.json` の割当ポートを確認
2. 割当ポートで既に動いているプロセスを停止
3. 割当ポートでサーバーを起動
4. テストまたは検証を実行
5. 作業完了時にサーバーを停止
6. ポートが LISTEN していないことを確認

---

## Step 7: 完了・クリーンアップ

マージ / PR 作成 / 破棄の判断は `superpowers:finishing-a-development-branch` スキルに従う。
PR がマージされた、または作業を破棄する判断をしたら、worktree とブランチを削除する。

```bash
git worktree remove ".worktrees/<worktree-name>"
git worktree prune
git branch -d "<branch-name>"   # マージ済みを確認してから削除。破棄時のみ -D を使用
```

メインチェックアウト直下の `.worktrees/.ports.json` から該当 worktree の割当を削除する。

削除前に必ず確認すること:

- worktree 内に未コミット変更が残っていない
- 起動中サーバーが残っていない
- PR / Issue / ブランチの最終状態が明確である

---

## チェックリスト

- [ ] `.worktrees/` が Git 追跡対象外である
- [ ] worktree 名がブランチ名と対応している
- [ ] メインチェックアウト直下の `.worktrees/.ports.json` に割当がある
- [ ] PORT 系 env が割当ポートに更新されている
- [ ] 依存関係のセットアップが完了している
- [ ] 並列エージェントが worktree 外を変更しないよう指示されている
- [ ] 作業完了時にサーバーを停止した
- [ ] PR マージ後に worktree・ブランチ・ポート割当を削除した
