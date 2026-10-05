# Development Guidelines

Development policies, standards, and processes for this project.

## 1. AI-Driven Development

### 1.0 設計思想（必読）

本節はハーネスを利用する全プロダクトの前提であり、テンプレート（CLAUDE.md / AGENTS.md / .cursorrules）の Development Philosophy 節はこの要約である。矛盾する場合は本節が正。

- 前提: 各種 AI モデル・AI ツール上で動作し、単一モデルに依存しない。品質は構造で担保する。テストは根拠を添えれば信用してよい（ミューテーションはそのための道具で必須ではない）。
- 1 Issue とブランチ。
- 2 設計（brainstorming）: 設計が完了したら、実装に入る前に必ず「設計レビュー → ユーザーへのレビュー依頼と承認」を行う（brainstorming の Design Gate）。設計レビューは専任レビュアー（`document-reviewer`）による基本 1 回で、よほどの問題や大規模のときだけ複数回。ユーザーへは設計・レビュー指摘とその対応を 1 通で示し、明示の承認を得るまで実装しない。小さな変更も対象。免除（正本）: 設計上の選択を含まない誤字の修正と、明らかに正しい数行の修正。承認済みの設計の範囲内の修正（quality-check の指摘への対応など。承認済みの設計を変えないもの）は、新しい設計ゲートを要しない。設計が存在する前の「実装して」は設計の承認ではない。ここのレビューがタスク単位レビューを不要にする。ユーザーへの確認は纏める — 質問は 1 通に纏めて聞き、重要な設計判断は一括提示する。一問一答・節ごとの承認はしない。承認の後は再確認しない（下の「承認後の進め方」）[^batch]。
- 3 計画（writing-plans）: 設計済みが前提。計画のレビューはしてよいが、その後のユーザー確認は不要。
- 4〜6 実装: 親が直接実装するか、独立した課題を委譲するかを、計画・引き継ぎ・再探索・統合・手戻りを含む総労力で選ぶ。親モデルの直接実装を禁止しない。計画は影響範囲・契約・検証に必要な深さとし、コードの二重執筆を求めない。開発中のレビューループはしない（設計意図との合致は 7 で見る）。
- 7 quality-check: まず機械的チェック（ビルド、テスト、Lint / CheckStyle 等の静的チェック）。通ってから体制レビュー（統合レビュアー＋反証型 QA＋専門家最大 1 体）。実装内容に応じて体制を絞り、不要なレビュアーは動かさない。
- 8 hook: quality-gate は main（相当ブランチ）への直接 push / merge を禁止する装置。別の review-budget フックはレビューだけの回数上限を制御し、実装・探索・通常テストを数えない（`harness-runtime.md`）。加えて 7 の状態・実装状態に応じてミューテーション / E2E を判定し、推奨が強く範囲が小さいものは確認なしで実施し、それ以外は最後の報告で確認する（test-recommendation）[^8]。
- 通過判定: レビュー結果・品質チェックの結果。AI の申告でもよいが必ず根拠を添える[^report]。
- 品質原則と製品固有の保護条件は維持する。スキルは適用条件に合うものを使う。自己改善は通常の完了条件から外し、必要時に改善候補を記録する。恒久対応では文章規則の追加より設定・ラッパー・hook 等の原因箇所の修正、既存ルールの削除・統合を先に検討する。

#### 承認後の進め方（正本）

テンプレート（CLAUDE.md / AGENTS.md / .cursorrules）・配布スキルはこの節を要約・参照する。

