# Common Coding Rules

Project-wide coding rules and development standards.

## Basic Principles

- Consistency: Unified style across the project
- Readability: Code understandable by developers and AI
- Maintainability: Easy to change and extend
- Security: No vulnerability-introducing implementations

## Catalog 注記の読み方

本文書の項目に付く `> Catalog:` 引用行は、静的チェック基準カタログ（`../static-check-standard.md`）のどのカテゴリで機械的に担保しうるかを示す**移行形の注記**である（カタログ §4.1）。

| 表記 | 意味 |
|---|---|
| `Catalog: <番号>（フェーズ3で Lint 化予定）` | Lint で担保可能。フェーズ3で Lint 資産が配線され、実際に配線されたことを確認した後に本文書から削除する |
| `Catalog: <番号>（… は AI レビュー恒久担保）` | カバレッジが分割される項目。機械検出可能な部分のみフェーズ3で Lint 化し、判断を要する部分はフェーズ3以降も本文書に残す |
| `… はカタログ対応なし — AI レビュー恒久担保` | 機械判定できない項目。フェーズ3以降も本文書に残す |
| `Catalog: <番号>（フェーズ3で Lint 資産提供予定）` | **スタック別ルール文書（`stacks/<stack>/rules/`）専用の表記**。言語・FW 固有かつ Lint 担保可能な項目に付く。Lint 配線後も**削除せず**、「項目名 + カタログ番号 + Lint 資産参照」の形式に縮約する（カタログ §4.1） |

**フェーズ3までの担保方法**: 既存の静的チェック（プロダクトの ESLint / Checkstyle / tsc 等、CLAUDE.md に登録された静的チェックコマンド）で担保済みの項目は Lint 担保として扱う（カタログ §4.1）。それ以外を AI レビューで担保する。

注記は節（ブロック）単位で付く場合がある。その場合、**注記に挙がっていない項目はそのカテゴリの対象ではない** — 対象外の項目は同じ注記内に明示する。

## 1. Git/GitHub Conventions

### 1.1 Commit Messages

#### Format
```
<type>: <subject>

[optional body]

[optional footer]
```

#### Types
| Type | Description | Example |
|------|------------|---------|
| feat | New feature | `feat: add student search` |
| fix | Bug fix | `fix: resolve login error` |
| docs | Documentation | `docs: update API spec` |
| style | Code style | `style: fix indentation` |
| refactor | Refactoring | `refactor: simplify service logic` |
| test | Tests | `test: add controller tests` |
| chore | Build/tools | `chore: update dependencies` |
| perf | Performance | `perf: optimize queries` |

