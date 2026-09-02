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

### 3. テキストレベル Lint の実行（任意）

言語を問わずテキストレベルで横断チェックする linter を実行します。ハードコードされたシークレット、コメントアウトされたコード塊、期限なし TODO/FIXME、存在しない import、ファイル・ブランチ・コミットメッセージの命名規約を検査します。

```bash
npx @crearize/ai-dev-helm lint [paths..]

# 例: 特定チェックのみ・JSON 出力
npx @crearize/ai-dev-helm lint --checks secrets,import-exists --json
```

- 設定はプロジェクトルートの `.ai-dev-helm-lint.json` で調整できます（`exclude` グロブ、チェックごとの `enabled` / オプション）
- 終了コード: `0` = 問題なし / `1` = 違反あり / `2` = 実行エラー（設定不正など）

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
  4) Custom selection
> 1
```

| 選択肢 | 内容 |
|--------|------|
| All skills | 開発プロセス（superpowers）+ プロジェクト運用（project）の全スキル |
| superpowers only | 設計・計画・デバッグなど開発プロセスのスキルのみ |
| project only | 品質チェック・ブランチ管理などプロジェクト運用のスキルのみ |
| Custom selection | superpowers は全て取り込み、project スキルを番号指定で個別選択する |

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
  Lint assets copied to lint/
  PR template copied
  .gitignore updated (4 entries added)

--- Setting up AI tool configuration ---
Setting up Claude Code...
  Symlink created: .claude/skills -> ../skills
  quality-gate hook copied
  settings.json created
  CLAUDE.md created
  Claude Code setup complete
Setting up Cursor...
  Symlink created: .cursor/skills -> ../skills
  Rule created: backend-coding.mdc
  Rule created: frontend-coding.mdc
  .cursorrules created
  Cursor setup complete

  .ai-dev-helm.json written (applied version: x.y.z)

Setup complete!

Next steps:
  1. Review and customize CLAUDE.md / .cursorrules
  2. Update tech stack and port information
  3. Add project-specific coding rules
  4. Run the lint-scaffolding skill to wire the lint/ assets and create the lint:all command
  5. Commit the generated files
```

#### 適用バージョンの記録（`.ai-dev-helm.json`）

init 完了時、プロジェクトルートに `.ai-dev-helm.json` が生成されます。取り込んだ ai-dev-helm のバージョン・ツール・スタック・適用日時が記録されるため、「今このプロジェクトは何バージョンを取り込んでいるか」をいつでも確認でき、次回の同期時に差分確認の起点として使えます。init を再実行すると最新の内容で上書きされます。

```json
{
  "version": "x.y.z",
  "tools": ["claude-code", "cursor"],
  "stacks": ["nextjs-react"],
  "skillScope": "all",
  "appliedAt": "2026-06-10T08:00:00.000Z"
}
```

### 1.12.x からの移行

1.12.x 以前を取り込んでいるプロジェクトは、次の 3 点で最新版に追随します。