1. **承認の範囲**: 設計の承認は、その設計を完成させるための工程すべての承認を含む — spec の更新、計画と計画レビュー、実装（親か委譲か）、テスト設計、機能ドキュメントの更新、quality-check（レビュー上限の範囲内のサイクル、Step 5 の自動実施）、コミット、feature ブランチへの push、PR の作成。これらの前・途中でユーザーに確認しない。main への統合はプロジェクトの規則に従う。規則がマージまで進めると定めていなければマージしない（PR で止め、リモートが無ければ仕上げた feature ブランチで止め、最後の 1 通の「判断が必要なこと」にマージを書く）。導入先の規則がオーナー承認を求めるマージは例外 X2。設計の承認は、レビュー回数の上限を超える承認ではない（`extend --reason` に設計の承認の文を引用しない）。
2. **差異の扱い**: 設計どおりにできない・設計より良い方法が分かった場合は、設計の目的と承認済みの決定に最も沿う案を AI が選んで作業を続け、「設計との差異」として記録する。途中で報告・相談しない。差異とは、設計に書いた外部の振る舞い・契約・範囲・ファイル構成・決定事項を変えたもの。設計が決めていない実装の細部（関数名・内部構造・テストの書き方）は差異ではない。
3. **差異の記録**: 差異が生じた時点で、spec ファイルがあればその末尾の節「## 実装時の差異」に、無ければ計画ファイルに、どちらも無ければ作業メモに、「何を（設計の該当箇所）→ どうしたか / 理由 / 影響」の形で書く。ファイルへの記録は quality-check Step 6（フラグ作成）より前に済ませる（`docs/` 配下はハーネス免除の対象外）。フラグの後に分かった差異は PR 本文にだけ書く。記録先は quality-check の共通コンテキストに含め、要件整合の観点で妥当性を見る。PR 本文（`implementation-report`）の「設計・計画との差異」に転記する。
4. **途中で止まるのは次の例外だけ**。ほかの確認は最後の 1 通に回すか、AI が決める。

   | # | 例外 |
   |---|---|
   | X1 | quality-check のレビュー回数の上限・停滞・構造的停滞（quality-policy §5）。制作物の最終品質レビュー（`production`）の上限も同じ |
   | X2 | リリース、GHSA を閉じる操作、導入先の規則がオーナー承認を求めるマージ |
   | X3 | 設計に含まれない、取り消せない操作（データ・他人の作業の削除、force push、共有環境の変更、外部への公開）。未公表の脆弱性の修正を公開リポジトリへ push・PR すること（GHSA の private fork を使う） |
   | X4 | 承認済みの設計では目的を達成できない。または達成するには、オーナーが明示に決めた事項を覆す、設計に無い機能・互換性を壊す変更を足す、ユーザーが明示した上限（予算・範囲）を超える必要がある（下の「X4 の手順」） |
   | X5 | 実施した E2E の失敗が、修正 → 再検証の反復 2 回で直らない（`test-recommendation` Step 4） |
   | X6 | 失敗・エラーの原因が分からず進められない、または恒久対応が分からず一時しのぎ（テストの無効化・エラーの握りつぶし等）しか無い |
   | X7 | 状態ファイル・永続台帳・ハーネス設定（上書きキーの重複等）が壊れていて、規則どおりに直せない |
   | X8 | 実装に要るもの（認証情報、有料の外部サービス、アカウント、手作業のログイン等）を AI が自分で用意できない |

   テンプレートの Autonomy「Ask the user only when」の 1（調べても答えが決まらない）と 2（想定外の事態でループする・進めない）は設計の承認前の規定とする。承認後は、1 → 設計の目的に最も沿う案を選んで差異として記録する（設計に無い重要な製品判断で、どの案も設計の目的に沿うと言えないときは X4）、2 → X6。上流スキル（`superpowers:*`）の「ask / discuss with your human partner」も、承認後は「承認済みの設計の範囲で決め、設計と違えたら差異として記録し、最後に報告する」と読み、例外に当たるときだけ止まる。