#### Rules
- Subject line: 50 characters or less
- Start with verb
- Body: wrap at 72 characters
- Include Issue number if applicable (#123)

### 1.2 Branch Strategy

```
feature/[feature-name]     # New feature
fix/[bug-description]      # Bug fix
docs/[document-name]       # Documentation
refactor/[target]          # Refactoring
test/[test-target]         # Test additions/fixes
```

#### Rules
- Use kebab-case (`feature/student-search`)
- Concise and descriptive names
- Include Issue number if applicable (`feature/student-search-123`)

### 1.3 Pull Requests

#### PR Template
```markdown
## Summary
<!-- Brief description of what was implemented/fixed -->

## Purpose
<!-- Why this change is needed -->

## Changes
<!-- Main changes as bullet points -->

## Test Results
<!-- Tests performed -->

## Checklist
- [ ] Tests pass
- [ ] Documentation updated (if needed)
- [ ] Ready for code review

## Related Issue
Closes #
```

## 2. Comment Conventions

### Required Comments
- **Public methods**: Purpose and usage
- **Complex logic**: Intent of processing
- **External API integration**: Specification references

### TODO/FIXME Comments

> Catalog: C8（フェーズ3で Lint 化予定）

```
// TODO: [deadline] Implementation description
// FIXME: [priority] Fix description
// NOTE: Important supplementary information
// HACK: Temporary workaround
```

#### Rules
- Deadline/priority required
- Include Issue number if available
- Review and remove periodically
- Prohibited: Leaving commented-out code

## 3. Environment Variable Conventions

### Rules
- Follow framework-standard hierarchical structure
- Variable names: UPPER_SNAKE_CASE
- Default values: Set for development environment
- Sensitive information: Listed in .gitignore

### Security Rules

> Catalog: B1（フェーズ3で Lint 化予定）

- Never commit API keys to Git
- Production secrets managed via environment variable services
- Secret configuration files always in .gitignore

## 4. Security Rules

### Secret Management

> Catalog: B1 / F2（フェーズ3で Lint 化予定。4項目すべてが B1 対応。うち「Log output masking」は F2 とも対応）

- **Environment variable management** (no hardcoding)
- **Log output masking**
- **Never commit to Git** (.gitignore)
- **Never expose to client-side**

### Input Validation

> Catalog: B2（SQL インジェクション・XSS のコードレベル脆弱性パターン。フェーズ3で Lint 化予定）
> 「Server-side validation required」（検証の実施有無そのもの）はカタログ対応なし — AI レビュー恒久担保。

- Server-side validation required
- SQL injection prevention (parameterized queries)
- XSS prevention (output escaping)

### OWASP Top 10 (2021) Awareness
- **A01: Broken Access Control**: 全てのエンドポイントで認証・認可チェックを実施。IDORに注意（他ユーザーのリソースにアクセスできないこと）
- **A02: Cryptographic Failures**: パスワードはbcrypt/scrypt/Argon2でハッシュ化。通信はTLS必須。機密データは保存時も暗号化を検討
- **A03: Injection**: 全ての外部入力にパラメタライズドクエリを使用。動的SQLの文字列結合は禁止。ログ出力時もCR/LFをサニタイズ（ログインジェクション防止）
- **A04: Insecure Design**: 脅威モデリングを意識した設計。ビジネスロジックの乱用防止（レートリミット、ワークフロー制御）。セキュリティ要件を設計段階で定義
- **A05: Security Misconfiguration**: 本番環境でデバッグモード無効。不要なHTTPメソッド無効。適切なセキュリティヘッダー設定
- **A06: Vulnerable and Outdated Components**: 既知の脆弱性がある依存パッケージを使用しない。セキュリティアップデートは速やかに適用
- **A07: Identification and Authentication Failures**: セッショントークンは十分なエントロピーで生成。ブルートフォース対策（アカウントロックアウト、レートリミット）
- **A08: Software and Data Integrity Failures**: 依存パッケージの整合性を検証（lockfileの一貫性維持）。CI/CDパイプラインの改ざん防止。デシリアライゼーション攻撃への対策
- **A09: Security Logging and Monitoring Failures**: セキュリティイベント（ログイン失敗、認可拒否、入力バリデーション失敗）を確実にログ出力。監視・アラート体制の構築
- **A10: SSRF (Server-Side Request Forgery)**: 外部URLを受け取る機能はホワイトリスト方式で制限。内部ネットワークへのリクエストをブロック

### CSRF Protection
- 状態変更リクエスト（POST/PUT/DELETE）にCSRF対策を実施
- SPAの場合: `SameSite Cookie（Lax以上）` + CORS + `Content-Type: application/json` のみ受付（またはカスタムヘッダー `X-Requested-With` 検証）
- `SameSite=Lax` のみでは不十分なケースがある（form-encoded POSTが通る）。必ずContent-Typeチェックまたはカスタムヘッダーを併用

### API Response Security

> Catalog: B1（「APIレスポンスに不要な個人情報を含めない」および「ログにパスワード・トークン・個人情報を出力しない」の両項目）/ F2（ログ規律として後者に併せて対応）（フェーズ3で Lint 化予定）

- APIレスポンスに不要な個人情報を含めない
- ログにパスワード・トークン・個人情報を出力しない

### Dependency Security

> Catalog: B3（フェーズ3で Lint 化予定）

- 既知の脆弱性がある依存パッケージを使用しない
- セキュリティアップデートは速やかに適用
- lockfileをコミットし、CI/CDでの整合性を保証する
- 新規依存パッケージ追加時はメンテナンス状況・ダウンロード数を確認（typosquatting注意）

## 5. Performance Rules

### Required

> Catalog: D1（「N+1 problem prevention」「Pagination」「No unnecessary column fetching（`SELECT *`）」の3項目。フェーズ3で Lint 化予定。N+1 は静的検出のみでは担保済みとみなさない — カタログ §3 の二段構えを参照）
> 「Index design」はカタログ対応なし — AI レビュー恒久担保。

- **N+1 problem prevention**: Use JOIN or batch fetch
- **Index design**: Set on frequently queried columns
- **Pagination**: Required for large datasets
- **No unnecessary column fetching**: No SELECT *

## 6. Architecture & Design Principles

Language- and framework-independent design principles. This document is the canonical generic statement of them.

> 移行注記: スタック別ルール文書（配布後は AI ツール別の rules ディレクトリ）は、これらの原則の言語・FW 固有の表現のみを持つ**ようにする**。スタック別の詳細規約（`stacks/<stack>/documents/coding-rules/` 配下、配布後は `documents/development/coding-rules/`）の縮約はフェーズ3で行うため、現時点ではスタック別ルール文書側に元の記述が残っている場合がある。

### 6.1 Layer Responsibilities

> Catalog: C1（レイヤー境界・依存方向。フェーズ3で Lint 化予定）
> スコープ: 本節はサーバーサイドのデータアクセス層を持つプロダクトに適用する。フロントエンドの構造（Server Component / Server Actions 等の責務分割）はスタック別ルール文書の構造規約に従う。

Names differ per stack (Controller / Route Handler / Service / Use Case / Repository / DAO), but the responsibility split is the same:

| Layer | Responsibility | Must not contain |
|-------|---------------|------------------|
| **Presentation** | Routing, request/response mapping, input validation | Business rules, direct data access |
| **Business logic** | Business rules, domain logic, transaction boundaries | Presentation concerns (HTTP/UI details) |
| **Data access** | Data input/output only | Business rules, decisions that belong to the domain |

#### Rules
- Keep dependencies one-directional: presentation → business logic → data access. Never the reverse.
- The presentation layer must not access the data access layer directly.
- Transaction boundaries belong to the business logic layer, not the presentation or data access layer.

### 6.2 DRY Principle

> Catalog: C5（コピペコードの機械検出のみフェーズ3で Lint 化予定。既存ユーティリティ確認・抽象化要否の判断は AI レビュー恒久担保）

- Check existing utilities, helpers, and shared components **before** writing new code.
- Extract duplicated logic into a shared location once the same intent appears in multiple places.
- Do not abstract prematurely: duplication of *appearance* without duplication of *intent* is not a DRY violation.

### 6.3 Specification-Based Testing

> Catalog: E1（空 assertion 等のテスト妥当性のみフェーズ3で Lint 化予定。仕様準拠かどうかの判断は AI レビュー恒久担保）

- Test **functional requirements**, not internal state or implementation details.
- Assertions must be traceable to a specification, requirement, or documented calculation basis (test oracle).
- Never derive an expected value by running the implementation and copying its output.

> Details of the test oracle principle are defined in `../quality-policy.md` §4.

## 7. Cross-Language Prohibited Patterns

Rules promoted from stack-specific rule documents because the same concept holds in two or more major languages. Language-specific examples are illustrative; apply the concept to whichever language the product uses.

> 記載根拠: 昇格判定はカタログ（`../static-check-standard.md`）§4.2、移行期にこれらを本文書へ記載する扱いは同 §4.1 に基づく。**本節はフェーズ3で Lint 配線を確認した後に削除する。**

### 7.1 Wildcard imports prohibited

> Catalog: A1（フェーズ3で Lint 化予定）

Import each symbol explicitly.

- Java: `import java.util.*;` → `import java.util.List;` / `import java.util.Map;`
- Python: `from x import *` → `from x import parse_config`

### 7.2 Fully-qualified name usage prohibited

> Catalog: A1（フェーズ3で Lint 化予定）

Always add an import statement and use the short name.

- Java: `java.util.Map<String, Object> data = new java.util.HashMap<>();` → import `Map` / `HashMap` and use `Map<String, Object> data = new HashMap<>();`
- C#: `System.Collections.Generic.List<T>` written inline → `using System.Collections.Generic;` and use `List<T>`

### 7.3 Unused imports prohibited

> Catalog: C3（フェーズ3で Lint 化予定）

Remove imports that are no longer referenced. The concept holds identically in TypeScript, Java, and Python.

### 7.4 Magic numbers prohibited

> Catalog: C6（フェーズ3で Lint 化予定）

Extract unexplained literals into named constants or enums. The concept holds identically in TypeScript, Java, and Python.

- Exceptions: conventional values whose meaning is unambiguous in context (`0`, `1`, `-1`, array indices in a loop).

## Checklist

> フェーズ3では Lint 担保済みの項目をこのチェックリストから削除する。それまでは移行形として現状維持し、対応するカタログ番号を各節に付記する。既存の静的チェックで担保済みの項目は Lint 担保として扱う（カタログ §4.1）。それ以外を AI レビューで担保する。カタログ対応のない項目はフェーズ3以降も残す。

### Git/GitHub

> Catalog: C7（ブランチ命名。採用基準は任意）/ その他はカタログ対応なし — AI レビュー恒久担保

- [ ] Commit message follows `<type>: <subject>` format
- [ ] Type is correct
- [ ] Subject line 50 chars or less
- [ ] Branch name is kebab-case and follows conventions

### Security

> Catalog: B1（シークレット・ログへの機密データ・API レスポンスへの不要な個人情報）/ B2（インジェクション系の実装パターン）/ F2（ログ規律）（フェーズ3で Lint 化予定）
> 上記以外の項目 — サーバーサイド入力検証の実施有無・IDOR（認可チェック）・CSRF 対策・セキュリティヘッダー設定 — はカタログ対応なし。AI レビュー恒久担保とし、フェーズ3以降もこのチェックリストに残す。

- [ ] No hardcoded API keys or secrets
- [ ] Secrets managed via environment variables
- [ ] Log output masked for sensitive data
- [ ] Input validation implemented (server-side required)
- [ ] No IDOR vulnerabilities (authorization checked for resource access)
- [ ] CSRF protection implemented
- [ ] Security headers configured (production)
- [ ] No sensitive data in API responses beyond what's necessary

### Performance

> Catalog: D1（「No N+1 problems」「Pagination for large datasets」の2項目。フェーズ3で Lint 化予定）
> 「Proper caching strategy」「Proper indexes set」はカタログ対応なし。AI レビュー恒久担保とし、フェーズ3以降もこのチェックリストに残す。

- [ ] No N+1 problems
- [ ] Proper caching strategy
- [ ] Pagination for large datasets
- [ ] Proper indexes set

### Code Quality

> Catalog: C8（TODO/FIXME 期限・コメントアウトコード）/ A1（`console.log` / `System.out.println` 禁止）/ A3（空 catch・握りつぶし等のエラーハンドリング規律）（フェーズ3で Lint 化予定）
> 「Documentation comments appropriate」およびエラーハンドリングの設計妥当性（どこで捕捉し何を返すか）はカタログ対応なし。AI レビュー恒久担保とし、フェーズ3以降もこのチェックリストに残す。

- [ ] Documentation comments appropriate
- [ ] TODO/FIXME has deadline/priority
- [ ] No System.out.println / console.log in production
- [ ] No commented-out code
- [ ] Proper error handling