1. **`npx ai-dev-helm init` を再実行する** — 新スキル（`test-recommendation`）・台帳雛形・改訂済みドキュメントが配置されます。台帳（`documents/development/test-recommendation-ledger.md`）は copy-if-missing のため、既存の台帳は上書きされません。あわせて quality-gate フックの登録も修復されます: `.claude/settings.json` は `hooks.PreToolUse` の quality-gate エントリの `timeout` が 30 未満（または未指定）なら 30 に引き上げられ、登録自体が無ければテンプレートのエントリが追記されます（既存のユーザー hook・その他のキーは温存）。`.codex/hooks.json` も同様に timeout が引き上げられ、イベント名がトップレベルにある旧形式は `hooks` キー配下へ移行されます。手動で直す場合は、両ファイルの quality-gate エントリの `timeout` が 30 未満なら 30 にしてください（フック本体の内部デッドラインは 20 秒で、それより短い登録だと途中で kill され、出力が無いまま「許可」と解釈されます）
2. **ハーネス設定ファイル（CLAUDE.md / AGENTS.md / `.cursorrules`）の `### Quality Gate Overrides` から `mutation_threshold_high` / `mutation_threshold_medium` / `mutation_mode_medium` の宣言を削除する** — quality-check はこれらのキーを認識しなくなりました（認識するのは `mutation_budget_minutes` のみ）。hook は次期改修（Issue #90）まで旧キーの変更を過剰に検知しますが、フェイルセーフ方向（余分にゲートに掛かるだけ）であり実害はありません
3. **`.quality-check-report.json` を読む自作ツールがある場合は追随する** — 旧トップレベルの `e2e_result` / `e2e_issues` は `e2e` オブジェクトに置き換わり、`mutation.mode` / `mutation.score` / `mutation.threshold` は廃止されました（スキーマは `skills/project/_schemas/quality-check-report.schema.md`）

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
| **test-design** | テスト設計 | 実装前に呼ぶ。High/Medium リスク変更のテストオラクル（期待値の根拠）とファルシフィケーション項目を定義する |
| **quality-check** | 品質チェック | マージ前の静的チェック・テスト・レビューと追加テスト提案 |
| **test-recommendation** | 追加テスト提案 | 変更内容からミューテーション/E2E の実施を提案し、ユーザー判断で実行。quality-check Step 5 から参照実行されるほか単体実行も可能 |
| **server-startup** | サーバー起動 | E2E・ブラウザ検証・開発サーバーの起動/停止手順 |
| **worktree-parallel** | Worktree 並列開発 | Git worktree の配置・ポート割当・環境コピー・クリーンアップ |
| **backend-development** | バックエンド開発 | バックエンド実装時の規約・パターン |
| **frontend-development** | フロントエンド開発 | フロントエンド実装時の規約・パターン |
| **database-migration** | DB マイグレーション | マイグレーションファイルの作成手順 |
| **browser-agent** | ブラウザテスト | UI 実装後のブラウザ上の動作検証 |
| **feature-documentation** | 機能・知識ドキュメント化 | 機能/サービス/要件/前提条件を追加・変更したとき。新規ならドキュメント作成、既存があれば更新 |
| **generate-docs** | ドキュメント生成 | コードベースから API・アーキテクチャ等のドキュメントを生成する |
| **lint-scaffolding** | Lint 資産の配線 | init が配置した `lint/` 資産（ast-grep / ESLint / Checkstyle / ミューテーション設定）の採否判断と配線、カバレッジマップ作成 |
| **log-design** | ログ設計 | ログ出力の設計・レビュー時の観点 |
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
description: マージ前に必ず実行。静的チェック・テスト・レビューを実施。
---

# Quality Check

（以下、スキルの詳細な手順）
```

---

## 品質チェック（quality-check）の詳細

`quality-check` スキルは、main へのマージ前にローカルで品質を担保するための多段ゲートです。CI はビルド確認のみの位置づけで、静的チェック・テスト・レビューは全てローカルで完結します。feature ブランチへの push はゲートされず、ハーネスファイル（CLAUDE.md、スキル等）のみの変更はチェック自体が不要です。ただし次の 2 つはこの免除の対象外で、quality-check（最低でも縮退レビュー）が必要です: (1) ハーネス設定ファイルの差分がゲートパラメータ（`Quality Gate Overrides` のキー）の変更を含む場合、(2) **ゲート制御面ファイル**（quality-check スキル・スキーマ・レビューガイド・hook 実体/登録ファイル・`.codex/config.toml`・`mcp.json`・settings の `hooks` / `permissions.deny` 等 — 正確な集合は quality-check スキルの「ハーネスのみ変更の免除」を参照）に触れる場合。

判断基準そのものは共有ドキュメント側に定義されています。リスクレベル（High/Medium/Low）とレベル別のゲート強度、テストオラクル原則、反復工程の打ち切り基準は `shared/documents/quality-policy.md`、静的チェックで機械的に担保すべき項目の標準（A1〜F2 の25カテゴリ）は `shared/documents/static-check-standard.md` を参照してください。

### 実行フロー

```
Step -1: ハーネスのみ変更か判定（該当なら quality-check 不要）
  ↓
Step 0: ドキュメント更新の確認（feature-documentation）
  ↓
Step 1: 変更領域の判定（git diff でbackend/frontend/docs/infraを自動検出）+ リスクレベル判定（High/Medium/Low）
  ↓
