# ai-dev-helm

AI コーディングツール（Claude Code, Cursor, Codex）のための汎用開発基盤テンプレートです。

「AI に開発を手伝ってもらいたいけど、毎回同じことを教えるのが面倒」「チーム全員が同じ品質基準で AI を使いたい」——そんな課題を解決します。

## ai-dev-helm でできること

- **スキル**: AI に「やり方」を教える手順書。設計→計画→実装→テスト→レビューの開発フロー全体をカバー
- **ルール**: AI が守るべきコーディング規約。言語・フレームワークごとに定義
- **レビューガイド**: AI がコードレビューする際のチェックリスト
- **開発ドキュメント**: コーディング規約、命名規則、API 設計規約などのベストプラクティス集
- **セットアップ自動化**: 1 コマンドでプロジェクトに導入。Claude Code / Cursor / Codex に対応

---

## 目次

- [クイックスタート](#クイックスタート)
- [セットアップの流れ（詳細）](#セットアップの流れ詳細)
- [スキル一覧](#スキル一覧)
- [品質チェック（quality-check）の詳細](#品質チェックquality-checkの詳細)
- [安全設計](#安全設計)
- [リポジトリ構造](#リポジトリ構造)
- [セットアップ後のプロジェクト構造](#セットアップ後のプロジェクト構造)
- [共有ドキュメントの詳細](#共有ドキュメントの詳細)
- [レビューガイドの詳細](#レビューガイドの詳細)
- [技術スタック別ルールの詳細](#技術スタック別ルールの詳細)
- [CLAUDE.md テンプレートの設計](#claudemd-テンプレートの設計)
- [カスタマイズ方法](#カスタマイズ方法)
- [技術スタックの追加](#技術スタックの追加)
- [superpowers 自動同期](#superpowers-自動同期)
- [FAQ](#faq)

---

## クイックスタート

### 前提条件

- Node.js 18 以上がインストールされていること
- Claude Code または Cursor がインストールされていること

### 1. プロジェクトに導入（npx で即実行）

```bash
# プロジェクトのルートに移動
cd /path/to/your-project

# セットアップ実行（git clone 不要）
npx @crearize/ai-dev-helm init
```

### 2. 個人環境のセットアップ（任意）

破壊的なコマンドの実行を防止するグローバル設定を追加します。

```bash
npx @crearize/ai-dev-helm personal
```

### ローカルインストールで実行する場合

```bash
# リポジトリを取得
git clone https://github.com/Crearize/ai-dev-helm.git

# プロジェクトのルートに移動して実行
cd /path/to/your-project
node /path/to/ai-dev-helm/bin/cli.js init
```

---

## セットアップの流れ（詳細）

### `ai-dev-helm init` の対話フロー

セットアップは対話形式で進みます。以下が実際の流れです。

#### Step 1: プロジェクト名の入力

```
ai-dev-helm Setup
=================

Project initialization mode

Project name: MyApp
```

ここで入力した名前が `CLAUDE.md` や `.cursorrules` のヘッダーに反映されます。

#### Step 2: AI ツールの選択

```
Select AI tool(s) (enter numbers separated by spaces, e.g. "1 3"):
  1) Claude Code
  2) Cursor
  3) Codex (OpenAI)
> 1 3
```

使用する AI ツールを選びます（複数可、スペース区切り）。例えば Claude Code と Codex を併用したい場合は `1 3` と入力します。

#### Step 3: スキル範囲の選択

```
Select skill scope:
  1) All skills (superpowers + project)
  2) superpowers skills only
  3) project skills only
> 1
```

| 選択肢 | 内容 |
|--------|------|
| All skills | 開発プロセス（superpowers）+ プロジェクト運用（project）の全スキル |
| superpowers only | 設計・計画・デバッグなど開発プロセスのスキルのみ |
| project only | 品質チェック・ブランチ管理などプロジェクト運用のスキルのみ |

#### Step 4: 技術スタックの選択

```
Available tech stacks (enter numbers separated by spaces):
  1) java-springboot
  2) nextjs-react
> 1 2
```

プロジェクトで使う技術スタックを選びます（複数可、スペース区切り）。
選んだスタックに応じて、対応するコーディングルール・レビューガイド・ドキュメントが配置されます。

> **Note**: スタックが 1 つしかない場合は自動適用されるため、この選択は表示されません。

#### Step 5: セットアップ完了

```
--- Setting up skills ---
  Skills copied to skills/

--- Setting up documents and review guides ---
  Documents and review guides copied
  PR template copied

--- Setting up AI tool configuration ---
Setting up Claude Code...
  Symlink created: .claude/skills -> ../skills
  settings.json created
  CLAUDE.md created
  Claude Code setup complete
Setting up Cursor...
  Symlink created: .cursor/skills -> ../skills
  Rule created: backend-coding.mdc
  Rule created: frontend-coding.mdc
  .cursorrules created
  Cursor setup complete

Setup complete!

Next steps:
  1. Review and customize CLAUDE.md / .cursorrules
  2. Update tech stack and port information
  3. Add project-specific coding rules
  4. Commit the generated files
```

### `ai-dev-helm personal` の対話フロー

個人のグローバル環境に安全設定を追加します。

```
ai-dev-helm Setup
=================

Personal environment setup

Available options:

  1) Claude Code global settings
     Block destructive commands, safety hooks

  2) Cursor global settings guide
     Copy recommended rules to clipboard

  3) Codex global settings
     Merge ~/.codex/config.toml with safe defaults + rules

Select options (space-separated): 1 2 3
```

| 選択肢 | 何が起きるか |
|--------|-------------|
| 1) Claude Code | `~/.claude/settings.json` に破壊的コマンドのブロックルールを追加（既存設定は自動バックアップ） |
| 2) Cursor | 推奨ルールをクリップボードにコピー（Cursor の設定画面に手動で貼り付け） |
| 3) Codex | `~/.codex/config.toml` に安全デフォルト（approval_policy / sandbox_mode / model）と破壊的コマンド拒否 `[[rules]]` をマージ（既存設定は自動バックアップ） |

**ブロックされるコマンドの例:**
- `rm -rf /`, `rm -rf ~`, `rm -rf .`
- `git push --force` (main/master ブランチ)
- `git reset --hard`
- `git clean -fd`
- `docker system prune`
- `npm publish`, `pnpm publish`, `yarn publish`

---

## スキル一覧

スキルは AI に「どうやって作業するか」を教える手順書です。Claude Code では `/スキル名` で呼び出せます。

### superpowers スキル（開発プロセス）

[superpowers](https://github.com/obra/superpowers) プラグインから抽出した、開発プロセス全体をカバーするスキルです。

| スキル名 | 概要 | いつ使うか |
|---------|------|-----------|
| **brainstorming** | アイデアを設計に落とし込む | 新機能を作る前に要件・設計を探索する |
| **writing-plans** | 実装計画を策定する | 設計完了後、コードに触る前に計画を書く |
| **executing-plans** | 計画を実行する | 書いた計画に基づいてタスクを実行する |
| **subagent-driven-development** | サブエージェントで並列実装 | 独立したタスクを並列に実行する |
| **test-driven-development** | TDD で実装する | テストを先に書き、実装を後から行う |
| **systematic-debugging** | 体系的にデバッグする | バグ・テスト失敗に遭遇した時 |
| **dispatching-parallel-agents** | 並列エージェントを活用 | 2 つ以上の独立タスクを同時に処理する |
| **requesting-code-review** | コードレビューを依頼する | 実装完了後、マージ前の品質確認 |
| **receiving-code-review** | コードレビューを受ける | レビューフィードバックを受けた時の対応 |
| **verification-before-completion** | 完了前の検証 | 作業完了を宣言する前に証拠を確認する |
| **finishing-a-development-branch** | ブランチ完了処理 | 実装・テスト完了後のマージ/PR/クリーンアップ判断 |
| **using-git-worktrees** | Git Worktree を活用 | 現在の作業を中断せずに別機能を開発する |
| **using-superpowers** | スキルシステムの初期化 | 会話開始時に関連スキルを自動検出する |
| **writing-skills** | 新しいスキルを書く | カスタムスキルの作成・テスト |

### project スキル（プロジェクト運用）

日々の開発作業を支援するプロジェクト運用スキルです。プロジェクトに合わせてカスタマイズして使います。

| スキル名 | 概要 | いつ使うか |
|---------|------|-----------|
| **branch-workflow** | ブランチ作業フロー | 作業開始時の Issue 作成・ブランチ作成 |
| **quality-check** | 品質チェック | push 前の静的チェック・テスト・レビュー |
| **server-startup** | サーバー起動 | E2E・ブラウザ検証・開発サーバーの起動/停止手順 |
| **worktree-parallel** | Worktree 並列開発 | Git worktree の配置・ポート割当・環境コピー・クリーンアップ |
| **backend-development** | バックエンド開発 | バックエンド実装時の規約・パターン |
| **frontend-development** | フロントエンド開発 | フロントエンド実装時の規約・パターン |
| **database-migration** | DB マイグレーション | マイグレーションファイルの作成手順 |
| **browser-agent** | ブラウザテスト | UI 実装後のブラウザ上の動作検証 |
| **feature-documentation** | 機能・知識ドキュメント化 | 機能/サービス/要件/前提条件を追加・変更したとき。新規ならドキュメント作成、既存があれば更新 |
| **self-improvement** | 自己改善ハーネス | 作業完了前に改善候補を抽出し、承認されたルール・スキル改善を同じブランチで反映 |
| **implementation-report** | 実装レポート | PR 作成時の実装レポート生成 |

### スキルの仕組み

各スキルは `SKILL.md` というファイルで定義されています。

```
skills/
├── superpowers/
│   ├── brainstorming/
│   │   ├── SKILL.md              ← スキル定義（名前・説明・手順）
│   │   ├── visual-companion.md   ← 補助ドキュメント
│   │   └── spec-document-reviewer-prompt.md
│   ├── writing-plans/
│   │   ├── SKILL.md
│   │   └── plan-document-reviewer-prompt.md
│   └── ...
└── project/
    ├── quality-check/
    │   └── SKILL.md
    └── ...
```

`SKILL.md` の先頭には YAML フロントマターがあり、AI ツールがスキルの名前と用途を認識します。

```yaml
---
name: quality-check
description: プッシュ前に必ず実行。静的チェック・テスト・レビューを実施。
---

# Quality Check

（以下、スキルの詳細な手順）
```

---

## 品質チェック（quality-check）の詳細

`quality-check` スキルは、push 前にローカルで品質を担保するための多段ゲートです。CI はビルド確認のみの位置づけで、静的チェック・テスト・レビューは全てローカルで完結します。

### 実行フロー

```
Step 1: 変更領域の判定（git diff でbackend/frontend/docs/infraを自動検出）
  ↓
Step 2: 静的チェック（linter, formatter, build）
  ↓
Step 3: ユニットテスト
  ↓
Step 4: マルチペルソナ・レビュー（最低2サイクル）
  ├── 指摘あり → 修正 → Step 2 に戻る
  └── 指摘なし & 2回以上完了 → Step 5 へ
  ↓
Step 5: E2E テスト
  ↓
Step 5.5: サーバー停止
  ↓
Step 5.75: 自己改善候補の確認
  ↓
Step 6: レポート保存 + フラグファイル作成 → push 可能
```

### 6 つの専門ペルソナによるレビュー

Step 4 では、6 つの異なる専門家ペルソナが並列のサブエージェントとしてレビューを実施します。

| ペルソナ | 重点観点 |
|---------|---------|
| **セキュリティエンジニア** | 脆弱性、認証・認可、データ漏洩、インジェクション、OWASP Top 10、サプライチェーン攻撃 |
| **ソフトウェアアーキテクト** | SOLID/DRY、レイヤー責務、依存関係、拡張性、API 設計の後方互換性 |
| **QA エンジニア** | エッジケース、テスト網羅性、バグの可能性、エラーハンドリング、アクセシビリティ基本要件 |
| **統合アーキテクチャ** | 変更全体の整合性、レイヤー依存方向、既存パターン一貫性、N+1 問題などの統合的パフォーマンス |
| **パフォーマンスエンジニア** | アルゴリズム計算量、クエリ、バンドルサイズ、キャッシュ、スケーラビリティ |
| **要件・仕様整合性レビュアー** | Issue/要件/設計/受け入れ条件と実装の一致、過剰実装・不足実装、ドキュメント乖離 |

### サブエージェントのモデル切り替え

サブエージェント利用時は、依頼内容に応じて利用する AI モデルを切り替えます。計画時のコードベース探索には高速モデル、レビューや設計判断には最高精度モデルを使います。

| ハーネス | 探索・コンテキスト収集 | レビュー・設計判断 |
|---------|----------------------|-------------------|
| Claude Code | Task ツールに `model: sonnet`（単純検索は `haiku`）を明示指定 | `model: fable` を明示指定（利用不可の場合は `opus`） |
| Codex | `gpt-5.4-mini` / `model_reasoning_effort = "medium"` を明示指定 | `gpt-5.5` / `model_reasoning_effort = "high"` を明示指定 |
| Cursor | 依頼内容に応じて高速モデルを動的に選択 | 利用可能な最高精度モデル（Fable 等。なければ Opus クラス）を選択 |

Claude Code / Codex はサブエージェントごとのモデルをテンプレート（`CLAUDE.md` / `AGENTS.md`）で明示指定しています。Cursor は呼び出しごとに動的なモデル選択が可能なため、タスク種別に応じた選択基準を `.cursorrules` に定義しています。

### サイクルルール

- **最低 2 サイクル実行**（指摘ゼロでも 2 回完走。拡充した 6 ペルソナで検出漏れを防ぐ）
- **必須修正（優先度: 高）が 0 件になるまで何度でも繰り返す**
- 修正後は Step 2（静的チェック）から再実行
- 10 サイクル到達時はユーザーに判断を仰ぐ

### 自己改善ハーネス

Step 5.75 では、`self-improvement` スキルによりセッション中の改善候補を確認します。改善候補がある場合はユーザーに適用可否を確認し、承認された変更だけを同じブランチ内で `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `documents/development/coding-rules/` / project スキルへ反映します。候補の有無と判断結果は `.quality-check-report.json` に保存されます。

### レポート出力

結果は `.quality-check-report.json` に保存されます。各サイクルの指摘内容・対応状況・E2E 結果が記録され、`implementation-report` スキルで PR 説明文の生成にも活用されます。

---

## 安全設計

### プロジェクトレベルの保護（settings.json）

#### 破壊的コマンドのブロック

`init` で生成される `.claude/settings.json` には、以下のコマンドがブロックリストとして設定されます。

- `rm -rf /`, `rm -rf ~`, `rm -rf .`
- `sudo rm -rf`, `sudo dd`, `sudo mkfs`, `sudo fdisk`
- `git push --force origin main/master`（`-f` 短縮形も含む）
- `git reset --hard`
- `git clean -fd`
- `docker system prune`
- `npm/pnpm/yarn publish`

#### Push 前の品質チェック強制フック

`settings.json` には `PreToolUse` フックが設定されており、`git push` を実行する際に `.quality-check-passed` フラグファイルの存在をチェックします。

- フラグファイルがない場合: push がブロックされ、品質チェックの実行を促すメッセージが表示される
- フラグファイルがある場合: push が実行され、フラグファイルは自動削除される（ワンタイム）

つまり、push のたびに品質チェックを通す必要があります。

### グローバルレベルの保護（personal コマンド）

`ai-dev-helm personal` で個人環境にも安全設定を適用できます。

#### Claude Code グローバル設定

`~/.claude/settings.json` に以下を安全にマージします。

- **破壊的コマンドのブロック**: プロジェクトレベルと同じブロックリスト
- **モデル設定**: `claude-opus-4-8`
- **Effort Level**: `high`（環境変数で `max` も設定）
- **思考モード**: 常時有効（`alwaysThinkingEnabled: true`）

**マージ時の安全策:**
- 既存ファイルがある場合はタイムスタンプ付きバックアップを自動作成
- 既存の設定値は上書きしない（テンプレートの値はデフォルトとして追加）
- `permissions.deny` はユニオンマージ（既存ルール + テンプレートルールの和集合）
- `hooks` や他の `permissions` 設定は既存のものを保持

**モデルバージョンのアップグレード:**

既存設定の `model` がテンプレート値と異なる場合、対話プロンプトでアップグレードを確認します。

```
Model version mismatch detected:
  Current:  claude-opus-4-7
  Template: claude-opus-4-8
Upgrade model? (y/N):
```

非対話で強制アップグレードしたい場合は `--upgrade-model` フラグを使用します。

```bash
ai-dev-helm personal --upgrade-model
```

#### Cursor グローバル設定

Cursor はコードベースでの設定が困難なため、推奨ルールをクリップボードにコピーする方式です（macOS: pbcopy, Windows: clip, Linux: xclip）。設定画面（Settings → Rules → User Rules）に手動で貼り付けてください。

#### Codex グローバル設定

`~/.codex/config.toml` に以下を安全にマージします（TOML フォーマット）。

- **モデル**: `gpt-5.5`（既存設定は保持、`--upgrade-model` で強制上書き）
- **推論レベル**: `model_reasoning_effort = "high"`
- **承認ポリシー**: `approval_policy = "on-request"`
- **サンドボックス**: `sandbox_mode = "read-only"`（プロジェクトごとに `workspace-write` 等へ昇格可能）
- **破壊的コマンド拒否ルール**: `[[rules]]` テーブルとして `rm -rf /` / 強制 push / `git reset --hard` / `docker system prune` / `npm publish` 等をブロック

既存ファイルがある場合はタイムスタンプ付きバックアップを自動作成し、`rules` リストは `name` をキーに union マージ（既存ルールを保持）します。

---

## リポジトリ構造

```
ai-dev-helm/
├── package.json                # npm パッケージ定義
├── bin/
│   └── cli.js                  # CLI エントリポイント
├── lib/
│   ├── init.js                 # init モードのロジック
│   ├── personal.js             # personal モードのロジック
│   ├── merge-settings.js       # JSON 設定ファイルのマージ
│   └── utils.js                # 共通ユーティリティ
│
├── skills/                     # AI スキル定義
│   ├── superpowers/            #   開発プロセス系（14 スキル）
│   └── project/                #   プロジェクト運用系（13 スキル）
│
├── stacks/                     # 技術スタック別リソース
│   ├── java-springboot/        #   Java + Spring Boot
│   │   ├── rules/              #     コーディングルール
│   │   ├── review-guides/      #     レビューチェックリスト
│   │   └── documents/          #     詳細な規約ドキュメント
│   ├── nextjs-react/           #   Next.js + React
│   │   ├── rules/
│   │   ├── review-guides/
│   │   └── documents/
│   └── _template/              #   新規スタック追加用テンプレート
│
├── shared/                     # 技術スタック非依存のリソース
│   ├── review-guides/          #   共通レビュー基準
│   │   ├── review-docs.md      #     ドキュメントレビュー
│   │   ├── review-infra.md     #     インフラ/CI レビュー
│   │   └── review-prompt.md    #     統合レビュー指示
│   └── documents/              #   共通開発ドキュメント
│       ├── development-policy.md
│       ├── quick-checklist.md
│       ├── error-codes.md
│       ├── naming-conventions.md
│       └── coding-rules/
│           ├── common-rules.md
│           └── api-design-rules.md
│
├── templates/                  # 生成ファイルの雛形
│   ├── CLAUDE.md.template
│   ├── cursorrules.template
│   ├── AGENTS.md.template
│   ├── settings.json.template
│   ├── settings-global.json.template
│   ├── codex-config.toml.template
│   ├── codex-config-global.toml.template
│   ├── codex-hooks.json.template
│   ├── cursor-rule.mdc.template
│   └── PULL_REQUEST_TEMPLATE.md
│
├── configs/                    # AI ツール別ドキュメント
│   ├── claude-code/README.md
│   ├── cursor/README.md
│   └── codex/README.md
│
├── scripts/
│   └── transform-skills.sh    # superpowers スキル変換（CI 用）
│
└── .github/workflows/
    └── sync-superpowers.yml   # superpowers 自動同期ワークフロー
```

---

## セットアップ後のプロジェクト構造

`ai-dev-helm init` を実行すると、以下のファイルがプロジェクトに生成されます。

### Claude Code + Cursor を両方選択した場合

```
your-project/
├── CLAUDE.md                       # Claude Code のメイン設定ファイル
├── .cursorrules                    # Cursor のメイン設定ファイル
│
├── .claude/                        # Claude Code 用ディレクトリ
│   ├── skills -> ../skills         #   スキルへのシンボリックリンク
│   ├── rules/                      #   コーディングルール
│   │   ├── frontend/coding.md
│   │   └── backend/coding.md
│   └── settings.json               #   フック・権限設定
│
├── .cursor/                        # Cursor 用ディレクトリ
│   ├── skills -> ../skills         #   スキルへのシンボリックリンク
│   └── rules/                      #   コーディングルール（.mdc 形式）
│       ├── frontend-coding.mdc
│       └── backend-coding.mdc
│
├── skills/                         # AI スキル（両ツール共有）
│   ├── superpowers/                #   開発プロセススキル
│   └── project/                    #   プロジェクト運用スキル
│
├── .github/                        # GitHub 設定
│   ├── PULL_REQUEST_TEMPLATE.md    #   PR テンプレート
│   ├── review-frontend.md          #   フロントエンドレビューガイド
│   ├── review-backend.md           #   バックエンドレビューガイド
│   ├── review-docs.md              #   ドキュメントレビューガイド
│   ├── review-infra.md             #   インフラレビューガイド
│   └── review-prompt.md            #   統合レビュー指示
│
└── documents/development/          # 開発ドキュメント
    ├── development-policy.md
    ├── quick-checklist.md
    ├── error-codes.md
    ├── naming-conventions.md
    └── coding-rules/
        ├── common-rules.md
        ├── api-design-rules.md
        ├── frontend-rules.md       # (nextjs-react 選択時)
        └── backend-rules.md        # (java-springboot 選択時)
```

### Codex を含めた場合の追加ファイル

```
your-project/
├── AGENTS.md                       # Codex のメイン設定ファイル（プロジェクトルート）
└── .codex/                         # Codex 用ディレクトリ
    ├── skills -> ../skills         #   スキルへのシンボリックリンク
    ├── rules/                      #   コーディングルール
    ├── config.toml                 #   approval_policy / sandbox_mode
    └── hooks.json                  #   PreToolUse フック（quality-check 強制）
```

### 各ファイルの役割

| ファイル | 役割 |
|---------|------|
| `CLAUDE.md` | Claude Code が会話開始時に読み込む設定ファイル。プロジェクト概要、ルール、コマンド一覧を記述 |
| `.cursorrules` | Cursor が参照するプロジェクト設定ファイル |
| `AGENTS.md` | Codex CLI が会話開始時に読み込む設定ファイル（プロジェクトルートからチェーンマージ） |
| `.claude/settings.json` | Claude Code のフック設定。品質チェック未実施の push をブロックするフックなど |
| `.codex/config.toml` | Codex のプロジェクトローカル設定（approval/sandbox） |
| `.codex/hooks.json` | Codex の PreToolUse フック設定。`.quality-check-passed` がないと push をブロック |
| `.claude/rules/` | Claude Code が自動読み込みするコーディングルール |
| `.cursor/rules/*.mdc` | Cursor が自動読み込みするコーディングルール（glob パターンで適用ファイルを制御） |
| `.codex/rules/` | Codex 用のコーディングルール（AGENTS.md から参照） |
| `skills/` | AI スキル。`.claude/skills` / `.cursor/skills` / `.codex/skills` からシンボリックリンクで参照 |
| `.github/review-*.md` | AI がコードレビューする際に参照するチェックリスト |
| `documents/development/` | コーディング規約・命名規則などの開発ドキュメント |

---

## 共有ドキュメントの詳細

`shared/documents/` に含まれるドキュメントは、技術スタックに依存しない共通の開発基準です。`init` 実行時に `documents/development/` へコピーされます。

| ファイル | 内容 |
|---------|------|
| **development-policy.md** | AI 駆動開発の基本方針、開発フロー（ブランチ確認→プロンプト→実装→PR→レビュー→マージ）、プロジェクト構造、API 設計（RESTful エンドポイント規約）、エラーハンドリング（統一レスポンス形式）、ログ戦略（レベル定義、機密情報マスキング）、テスト戦略（カバレッジ目標: 全体 80%+、ビジネスロジック 90%+） |
| **naming-conventions.md** | ファイル・クラス・メソッド・DB・API・Git など全領域の命名規約を統一的に定義。Java（UpperCamelCase/lowerCamelCase）、TypeScript/React（PascalCase コンポーネント、use プレフィックス Hook）、DB（snake_case、複数形テーブル名）、API（/api/v1/resources）など |
| **quick-checklist.md** | 作業前（Issue 作成、ブランチ確認）・作業中（規約遵守、テスト記述）・push 前（quality-check 実行）・PR 作成（implementation-report 実行）のクイックリファレンス |
| **error-codes.md** | エラーコード体系の定義。`[FEATURE]_[TYPE]_[DETAIL]` 形式で HTTP ステータスコードとの対応（400/401/403/404/409/500）を含む |
| **coding-rules/common-rules.md** | Git/GitHub 規約（Conventional Commits 形式）、コメント規約（TODO/FIXME にデッドライン必須）、環境変数管理、セキュリティルール（OWASP Top 10 全項目の対策指針、CSRF 対策、依存パッケージセキュリティ）、パフォーマンスルール（N+1 防止、インデックス設計、ページネーション必須） |
| **coding-rules/api-design-rules.md** | REST API 設計ルール。エンドポイント命名（lowercase + hyphen-case、複数形）、URL ネスト上限（2 階層まで）、HTTP メソッドと冪等性、パス vs クエリパラメータの使い分け、ページネーション仕様（page/size/sort）、エラーレスポンス統一形式、後方互換性ポリシー |

---

## レビューガイドの詳細

`.github/` に配置されるレビューガイドは、AI がコードレビューする際に参照するチェックリストです。

| ファイル | 内容 |
|---------|------|
| **review-prompt.md** | レビューのメタガイド。変更ファイルに応じて該当するガイドのみ適用する。出力は指摘事項のみ（通過した項目は非表示）。Must-Fix / Recommended / Minor / Good Points の 4 段階で分類 |
| **review-backend.md** | バックエンド固有の観点。Google Java Style Guide 準拠、Spring Boot のアノテーション・DI・`@Transactional` の正しい使い方、ORM/クエリ最適化（N+1、インデックス）、DB マイグレーションルール、セキュリティ（Spring Security、JWT、IDOR、CORS）、テストカバレッジ（80%+ ライン、90%+ ビジネスロジック） |
| **review-frontend.md** | フロントエンド固有の観点。TypeScript strict mode 必須、Server/Client Component の適切な選択、React Hook Form + Zod でのバリデーション、TanStack Query の設定（staleTime/gcTime）、パフォーマンス最適化（不要な再レンダリング防止、バンドルサイズ）、アクセシビリティ（WCAG 2.1 AA: コントラスト比 4.5:1、キーボード操作、セマンティック HTML） |
| **review-docs.md** | ドキュメントレビューの観点。構造の一貫性（見出しレベル、目次）、技術的正確性（コード例の動作確認、リンク切れ）、CLAUDE.md との整合性、DB 設計ドキュメント（テーブル定義、インデックス、外部キー） |
| **review-infra.md** | インフラ/CI レビューの観点。GitHub Actions（バージョン固定、timeout 設定、最小権限、シークレット管理）、Docker（マルチステージビルド、非 root ユーザー、ヘルスチェック）、ビルド設定（依存バージョン固定、脆弱性チェック）、セキュリティ（ハードコード秘密鍵の検出、CORS/SSL 設定） |

---

## 技術スタック別ルールの詳細

各技術スタックには、AI ツールが自動読み込みするコーディングルールと、レビュー用の詳細ガイドが含まれています。

### Java + Spring Boot

**コーディングルール** (`.claude/rules/backend/coding.md`):
- インデント 2 スペース、行長上限 100 文字
- コンストラクタインジェクション必須（`@RequiredArgsConstructor`）
- Controller にビジネスロジック禁止、Repository の直接呼び出し禁止
- `@Transactional`（書き込み）/ `@Transactional(readOnly = true)`（読み取り）の使い分け
- DTO は Request/Response/SearchCriteria のサフィックス、バリデーションアノテーション必須
- テストは仕様ベース（実装依存禁止）、モックは外部依存のみ
- パフォーマンス: `EXPLAIN ANALYZE` でクエリ検証、カバリングインデックス、バッチ処理、接続プール設定
- セキュリティ: Spring Security FilterChain、`@PreAuthorize`/`@Secured`、BCrypt、PII マスキング、レートリミット、CORS 明示ホワイトリスト

### Next.js + React

**コーディングルール** (`.claude/rules/frontend/coding.md`):
- TypeScript strict mode 必須、`any` 型禁止（`unknown` を使用）
- Server Component / Client Component の適切な選択、`'use client'` の正しい配置
- ルートに `loading.tsx` / `error.tsx` / `not-found.tsx` を配置
- React Hook Form + Zod（`zodResolver`）でフォーム管理
- 状態管理: TanStack React Query（サーバー状態）、Jotai/Zustand（クライアント状態）
- 1 ファイル 1 コンポーネント、定義時に export
- パフォーマンス: `React.memo`/`useMemo`/`useCallback` で再レンダリング防止、100 件以上のリストは仮想化、`next/image` でサイズ指定、動的 import
- アクセシビリティ: セマンティック HTML（nav/main/section/article）、キーボード操作対応、WCAG 2.1 AA（コントラスト比 4.5:1）、rem ベースのフォントサイズ

### Cursor ルールの自動変換

Cursor を選択した場合、スタック固有のコーディングルール（`.md`）は自動的に `.mdc` 形式に変換されます。

- Markdown の見出しから `description` を抽出
- ディレクトリ名に基づく glob パターンの自動付与（例: `frontend/` → `**/*.ts`, `**/*.tsx` 等）
- glob の有無に応じた `alwaysApply` の自動設定
- YAML フロントマター付きの `.mdc` ファイルとして `.cursor/rules/` に配置

---

## CLAUDE.md テンプレートの設計

`init` で生成される `CLAUDE.md` は、Claude Code が会話開始時に読み込む設定ファイルです。単なるルール集ではなく、AI の行動基準をレベル分けして定義しています。

### SuperPowers 適用ルール

- **1% でも該当する可能性があればスキルを適用する** のが基本原則
- 「簡単だから」「先にコードを読みたい」はスキップの理由にならない
- 複数スキルが該当する場合: プロセススキル（brainstorming, debugging）→ 実装スキルの順

シナリオとスキルの対応表が定義されており、例えば「新機能の前には必ず brainstorming」「バグ調査には systematic-debugging」のように、状況に応じた適切なスキルが自動的に選択されます。

### クリティカルルールのレベル分け

| レベル | 内容 | 例 |
|-------|------|-----|
| **Level 0: 自動実行** | AI が確認なしで自動実行すべき項目 | Issue 作成、ブランチ作成、品質チェック実行、計画のインライン実行 |
| **Level 1: 必須** | 必ず守るべきルール | main で作業しない、ブランチ名に Issue 番号を含める、エラーコードの即時登録 |
| **Level 2: 重要** | 品質を保つためのルール | コーディング規約の遵守、テスト実装、ドキュメント駆動開発 |
| **Level 3: 推奨** | 余裕があれば対応 | パフォーマンス最適化、セキュリティ強化、アクセシビリティ |

### 計画ファイルの管理

- 計画ファイル（`docs/superpowers/plans/*.md`）は**リポジトリにコミットしない**
- 実装中はローカルで保持し、PR マージ後に削除する

---

## カスタマイズ方法

セットアップ後、プロジェクトに合わせてカスタマイズしてください。

### 1. CLAUDE.md / .cursorrules の編集

生成された `CLAUDE.md` にはプレースホルダーやテンプレート的な記述が含まれています。以下を更新してください。

- プロジェクト概要・アーキテクチャの説明
- 技術スタック（使用ライブラリ、バージョン）
- ポート番号
- よく使うコマンド
- プロジェクト固有のルール

### 2. コーディングルールの追加

**Claude Code の場合:**

`.claude/rules/` にカテゴリ別のディレクトリを作成し、`.md` ファイルを追加します。

```markdown
---
title: My Custom Rule
description: プロジェクト固有のルール
globs:
  - "src/**/*.ts"
---

# My Custom Rule

ルールの内容...
```

**Cursor の場合:**

`.cursor/rules/` に `.mdc` ファイルを追加します。

```markdown
---
description: "My Custom Rule"
globs:
  - "src/**/*.ts"
alwaysApply: false
---

# My Custom Rule

ルールの内容...
```

### 3. スキルのカスタマイズ

`skills/project/` 内のスキルはプロジェクトに合わせて編集してください。例えば:

- `server-startup/SKILL.md` — 起動コマンドやポート番号を実際のものに変更
- `worktree-parallel/SKILL.md` — worktree 配置、ポート割当、環境コピー方針をプロジェクトに合わせて調整
- `self-improvement/SKILL.md` — 自己改善の反映先や判断基準をプロジェクトに合わせて調整
- `quality-check/SKILL.md` — チェック項目やテストコマンドを調整
- `backend-development/SKILL.md` — 使用フレームワークに合わせた規約に変更

> **Note**: `skills/superpowers/` は汎用的な開発プロセススキルのため、通常はカスタマイズ不要です。

### 4. レビューガイドの調整

`.github/review-*.md` のチェックリストを、プロジェクトの技術スタックや要件に合わせて調整してください。

---

## 技術スタックの追加

ai-dev-helm に新しい技術スタック（例: Python + Django）を追加する方法です。

### 1. テンプレートをコピー

```bash
cp -r stacks/_template stacks/python-django
```

### 2. ファイルを編集

```
stacks/python-django/
├── rules/
│   └── coding.md            ← コーディングルール（AI が自動読み込み）
├── review-guides/
│   └── review.md            ← レビューチェックリスト
└── documents/
    └── coding-rules/
        └── rules.md         ← 詳細なコーディング規約
```

各テンプレートファイルにはセクション構成のガイドが含まれているので、それに沿って記述してください。

### 3. セットアップで選択可能に

`stacks/` ディレクトリに配置するだけで、セットアップが自動的に検出します。
次回 `ai-dev-helm init` を実行すると、選択肢に表示されます。

---

## superpowers 自動同期

`skills/superpowers/` は [superpowers](https://github.com/obra/superpowers) プラグイン（v5.1.0）から抽出したスキルです。

### 自動同期の仕組み

GitHub Actions ワークフロー（`.github/workflows/sync-superpowers.yml`）が毎日実行され:

1. 現在同期中のバージョン（`.superpowers-version`）を確認
2. superpowers リポジトリの最新リリースを取得
3. 新バージョンがあれば、スキルを変換・コピーして PR を自動作成

### 手動で同期する

GitHub の Actions タブから `Sync Superpowers Skills` ワークフローを手動実行できます。

---

## FAQ

### Q: Claude Code / Cursor / Codex のどれを使えばいいですか？

どれでも問題なく使えます。複数併用する場合は、セットアップ時に対応する番号をスペース区切りで入力してください（例: `1 2 3` で 3 つすべて）。スキルは共有ディレクトリ（`skills/`）を通じて全ツールで共有されます。

### Q: Codex でも push 前の品質チェックは強制されますか？

されます。`.codex/hooks.json` の `PreToolUse` フックが `git push` をインターセプトし、`.quality-check-passed` フラグファイルがなければブロックします。Claude Code と同等の仕組みで、Codex 側がプロジェクトを trusted としてロードする必要があります（Codex 起動時に確認されます）。

### Q: セットアップ後に ai-dev-helm リポジトリは必要ですか？

`ai-dev-helm init` はファイルをコピーするため、セットアップ後は不要です。ただし、以下の場合に再度必要になります:

- 新しいプロジェクトにセットアップしたい時（`npx` なら都度ダウンロードされるので不要）
- `personal` モードでグローバル設定を更新したい時
- 新しいバージョンのスキル・ルールを取得したい時

### Q: 既存の CLAUDE.md や .cursorrules がある場合は？

既存ファイルがある場合は上書きされません。スキップされてそのまま残ります。

### Q: スキルが多すぎて全部は使わない場合は？

セットアップ時にスキル範囲を選択できます。また、セットアップ後に不要なスキルディレクトリを削除しても問題ありません。

### Q: Windows で動作しますか？

Node.js ベースの CLI なので、Windows / macOS / Linux すべてで動作します。シンボリックリンクの代わりに NTFS ジャンクション（管理者権限不要）を使用し、失敗時はコピーにフォールバックします。

### Q: 技術スタックが Next.js + Spring Boot 以外の場合は？

共通のドキュメント（`shared/`）はどの技術スタックでも活用できます。スタック固有のルール・ガイドは、`stacks/_template/` をベースに新しいスタックを追加してください。

---

## ライセンス

MIT
