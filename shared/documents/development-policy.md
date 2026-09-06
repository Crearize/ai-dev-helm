# Development Guidelines

Development policies, standards, and processes for this project.

## 1. AI-Driven Development

### 1.0 設計思想（必読）

本節はハーネスを利用する全プロダクトの前提であり、テンプレート（CLAUDE.md / AGENTS.md / .cursorrules）の Development Philosophy 節はこの要約である。矛盾する場合は本節が正。

- 前提: 各種 AI モデル・AI ツール上で動作し、単一モデルに依存しない。品質は構造で担保する。テストは根拠を添えれば信用してよい（ミューテーションはそのための道具で必須ではない）。
- 1 Issue とブランチ。
- 2 設計（brainstorming）: レビューは基本 1 回。よほどの問題や大規模のときだけ複数回。ここのレビューがタスク単位レビューを不要にする。ユーザーへの確認は纏める — 質問は 1 通に纏めて聞き、重要な設計判断は一括提示し、未承認の判断だけ確認する。会話で得た承認は維持する。一問一答・節ごとの承認・spec 書き出し後の再確認はしない[^batch]。
- 3 計画（writing-plans）: 設計済みが前提。計画のレビューはしてよいが、その後のユーザー確認は不要。
- 4〜6 実装: 親が直接実装するか、独立した課題を委譲するかを、計画・引き継ぎ・再探索・統合・手戻りを含む総労力で選ぶ。Fable / Astra の直接実装を禁止しない。計画は影響範囲・契約・検証に必要な深さとし、コードの二重執筆を求めない。開発中のレビューループはしない（設計意図との合致は 7 で見る）。
- 7 quality-check: まず機械的チェック（ビルド、テスト、Lint / CheckStyle 等の静的チェック）。通ってから体制レビュー（統合レビュアー＋反証型 QA＋専門家最大 1 体）。実装内容に応じて体制を絞り、不要なレビュアーは動かさない。
- 8 hook: quality-gate は main（相当ブランチ）への直接 push / merge を禁止する装置。別の review-budget フックはレビューだけの回数上限を制御し、実装・探索・通常テストを数えない（`harness-runtime.md`）。加えて 7 の状態・実装状態に応じてミューテーション / E2E の実施を提案する（test-recommendation）[^8]。
- 通過判定: レビュー結果・品質チェックの結果。AI の申告でもよいが必ず根拠を添える[^report]。
- 品質原則と製品固有の保護条件は維持する。スキルは適用条件に合うものを使う。自己改善は通常の完了条件から外し、必要時に改善候補を記録する。恒久対応では文章規則の追加より設定・ラッパー・hook 等の原因箇所の修正、既存ルールの削除・統合を先に検討する。

[^8]: 後半（ミューテーション / E2E の提案）は hook ではなく quality-check Step 5 → `test-recommendation` スキルが担う。hook はコマンド行の静的分類のみで、提案機能を持たない。
[^report]: quality-check SKILL.md の「実装 Agent の自己申告を Quality Gate にしない」は、「実装に合わせて期待値を修正した」型の申告を根拠と認めない規定であり、本項と両立する。
[^batch]: 配布する brainstorming / writing-plans の本文に同じ確認手順を適用する。同期時は patch を再適用し、適用できなければ同期を失敗させる。外部プラグインを直接読む導入先は、その読み込み経路にも同じ方針の対応が必要。project スキルの提案・採否確認も必要な質問をまとめ、既存の承認を再取得しない。

#### 充足済み項目（既存配布物で対応済み・変更なし）

| 項目 | 充足箇所 |
|---|---|
| 1 Issue とブランチ | `CLAUDE.md.template` Critical Rules Level 0 / 1、quick-checklist |
| テストは根拠を添えれば信用 / ミューテーションは必須でない | quality-policy §2（提案ベース・非ブロック） |
| 通過判定は根拠を添える | quality-check SKILL.md「実装 Agent の自己申告を Quality Gate にしない」（脚注参照） |

### 1.1 Basic Principles
- **AI as primary developer**: Code development and review driven by AI tools
- **Human role**: Requirements definition, design decisions, final review
- **Prompt-based**: Development instructions communicated via clear prompts

### 1.2 Development Flow

#### Branch Verification Before Work
Before all development and documentation work:

1. **Check current branch**: `git branch --show-current`
2. **If on main**: Create a new branch before starting
3. **If on another branch**: Verify it matches the task