┌─ サイクル（上限3。quality-policy §5）
│ Step 2: 静的チェック = 決定的チェック層（linter, formatter, build。修正1パス + 確認1パス）
│   ↓
│ Step 3: ユニットテスト + テスト設計メモとの照合（High/Medium。test-design スキルのメモと突き合わせ、欠落時は遡及実行）
│   ↓
│ Step 4: マルチペルソナ・レビュー（差分規模に応じ3〜6ペルソナ。Step 2〜3 の結果を入力に含む。ファルシフィケーション型の観点を含む。サイクル2以降は検証レビューに縮退）
│   ↓
│ 統合指摘（Lint 残存・テスト失敗・ペルソナ指摘）の対応
│   ├── 高/中指摘なし → Step 5 へ
│   ├── 残っている → 次サイクル（Step 2 から）
│   └── 上限到達 / 停滞 → ユーザー判断（受容 / 方針変更して追加サイクル / 中断）
└─
  ↓
Step 5: 追加テスト提案（test-recommendation スキル。ミューテーション / E2E の推奨度 + 根拠を提示 → ユーザー判断 → 承認分のみ実行。E2E 実行時のサーバー起動・停止を内包）
  ↓
Step 5.75: 自己改善候補の確認
  ↓
Step 6: レポート保存 + フラグファイル作成（commit 紐付け JSON）→ マージ可能
```

### リスク判定・テスト設計照合・追加テスト提案

Step 1 では変更差分から High/Medium/Low のリスクレベルを判定します。この判定が以降のゲート強度（test-design スキルの要否）と Step 5 の提案ヒューリスティクスの入力を決めます。判定基準とレベル別のゲート強度は `shared/documents/quality-policy.md` を参照してください。

High/Medium リスクの変更は、実装**前**に `test-design` スキルでテストオラクル（期待値の根拠）とファルシフィケーション項目を定義したメモを作成します。Step 3 はこのメモとテストを照合し、メモが未作成の場合はエラーにせずその場で `test-design` を遡及実行して不足テストを補います。

Step 5 では、`test-recommendation` スキルが変更差分から追加テスト（ミューテーションテスト・E2E テスト）の推奨度（`strong` / `recommended` / `none`）を根拠付きで判定・提示し、ユーザー判断を経て**承認された分のみ**を実行します。ミューテーションテストは差分スコープ（Stryker は変更行、PIT は変更クラス）で**ローカル**実行し、スコアによる通過判定は持ちません — 生存ミュータントをトリアージし、対処範囲（その場でテスト追加 / 台帳に持ち越し / 対処不要と判断）をユーザーと合意します。提案の見送り・生存の持ち越しは記録のみで非ブロックです（唯一の例外は E2E を実施して失敗した場合で、実バグとして修正必須になります）。判定・見送りの履歴は永続台帳 `documents/development/test-recommendation-ledger.md` に蓄積され、シナリオ未整備導線の再提案に使われます。ミューテーションテストのツールが未導入のプロダクト、および差分スコープが空の場合は提案せず記録のみ行います。

### 専門ペルソナによるレビュー

Step 4 では、専門家ペルソナが並列のサブエージェントとしてレビューを実施します。差分が200行未満（生成ファイル除外）ならセキュリティ・QA・統合アーキテクチャの3ペルソナ、200行以上なら以下の6ペルソナ全てを適用します。

| ペルソナ | 重点観点 |
|---------|---------|
| **セキュリティエンジニア** | 脆弱性、認証・認可、データ漏洩、インジェクション、OWASP Top 10、サプライチェーン攻撃 |
| **ソフトウェアアーキテクト** | SOLID/DRY、レイヤー責務、依存関係、拡張性、API 設計の後方互換性 |
| **QA エンジニア（ファルシフィケーション型）** | この実装が間違っていることを証明する入力・シナリオ、テスト期待値の妥当性（既知のテスト値へのハードコード、実装と同一ロジックの複製による期待値生成、意味のない assertion）、エッジケース、エラーハンドリング、アクセシビリティ基本要件 |
| **統合アーキテクチャ** | 変更全体の整合性、レイヤー依存方向、既存パターン一貫性、N+1 問題などの統合的パフォーマンス |
| **パフォーマンスエンジニア** | アルゴリズム計算量、クエリ、バンドルサイズ、キャッシュ、スケーラビリティ |
| **要件・仕様整合性レビュアー** | Issue/要件/設計/受け入れ条件と実装の一致、過剰実装・不足実装、ドキュメント乖離 |

パフォーマンスエンジニアと要件・仕様整合性レビュアーには専用のレビューガイド（`.github/review-performance.md` / `.github/review-requirements.md`）が配布されます。

### サブエージェントのモデル切り替え

サブエージェント利用時は、依頼内容に応じて利用する AI モデルを切り替えます。Fable は計画・設計の最初の方向付けに限定し、利用できない場合や Codex 利用時は Claude Opus 5 または GPT-5.6-Sol にフォールバックします。実装などの具体的な作業は Claude Opus 5 / Composer 2.5 Fast / GPT-5.6-Terra（またはエフォートを下げた GPT-5.6-Sol）で行い、レビュー・検証は Claude Opus 5 または GPT-5.6-Sol high で行います。探索・コンテキスト収集には Claude Sonnet 5 を使用します（Sonnet は探索・検索用途に限定し、実装・レビュー・計画には使用しません）。Claude Haiku はどのフェーズでも使用しません。

| ハーネス | 計画・設計の初期判断 | 探索・コンテキスト収集 | 実装・具体的な作業 | レビュー・検証 |
|---------|----------------------|----------------------|--------------------|---------------|
| Claude Code | Task ツールに `model: fable` を明示指定（不可なら `opus`） | `model: sonnet` を明示指定 | `model: opus` を明示指定 | `model: opus` を明示指定 |
| Codex | `gpt-5.6-sol` / `high` | `gpt-5.4-mini` / `model_reasoning_effort = "medium"` を明示指定 | `gpt-5.6-terra`（または `gpt-5.6-sol` でエフォートを `medium`/`low` に下げる） | `gpt-5.6-sol` / `model_reasoning_effort = "high"` を明示指定 |
| Cursor | Fable を優先（不可なら Claude Opus 5 / GPT-5.6-Sol） | Claude Sonnet 5 などの高速モデル（Haiku は使用しない） | Claude Opus 5 / Composer 2.5 Fast / GPT-5.6-Terra / 低エフォート GPT-5.6-Sol | Claude Opus 5 を優先、代替で GPT-5.6-Sol high |

Claude Code の Task ツールの `model` パラメータは短縮エイリアス（`fable` / `opus` / `sonnet` / `haiku`）のみを受理するため、テンプレートでは `claude-opus-5` などのフル ID ではなく短縮名で指定します。また、テンプレートのモデル表はスキル内のモデル選択ガイド（例: subagent-driven-development の Model Selection 節）より優先されます。

Claude Code / Codex はサブエージェントごとのモデルをテンプレート（`CLAUDE.md` / `AGENTS.md`）で明示指定しています。Codex は OpenAI 系モデル専用のため、Fable / Opus など Claude 系モデルへの切り替え対象外です。Cursor は呼び出しごとに動的なモデル選択が可能なため、タスク種別に応じた選択基準を `.cursorrules` に定義しています。

計画の実行はハーネスを問わず**サブエージェント駆動（subagent-driven-development）がデフォルト**です。メインセッション（Fable / GPT-5.6-Sol）は計画・オーケストレーションに専念し、実装タスクは Opus 5 等のサブエージェントに委譲することで、Fable のトークン消費を計画・設計に集中させます。インライン実行（executing-plans）はユーザーが明示的に指示した場合のみ使用します。

### サイクルルール

- **最低 1 サイクル実行**。2 周目以降は直前サイクルで優先度 高/中 の指摘があった場合のみ実施
- **コード変更はペルソナを差分規模で段階化**（200 行未満: 3 ペルソナ / 200 行以上: 6 ペルソナ）。docs/infra のみの変更はペルソナを 3〜5 に絞って縮退（レビューコスト最適化）
- **サイクル 2 以降の Step 4 は検証レビューに縮退**（前サイクルで高/中指摘を出したペルソナのみが修正差分を検証。新規の高指摘が出た場合は次サイクルでフルセットに復帰）
- **高/中指摘が残らなくなるまでサイクルを繰り返す**（上限・停滞検出は quality-policy §5）
- 上限到達・停滞時はユーザーに判断を仰ぐ（受容 / 方針変更して追加サイクル / 中断）

### 自己改善ハーネス

Step 5.75 では、`self-improvement` スキルによりセッション中の改善候補を確認します。改善候補がある場合はユーザーに適用可否を確認し、承認された変更だけを同じブランチ内で `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `documents/development/coding-rules/` / project スキルへ反映します。候補の有無と判断結果は `.quality-check-report.json` に保存されます。

