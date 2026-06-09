---
name: server-startup
description: 開発サーバー・E2E・ブラウザ検証時に使用。既存プロセスを停止してからプロジェクト指定ポートで起動し、作業後に必ず停止する。
---

# Server Startup Skill - 開発サーバー起動

## 禁止事項（最重要）

> **以下は絶対に禁止。違反は許容されない。**

- **ポート変更禁止**: プロジェクトで指定されたポート以外での起動は禁止
- **ポート競合時に別ポート使用禁止**: 必ず既存プロセスを停止する
- **片方だけの起動禁止**: 再起動時はフロントエンド・バックエンド両方を必ず再起動する
- **停止確認省略禁止**: 作業完了後はポートがLISTENしていないことまで確認する

## 適用対象

以下の作業では、必ずこのスキルを使用する。

- 開発サーバーの起動・再起動
- E2Eテスト
- ブラウザ検証
- UI実装後の動作確認
- API疎通確認

worktree内で作業している場合は、`worktree-parallel` スキルで渡されたポートレジストリ（メインチェックアウト直下の `.worktrees/.ports.json`）で割り当てられたポートを「プロジェクト指定ポート」として扱う。

## 再起動手順（必須）

**サーバーを使う作業の開始時は、必ず以下の手順を順番に実行すること。**

### Step 1: 既存プロセスの停止（毎回必ず実行）

起動前に**必ず**既存プロセスを確認し、動いていれば停止する。
この手順をスキップしてはならない。

**Windows（MSYS/Git Bash）:**
```bash
# ポート確認と停止
netstat -ano | grep ":[PORT] " | grep LISTENING
# LISTENINGがあれば → taskkill //PID <PID> //F
```

**Windows（PowerShell）:**
```powershell
$connections = Get-NetTCPConnection -LocalPort [PORT] -State Listen -ErrorAction SilentlyContinue
$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  Stop-Process -Id $_ -Force
}
```

**macOS / Linux:**
```bash
# ポート確認と停止
lsof -i :[PORT]
# プロセスがあれば → kill -9 <PID>
```

> **なぜ必須か**: 古いプロセスが残っていると、新しいプロセスが`EADDRINUSE`で起動失敗し、
> 古い（コード変更が反映されていない）サーバーが動き続ける。

### Step 2: バックエンド起動

プロジェクトの CLAUDE.md に記載されたバックエンド起動コマンドを実行する。
worktree内では、渡されたポートレジストリのバックエンド割当ポートを使用する。

### Step 3: フロントエンド起動

プロジェクトの CLAUDE.md に記載されたフロントエンド起動コマンドを実行する。
worktree内では、渡されたポートレジストリのフロントエンド割当ポートを使用する。

### Step 4: 起動確認（両方確認すること）

バックエンド・フロントエンドの両方がレスポンスを返すことを確認する。

**両方が正常応答するまで起動完了とみなさない。**

### Step 5: 起動失敗時のログ確認

バックグラウンド実行したコマンドの出力を必ず確認し、
`EADDRINUSE`、`FAILED TO START`、`Error` 等がないことを確認する。

---

## サーバー停止手順（作業完了後に必須）

**E2Eテストやサーバーを使う作業が完了したら、必ずサーバーを停止すること。**
サーバーを起動したまま放置すると、プロセスが大量に残りリソースを消費する。

### 停止手順

**Windows（MSYS/Git Bash）:**
```bash
netstat -ano | grep ":[PORT] " | grep LISTENING
# LISTENINGがあれば → taskkill //PID <PID> //F //T
```

**Windows（PowerShell）:**
```powershell
$connections = Get-NetTCPConnection -LocalPort [PORT] -State Listen -ErrorAction SilentlyContinue
$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  Stop-Process -Id $_ -Force
}
```

**macOS / Linux:**
```bash
lsof -i :[PORT] -t | xargs kill -9
```

### 停止確認（必須）

停止後、ポートがLISTENしていないことを確認する。

**Windows（PowerShell）:**
```powershell
Get-NetTCPConnection -LocalPort [PORT] -State Listen -ErrorAction SilentlyContinue
# 何も表示されなければ停止完了
```

**macOS / Linux:**
```bash
lsof -i :[PORT]
# 何も表示されなければ停止完了
```

## チェックリスト

- [ ] 起動前に既存プロセスを確認した
- [ ] 既存プロセスがあれば停止した
- [ ] プロジェクト指定ポート、またはworktree割当ポートで起動した
- [ ] 起動ログに `EADDRINUSE` や起動失敗がないことを確認した
- [ ] 作業完了後にサーバーを停止した
- [ ] 停止後、ポートがLISTENしていないことを確認した