5. **レビュー上限（quality-check 以外）**: 設計の承認後、計画レビュー（`plan`）などのフェーズが上限に達したら、追加のレビューを求めずに進み、残った指摘と扱いを記録する。ミューテーションの分類検証（`mutation`、上限 1）も、上限なら残りを記録して進む。止まるのは quality-check と制作物の最終品質レビュー（`production`）の打ち切り（X1）と、承認前・X4 の設計レビュー（`requirements` を含む）だけ。
6. **X4 の手順（止まるのは 1 回）**: ①差異の部分の設計を自己点検して書く ②設計レビューの予約に残りがあれば受け、残りが無ければ受けずに ③1 通で「差異の設計（レビュー済みならその指摘と対応）」と、レビュー未実施なら「追加のレビュー 1 周（`extend --phase design --rounds 1`）」の承認をまとめて求める ④承認後、AI が `extend` → レビュー → 指摘の修正を行い、修正が承認された設計を変えなければそのまま実装に戻る（レビューの結果は最後の報告に書く）。修正で承認された内容が変わる場合だけ、もう一度 1 通で示す。
7. **最後の報告（1 通）と順序**: 実装 → quality-check Step 1〜4 → Step 5 の自動実施分 → Step 5 の差分のコミット → (A) 確認の対象が無い: フラグ作成 → push → PR 作成（規則でマージまで進めるならマージ）→ 最後の 1 通。(B) 確認の対象がある: push → PR 作成（確認の対象は「確認待ち（判断は最後の 1 通）」と書く）→ 最後の 1 通（quality-check は未完了で、フラグは作らない）→ 返答 → 実行・記録・コミット → PR 本文の再生成・更新 → フラグ作成 → push（マージ）→ 同じ書式の短い報告。返答が来なければその状態で止まる（フラグなし＝マージできない）。(B) になるのは Step 5 の確認の区分があるときだけで、「判断が必要なこと」のほかの項目（self-improvement の候補、機能ドキュメントの保存場所、Lint の振動、X2 のマージ承認）はフラグを止めない。(B) の PR は draft で作り（`gh pr create --draft`）、フラグ作成の後に `gh pr ready` にする（draft を使えないリポジトリでは通常の PR にし、本文に「確認待ち」と書く）。

   ```
   完了: <PR の URL / マージ済み / 確認待ち（quality-check は未完了） 等 1 行>
   設計との差異: なし
     （ある場合は 1 件ずつ: 何を → どうしたか / 理由 / 影響）
   判断が必要なこと: なし
     （ある場合: 確認が必要な追加テスト、X2 のマージ承認、self-improvement の候補の採否 等。選択肢を添える）
   ```

   テスト結果・レビューの指摘と対応・自動で実施した追加テストの結果は PR 本文に書き、チャットでは繰り返さない。ただし生存ミュータントを持ち越した場合・E2E の失敗を直した場合は、その事実を 1 行書く。返答の後の操作は AI が行う。

[^8]: 後半（ミューテーション / E2E の判定・自動実施・確認）は hook ではなく quality-check Step 5 → `test-recommendation` スキルが担う。hook はコマンド行の静的分類のみで、提案機能を持たない。
[^report]: quality-check SKILL.md の「実装 Agent の自己申告を Quality Gate にしない」は、「実装に合わせて期待値を修正した」型の申告を根拠と認めない規定であり、本項と両立する。
[^batch]: 配布する brainstorming / writing-plans の本文に同じ確認手順を適用する。同期時は patch を再適用し、適用できなければ同期を失敗させる。外部プラグインを直接読む導入先は、その読み込み経路にも同じ方針の対応が必要。project スキルも既存の承認を再取得せず、承認後の確認は「承認後の進め方」の例外か最後の 1 通に限る。配布物に新しい停止点を足すときは、`lib/approval-scan.test.js` の許可の一覧に例外との対応を足す。

#### 充足済み項目（既存配布物で対応済み・変更なし）

| 項目 | 充足箇所 |
|---|---|
| 1 Issue とブランチ | `CLAUDE.md`（ルートの規則）Critical Rules Level 0 / 1、quick-checklist |
| テストは根拠を添えれば信用 / ミューテーションは必須でない | quality-policy §2（推奨度・範囲で自動実施または確認・非ブロック） |
| 通過判定は根拠を添える | quality-check SKILL.md「実装 Agent の自己申告を Quality Gate にしない」（脚注参照） |

### 1.1 Basic Principles
- **AI as primary developer**: Code development and review driven by AI tools
- **Human role**: Requirements definition, design decisions (one approval per design), and reading the final report of deviations from the design
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

#### Working without Issues (optional)
A project that does not use GitHub Issues keeps the rest of this policy unchanged:
- Branch name is `<type>/<description>` (no Issue number); omit `closes #N` from commits and PRs.
- `implementation-report` finds the plan by branch name only when there is no Issue.
- The default `branch-naming` lint pattern does not require an Issue number. A project that wants one overrides `pattern` (see `lint-scaffolding`).
- The "Create GitHub Issue" and "Issue number required" rules in the three entry files apply only to projects that use Issues.

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