### レポート出力

結果は `.quality-check-report.json` に保存されます。各サイクルの指摘内容・対応状況・E2E 結果に加え、リスクレベル・静的チェックのサイクル数・テスト設計メモとの照合結果・ミューテーションテスト結果・ゲート打ち切り/上書きの記録も含まれ、`implementation-report` スキルで PR 説明文の生成にも活用されます。フィールドの完全な定義は `skills/project/_schemas/quality-check-report.schema.md` を参照してください。

---

## 安全設計

### プロジェクトレベルの保護（settings.json）

#### 破壊的コマンドのブロック

`init` で生成される `.claude/settings.json` には、以下のコマンドがブロックリストとして設定されます。

- `rm -rf /`, `rm -rf ~`, `rm -rf .`（`~/`・`./` 形式も含む）
- `sudo rm -rf`, `sudo dd`, `sudo mkfs`, `sudo fdisk`（引数付きの形式も含む）
- `git push --force origin main/master`（`-f` 短縮形・`--force-with-lease` も含む）
- `git reset --hard`（引数付きも含む）
- `git clean -fd`（追加フラグ付きも含む）
- `docker system prune`
- `npm/pnpm/yarn publish`

#### マージ前の品質チェック強制フック

`settings.json` には `PreToolUse` フックが設定されており、`gh pr merge` / main 上での `git merge` / main への直接 `git push` を実行する際に `.quality-check-passed` フラグの有効性を検証します。**feature ブランチへの push はゲートされません**。

