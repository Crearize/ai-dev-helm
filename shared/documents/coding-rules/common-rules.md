# Common Coding Rules

Project-wide coding rules and development standards.

## Basic Principles

- Consistency: Unified style across the project
- Readability: Code understandable by developers and AI
- Maintainability: Easy to change and extend
- Security: No vulnerability-introducing implementations

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

> Catalog: C8（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

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

> Catalog: B1（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- Never commit API keys to Git
- Production secrets managed via environment variable services
- Secret configuration files always in .gitignore

## 4. Security Rules

### Secret Management

> Catalog: B1 / F2（ログ出力マスキングは F2 とも対応。フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- **Environment variable management** (no hardcoding)
- **Log output masking**
- **Never commit to Git** (.gitignore)
- **Never expose to client-side**

### Input Validation

> Catalog: B2（SQL インジェクション・XSS 等のコードレベル脆弱性パターン。フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

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

> Catalog: B1 / F2（ログへの機密データ出力は B1、logger 規律は F2。フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- APIレスポンスに不要な個人情報を含めない
- ログにパスワード・トークン・個人情報を出力しない

### Dependency Security

> Catalog: B3（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- 既知の脆弱性がある依存パッケージを使用しない
- セキュリティアップデートは速やかに適用
- lockfileをコミットし、CI/CDでの整合性を保証する
- 新規依存パッケージ追加時はメンテナンス状況・ダウンロード数を確認（typosquatting注意）

## 5. Performance Rules

### Required

> Catalog: D1（N+1・`SELECT *`・ページネーション欠落・無制限クエリ。フェーズ3で Lint 化予定 — 現在は AI レビュー担保。なお N+1 は静的検出のみでは担保済みとみなさない — カタログ §3 の二段構えを参照）

- **N+1 problem prevention**: Use JOIN or batch fetch
- **Index design**: Set on frequently queried columns
- **Pagination**: Required for large datasets
- **No unnecessary column fetching**: No SELECT *

## 6. Architecture & Design Principles

Language- and framework-independent design principles. Stack documents (`stacks/<stack>/rules/`) hold only the language-specific expression of these principles.

### 6.1 Layer Responsibilities

> Catalog: C1（レイヤー境界・依存方向。フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

Names differ per stack (Controller / Route Handler / Service / Use Case / Repository / DAO), but the responsibility split is the same:

| Layer | Responsibility | Must not contain |
|-------|---------------|------------------|
| **Presentation** | Routing, request/response mapping, input validation | Business rules, direct data access |
| **Business logic** | Business rules, domain logic, transaction boundaries | Presentation concerns (HTTP/UI details), raw query construction |
| **Data access** | Data input/output only | Business rules, decisions that belong to the domain |

#### Rules
- Keep dependencies one-directional: presentation → business logic → data access. Never the reverse.
- The presentation layer must not access the data access layer directly.
- Transaction boundaries belong to the business logic layer, not the presentation or data access layer.

### 6.2 DRY Principle

> Catalog: C5（コピペコードの機械検出のみ対応。既存ユーティリティ確認の判断は AI レビュー担保）

- Check existing utilities, helpers, and shared components **before** writing new code.
- Extract duplicated logic into a shared location once the same intent appears in multiple places.
- Do not abstract prematurely: duplication of *appearance* without duplication of *intent* is not a DRY violation.

### 6.3 Specification-Based Testing

> Catalog: E1（空 assertion 等のテスト妥当性は機械判定。仕様準拠かどうかの判断は AI レビュー担保）

- Test **functional requirements**, not internal state or implementation details.
- Assertions must be traceable to a specification, requirement, or documented calculation basis (test oracle).
- Never derive an expected value by running the implementation and copying its output.

> Details of the test oracle principle are defined in `shared/documents/quality-policy.md` §4.

## 7. Cross-Language Prohibited Patterns

Rules promoted from stack documents because the same concept holds in two or more major languages (`shared/documents/static-check-standard.md` §4.2). Language-specific examples are illustrative; apply the concept to whichever language the product uses.

**Lint 資産提供後は Lint 担保。それまでは AI レビュー担保。**

### 7.1 Wildcard imports prohibited

> Catalog: A1（フェーズ3で Lint 化予定 — Lint 資産提供後は Lint 担保、それまでは AI レビュー担保）

Import each symbol explicitly.

- Java: `import java.util.*;` → `import java.util.List;` / `import java.util.Map;`
- Python: `from x import *` → `from x import parse_config`

### 7.2 Fully-qualified name usage prohibited

> Catalog: A1（フェーズ3で Lint 化予定 — Lint 資産提供後は Lint 担保、それまでは AI レビュー担保）

Always add an import statement and use the short name.

- Java: `java.util.Map<String, Object> data = new java.util.HashMap<>();` → import `Map` / `HashMap` and use `Map<String, Object> data = new HashMap<>();`
- C#: `System.Collections.Generic.List<T>` written inline → `using System.Collections.Generic;` and use `List<T>`

### 7.3 Unused imports prohibited

> Catalog: C3（フェーズ3で Lint 化予定 — Lint 資産提供後は Lint 担保、それまでは AI レビュー担保）

Remove imports that are no longer referenced. The concept holds identically in TypeScript, Java, and Python.

### 7.4 Magic numbers prohibited

> Catalog: C6（フェーズ3で Lint 化予定 — Lint 資産提供後は Lint 担保、それまでは AI レビュー担保）

Extract unexplained literals into named constants or enums. The concept holds identically in TypeScript, Java, and Python.

- Exceptions: conventional values whose meaning is unambiguous in context (`0`, `1`, `-1`, array indices in a loop).

## Checklist

> フェーズ3では Lint 担保済みの項目をこのチェックリストから削除する。それまでは移行形として現状維持し、対応するカタログ番号を各節に付記する。

### Git/GitHub
- [ ] Commit message follows `<type>: <subject>` format
- [ ] Type is correct
- [ ] Subject line 50 chars or less
- [ ] Branch name is kebab-case and follows conventions

### Security

> Catalog: B1 / B2 / F2（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- [ ] No hardcoded API keys or secrets
- [ ] Secrets managed via environment variables
- [ ] Log output masked for sensitive data
- [ ] Input validation implemented (server-side required)
- [ ] No IDOR vulnerabilities (authorization checked for resource access)
- [ ] CSRF protection implemented
- [ ] Security headers configured (production)
- [ ] No sensitive data in API responses beyond what's necessary

### Performance

> Catalog: D1（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- [ ] No N+1 problems
- [ ] Proper caching strategy
- [ ] Pagination for large datasets
- [ ] Proper indexes set

### Code Quality

> Catalog: C8（TODO 期限・コメントアウトコード）/ A1（`console.log` / `System.out.println` 禁止）/ A3（エラーハンドリング規律）（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- [ ] Documentation comments appropriate
- [ ] TODO/FIXME has deadline/priority
- [ ] No System.out.println / console.log in production
- [ ] No commented-out code
- [ ] Proper error handling
