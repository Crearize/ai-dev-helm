---
name: browser-agent
description: UI実装後の検証時に使用。agent-browser CLIでブラウザ上の動作を手動検証する。「UIを確認」「画面テスト」と言われたら使用（プロジェクトの E2E スイート実行は quality-check Step 5（提案ベース）/ server-startup が担当）。
---

# Browser Agent Skill - agent-browser CLIによるUI検証

## 前提条件

- `agent-browser` がインストール済み（`npm install -g agent-browser && agent-browser install`）
- フロントエンドとバックエンドが起動済み（server-startupスキル参照）

## Core Workflow

```
open → snapshot → screenshot → 操作 → snapshot → screenshot
```

必ず **snapshot（構造確認）と screenshot（視覚確認）の両方** を取る。

## Quick Reference

```bash
# 基本操作
agent-browser open <url>              # ページを開く
agent-browser snapshot                # アクセシビリティツリー（ref付き）を取得
agent-browser screenshot              # 現在のビューポートをキャプチャ
agent-browser screenshot --full       # フルページキャプチャ
agent-browser screenshot --annotate   # 要素ラベル付きキャプチャ

# 操作
agent-browser fill <sel> "text"       # クリア後入力
agent-browser click <sel>             # クリック
agent-browser select <sel> "option"   # セレクト
agent-browser press Enter             # キー入力

# 待機
agent-browser wait --load networkidle # ネットワーク安定待ち
agent-browser wait <selector>         # 要素出現待ち
agent-browser wait --text "Welcome"   # テキスト出現待ち

# 検査
agent-browser get text <sel>          # テキスト取得
agent-browser get url                 # 現在のURL
agent-browser errors                  # エラー確認

# セマンティック検索
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "test@test.com"

# ビューポート
agent-browser set viewport 375 812    # モバイル（iPhone）
agent-browser set viewport 768 1024   # タブレット
agent-browser set viewport 1280 720   # デスクトップ

# 状態リセット
agent-browser close                   # ブラウザを閉じる
```

## 検証チェックリスト

### 1. 表示確認（必須）

```bash
agent-browser open <url>
agent-browser wait --load networkidle
agent-browser screenshot --full
agent-browser snapshot
agent-browser errors
agent-browser close              # 検証完了後に必ず実行
```

### 2. インタラクション検証（フォーム/ボタンがある場合）

```bash
# 正常系
agent-browser fill '[data-testid="email-input"]' "valid@example.com"
agent-browser click '[data-testid="submit-button"]'
agent-browser wait --load networkidle
agent-browser screenshot

# 異常系
agent-browser open <url>
agent-browser fill '[data-testid="email-input"]' "invalid"
agent-browser click '[data-testid="submit-button"]'
agent-browser screenshot
```

### 3. レスポンシブ確認（UIコンポーネントの場合）

```bash
agent-browser set viewport 375 812
agent-browser screenshot mobile.png
agent-browser set viewport 1280 720
```

### 4. 終了（必須 - 全検証後に必ず実行）

```bash
agent-browser close
```

> ブラウザプロセスを残すとプロセスが大量に残りCPUを消費する。
> 検証が正常終了・異常終了を問わず、必ず `agent-browser close` を実行すること。

## ルール

1. **コードを読むな、画面を見ろ**: ソースコード分析は最小限にし、ブラウザの結果に集中する
2. **screenshot必須**: snapshotだけでは色・レイアウト・視覚的バグがわからない
3. **正常系と異常系の両方をテスト**: 正しい入力だけでなく、空入力・不正入力も試す
4. **refは再取得**: ページ遷移やDOM変更後は必ず `snapshot` を再実行
5. **errorsを確認**: ページ表示後とインタラクション後に `errors` でJSエラーを確認
6. **本番環境に対するテスト実行禁止**
7. **必ずcloseする**: 検証完了後、必ず `agent-browser close` を実行