- フラグは quality-check 通過時の HEAD を記録した JSON（`{branch, commit}`）で、消費（削除）されません
- 記録コミット以降の変更がハーネスファイル（CLAUDE.md、スキル等）のみであればフラグは有効なまま。非ハーネスのコード変更が入ると無効になり、再チェックが必要です。**例外**: ゲート制御面ファイル（quality-check スキル・スキーマ・レビューガイド・hook 実体/登録ファイル・`.codex/config.toml`・`mcp.json`・settings の `hooks` / `permissions.deny`）に触れる追加コミットはハーネスファイルであってもフラグを無効化し、hook が `Gate control-plane changed:` でブロックします
- 変更差分全体がハーネスファイルのみのブランチは、フラグ無しでもマージできます（ただしゲートパラメータ（`Quality Gate Overrides` のキー）の変更、またはゲート制御面ファイルへの変更を含む差分はこのカーブアウトにより免除されず、フラグが必要です）

つまり、main に取り込むたびに品質チェックを通す必要がありますが、レビュー後のハーネス微修正で再チェックは発生しません。

### グローバルレベルの保護（personal コマンド）

`ai-dev-helm personal` で個人環境にも安全設定を適用できます。

#### Claude Code グローバル設定

`~/.claude/settings.json` に以下を安全にマージします。

- **破壊的コマンドのブロック**: プロジェクトレベルと同じブロックリスト
- **モデル設定**: `claude-fable-5`（メインセッションは計画・設計を担当。Fable が使えない場合は `claude-opus-5` を手動設定）
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
  Current:  claude-opus-4-8
  Template: claude-fable-5
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