```
Branch check → Prompt instructions → AI implementation → PR creation → AI review → Human review → Merge
```

### 1.3 Configuration File Role
- CLAUDE.md / .cursorrules: Initial configuration file loaded by AI tools
- Contains project overview and development guideline references

### 1.4 Prompt Best Practices
- **Clear requirements**: What to build, expected behavior
- **Specific instructions**: Technologies, patterns, constraints
- **Expected results**: Completion criteria, output format, error handling
- **Incremental steps**: Break complex features into small steps

## 2. Architecture

### 2.1 Project Structure

Organize your project with clear separation of concerns:

```
project/
├── backend/               # API server
│   ├── src/main/          # Source code
│   ├── src/test/          # Test code
│   └── src/main/resources/# Configuration, migrations
├── frontend/              # Web application(s)
│   ├── apps/              # Application(s)
│   └── packages/          # Shared packages (utilities only)
├── documents/             # Project documentation
├── .github/               # CI/CD configuration
└── CLAUDE.md              # AI configuration
```

## 3. Development Environment Setup

### Prerequisites
- Language runtime (Java, Node.js, Python, etc.)
- Package manager
- Docker (for databases and services)
- Database

## 4. Development Workflow

### Feature Development Flow
1. **Check current branch** (`git branch --show-current`)
2. **Create new branch if on main**
3. Specify requirements and approach via prompts
4. Implement with AI tools
5. Write tests alongside implementation
6. Local verification
7. Create PR

## 5. Branch Strategy (GitHub Flow)

### Basic Rules

#### Pre-Work Verification (Required)
1. **Check current branch**: `git branch --show-current`
2. **If on main**: Direct work prohibited. Create new branch.
3. **If on other branch**: Verify branch name matches task.

#### Branch Naming
```
feature/[feature-name]     # New feature
fix/[bug-description]      # Bug fix
docs/[document-name]       # Documentation
refactor/[target]          # Refactoring
test/[test-target]         # Test additions/fixes
```

### PR Creation and Review
1. Meaningful commit units
2. Follow PR template
3. Automated review (if configured)
4. Human final review
5. Merge to main

## 6. API Design (RESTful)

### Endpoint Conventions
```
GET    /api/v1/resources          # List resources
GET    /api/v1/resources/{id}     # Get single resource
POST   /api/v1/resources          # Create resource
PUT    /api/v1/resources/{id}     # Full update
PATCH  /api/v1/resources/{id}     # Partial update
DELETE /api/v1/resources/{id}     # Delete resource
```

### Response Format
- **Format**: JSON
- **Content-Type**: `application/json`

## 7. Error Handling

### Error Response Format
```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource not found",
    "details": {}
  },
  "timestamp": "2025-01-08T10:00:00Z"
}
```

### HTTP Status Codes
- **200 OK**: Success
- **201 Created**: Resource created
- **204 No Content**: Deletion success
- **400 Bad Request**: Validation error
- **401 Unauthorized**: Authentication error
- **403 Forbidden**: Authorization error
- **404 Not Found**: Resource not found
- **409 Conflict**: Conflict (duplicate, etc.)
- **500 Internal Server Error**: System error

## 8. Logging

### Log Levels
- **ERROR**: System errors, unexpected exceptions
- **WARN**: Recoverable errors, retry operations
- **INFO**: Important business events
- **DEBUG**: Debug information (dev/staging only)

### Sensitive Information
- Never log passwords, API keys, or tokens
- Mask personal information when necessary
- Never log credit card numbers

## 9. Testing Strategy

### Coverage Targets

> カバレッジ目標は**下限**であり、テスト十分性の**証明ではない**。テスト層の選択（Failure Mode 起点）とテストオラクル（期待値の根拠）の原則は `quality-policy.md` §3 / §4 を参照。

- Overall: 80%+
- Business logic (Service layer): 90%+
- Utilities: 100%

### Test Types
- **Unit tests**: Individual component testing with mocks
- **Integration tests**: Component interaction testing
- **API tests**: Endpoint testing
- **E2E tests**: Full workflow testing

## 10. Checklist

### Before Starting Work
- [ ] Check current branch
- [ ] Create new branch if on main
- [ ] Branch name matches task

### During Development
- [ ] Documentation updated (if needed)
- [ ] Test code written
- [ ] Error handling implemented
- [ ] Logging implemented

### PR Creation
- [ ] Commit messages follow conventions
- [ ] All tests pass
- [ ] Coverage targets met
- [ ] Review points documented