- **モデル**: `gpt-5.6-sol`（既存設定は保持、`--upgrade-model` で強制上書き）
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
│   ├── merge-toml.js           # TOML 設定ファイルのマージ（Codex グローバル設定）
│   ├── lint/                   # 横断リンター（`ai-dev-helm lint`）本体とチェック群
│   └── utils.js                # 共通ユーティリティ
│
├── skills/                     # AI スキル定義
│   ├── superpowers/            #   開発プロセス系（14 スキル）
│   └── project/                #   プロジェクト運用系（15 スキル）
│
├── stacks/                     # 技術スタック別リソース
│   ├── java-springboot/        #   Java + Spring Boot
│   │   ├── rules/              #     コーディングルール
│   │   ├── review-guides/      #     レビューチェックリスト
│   │   ├── documents/          #     詳細な規約ドキュメント
│   │   └── lint/               #     Checkstyle / ArchUnit / PIT（mutation）設定
│   ├── nextjs-react/           #   Next.js + React
│   │   ├── rules/
│   │   ├── review-guides/
│   │   ├── documents/
│   │   └── lint/               #     ESLint / ast-grep / Stryker（mutation）設定
│   └── _template/              #   新規スタック追加用テンプレート
│
├── shared/                     # 技術スタック非依存のリソース
│   ├── review-guides/          #   共通レビュー基準
│   │   ├── review-docs.md      #     ドキュメントレビュー
│   │   ├── review-infra.md     #     インフラ/CI レビュー
│   │   ├── review-performance.md #    パフォーマンスレビュー
│   │   ├── review-requirements.md #   要件・仕様整合性レビュー
│   │   └── review-prompt.md    #     統合レビュー指示
│   ├── lint/                   #   横断・汎用の事前ビルド Lint 資産（ast-grep ルール群ほか）
│   └── documents/              #   共通開発ドキュメント
│       ├── development-policy.md
│       ├── quick-checklist.md
│       ├── error-codes.md
│       ├── naming-conventions.md
│       ├── quality-policy.md
│       ├── static-check-standard.md
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
│   ├── hooks/quality-gate.cjs      # 品質ゲートフック本体（Node 製・クロスプラットフォーム）
│   └── PULL_REQUEST_TEMPLATE.md
│
├── configs/                    # AI ツール別ドキュメント
│   ├── claude-code/README.md
│   ├── cursor/README.md
│   └── codex/README.md
│
├── scripts/
│   ├── transform-skills.sh    # superpowers スキル変換（CI 用）
│   └── fix-nested-fences.sh   # ネストしたコードフェンスの補正（transform から呼び出し）
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
│   ├── hooks/quality-gate.cjs      #   品質ゲートフック（Node 製）
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
├── lint/                           # 事前ビルド Lint 資産（配置のみ・配線は lint-scaffolding スキル）
│   ├── README.md                   #   資産全体の説明
│   ├── README-<stack>.md           #   スタック別の配線ガイド（選択スタック分）
│   ├── ast-grep/                   #   汎用 + スタック別 ast-grep ルール
│   └── ...                         #   eslint/ checkstyle/ archunit/ mutation/（選択スタックに依存）
│
├── .ai-dev-helm.json               # 適用バージョンの記録（同期の起点）
│
├── .github/                        # GitHub 設定
│   ├── PULL_REQUEST_TEMPLATE.md    #   PR テンプレート
│   ├── review-frontend.md          #   フロントエンドレビューガイド
│   ├── review-backend.md           #   バックエンドレビューガイド
│   ├── review-docs.md              #   ドキュメントレビューガイド
│   ├── review-infra.md             #   インフラレビューガイド
│   ├── review-performance.md       #   パフォーマンスレビューガイド
│   ├── review-requirements.md      #   要件・仕様整合性レビューガイド
│   └── review-prompt.md            #   統合レビュー指示
│
└── documents/development/          # 開発ドキュメント
    ├── development-policy.md
    ├── quick-checklist.md
    ├── error-codes.md
    ├── naming-conventions.md
    ├── quality-policy.md
    ├── static-check-standard.md
    ├── test-recommendation-ledger.md   # 追加テスト提案の永続台帳（copy-if-missing: 既存があれば上書きしない）
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
    ├── hooks/quality-gate.cjs      #   品質ゲートフック本体（Node 製）
    └── hooks.json                  #   PreToolUse フック登録（quality-check 強制）
```

### 各ファイルの役割

| ファイル | 役割 |
|---------|------|
| `CLAUDE.md` | Claude Code が会話開始時に読み込む設定ファイル。プロジェクト概要、ルール、コマンド一覧を記述 |
| `.cursorrules` | Cursor が参照するプロジェクト設定ファイル |
| `AGENTS.md` | Codex CLI が会話開始時に読み込む設定ファイル（プロジェクトルートからチェーンマージ） |
| `.claude/settings.json` | Claude Code のフック設定。品質チェック未実施のマージ（main への取り込み）をブロックするフックなど |
| `.claude/hooks/` / `.codex/hooks/` | 品質ゲートフック本体（`quality-gate.cjs`）。Node 製のため Windows / macOS / Linux で同一動作（`jq` 等の外部ツール不要） |
| `.codex/config.toml` | Codex のプロジェクトローカル設定（approval/sandbox） |
| `.codex/hooks.json` | Codex の PreToolUse フック設定。有効な `.quality-check-passed` がないと main へのマージ・直接 push をブロック |
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
| **quick-checklist.md** | 作業前（Issue 作成、ブランチ確認）・作業中（規約遵守、テスト記述）・マージ前（quality-check 実行）・PR 作成（implementation-report 実行）のクイックリファレンス |
| **error-codes.md** | エラーコード体系の定義。`[FEATURE]_[TYPE]_[DETAIL]` 形式で HTTP ステータスコードとの対応（400/401/403/404/409/500）を含む |
| **quality-policy.md** | 「何をもって品質を確認したと言えるか」を定義する品質ポリシー。リスクレベル定義（High/Medium/Low）、レベル別ゲートマトリクス（静的チェック、ユニットテスト、test-design、ペルソナレビュー、追加テスト = ミューテーション / E2E — test-recommendation スキルによる提案ベース・ユーザー判断で実行・非ブロック・差分スコープ = 変更行 / 変更クラス・通過判定なしのトリアージ）、テスト層選択の原則（テストトロフィー）、テストオラクル原則、反復工程のループ防護（打ち切り基準）、開発プロセスのレビュー一本化（§5.5: タスク単位レビューの廃止・文書レビューの維持・マージ前 quality-check への品質レビュー集約） |
| **static-check-standard.md** | 静的チェック基準カタログ。決定的チェック（Lint / 静的解析）で担保すべき項目を A1〜F2 の25カテゴリ（正しさ・セキュリティ・設計/保守性・パフォーマンス・テスト品質・その他）に整理し、必須 / 推奨 / 任意の採用基準と、AI 生成コードで頻発するカテゴリ（🤖）を定義 |
| **test-recommendation-ledger.md**（配布先: `documents/development/test-recommendation-ledger.md`） | test-recommendation スキルの永続台帳。E2E シナリオ未整備の導線一覧とミューテーション見送り履歴を保持する。copy-if-missing で配布され、`init` を再実行しても既存の台帳は上書きされない（プロダクトの蓄積データのため） |
| **coding-rules/common-rules.md** | Git/GitHub 規約（Conventional Commits 形式）、コメント規約（TODO/FIXME にデッドライン必須）、環境変数管理、セキュリティルール（OWASP Top 10 全項目の対策指針、CSRF 対策、依存パッケージセキュリティ）、パフォーマンスルール（N+1 防止、インデックス設計、ページネーション必須）、アーキテクチャ・設計原則（レイヤー責務、DRY、仕様ベースのテスト）、言語横断の禁止パターン（ワイルドカード import、完全修飾名の直書き、未使用 import、マジックナンバー）。各項目には静的チェック基準カタログの対応カテゴリを示す `> Catalog:` 注記が付く |
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
| **review-performance.md** | パフォーマンスレビューの観点。アルゴリズム計算量（O(n²) の混入、ループ内の重複計算）、DB/クエリ性能（N+1、不要カラム取得、ページネーション）、メモリ・リソース使用、フロントエンドの再レンダリング・バンドルサイズ |
| **review-requirements.md** | 要件・仕様整合性レビューの観点。Issue との整合（実装内容・スコープ逸脱）、受け入れ基準の充足とテストによる証明、要件に記載されたエッジ条件の処理 |

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
| **Level 0: 自動実行** | AI が確認なしで自動実行すべき項目 | Issue 作成、ブランチ作成、品質チェック実行、計画のサブエージェント駆動実行 |
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

`skills/superpowers/` は [superpowers](https://github.com/obra/superpowers) プラグインから抽出したスキルです（抽出元バージョンはリポジトリルートの `.superpowers-version` に記録）。

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

### Q: Codex でもマージ前の品質チェックは強制されますか？

されます。`.codex/hooks.json` の `PreToolUse` フックが `gh pr merge` / main 上での `git merge` / main への直接 push を検査し、有効な `.quality-check-passed` フラグ（commit 紐付け JSON）がなければブロックします。feature ブランチへの push はゲートされません。Claude Code と同等の仕組みで、Codex 側がプロジェクトを trusted としてロードする必要があります（Codex 起動時に確認されます）。

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
