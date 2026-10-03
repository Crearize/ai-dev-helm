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
| `Catalog: <番号>（Lint 化予定）` | Lint で担保可能。対応する Lint 資産がプロダクトへ配線され、実際に配線されたことを確認した後に本文書から削除する |
| `Catalog: <番号>（… は AI レビュー恒久担保）` | カバレッジが分割される項目。機械検出可能な部分のみ Lint 化し、判断を要する部分は本文書に恒久的に残す |
| `… はカタログ対応なし — AI レビュー恒久担保` | 機械判定できない項目。本文書に恒久的に残す |
| `Catalog: <番号> — 担保: <資産参照>` / `Catalog: <番号>（Lint 資産提供予定）` | **スタック別ルール文書（`stacks/<stack>/rules/`）専用の表記**。言語・FW 固有かつ Lint 担保可能な項目に付く。前者は事前ビルド Lint 資産が提供済みの項目（未配線のプロダクトではカバレッジマップで AI レビュー担保に割り当てる）、後者は資産が未提供の項目。いずれも項目は**削除せず**、資産提供後に「項目名 + カタログ番号 + Lint 資産参照」の形式に縮約する（カタログ §4.1） |

**Lint 資産が未配線のプロダクトでの担保方法**: 既存の静的チェック（プロダクトの ESLint / Checkstyle / tsc 等、CLAUDE.md に登録された静的チェックコマンド）で担保済みの項目は Lint 担保として扱う（カタログ §4.1）。それ以外を AI レビューで担保する。

注記は節（ブロック）単位で付く場合がある。その場合、**注記に挙がっていない項目はそのカテゴリの対象ではない** — 対象外の項目は同じ注記内に明示する。

**注記のない節**は、カタログ対応の判定が**未了**であることを意味する（「カタログ対応なし」と確定したわけではない）。未判定の節は判定が済み次第、注記を付ける。

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

> Catalog: C8 — 担保候補: 横断リンター（todo-deadline / commented-code）。未配線プロダクトはカバレッジマップで AI レビュー担保に割り当てる

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

> Catalog: B1 — 担保候補: 横断リンター（secrets）。未配線プロダクトはカバレッジマップで AI レビュー担保に割り当てる

- Never commit API keys to Git
- Production secrets managed via environment variable services
- Secret configuration files always in .gitignore

## 4. Security Rules

### Secret Management

> Catalog: B1 / F2 — B1 の担保候補: 横断リンター（secrets）。4項目すべてが B1 対応。うち「Log output masking」は F2 とも対応（F2 の横断リンター資産は未提供）。未配線プロダクトはカバレッジマップで AI レビュー担保に割り当てる

- **Environment variable management** (no hardcoding)
- **Log output masking**
- **Never commit to Git** (.gitignore)
- **Never expose to client-side**

### Input Validation

> Catalog: B2（SQL インジェクション・XSS のコードレベル脆弱性パターン。Lint 化予定）
> 「Server-side validation required」はカバレッジが分割される — **検証の実施有無**（バリデーションアノテーション・スキーマ適用の存在）は機械検出可能で Lint 化予定（B2）。**検証内容・境界条件・ビジネスルールとしての妥当性**はカタログ対応なし — AI レビュー恒久担保。

- Server-side validation required
- SQL injection prevention (parameterized queries)
- XSS prevention (output escaping)

### OWASP Top 10 (2021) Awareness

> Catalog: B2 / B3 / F2。内訳は下記の対応表を参照。B2 の担保候補: `lint/ast-grep/security/`（eval・動的コード実行 / 弱いハッシュ(MD5/SHA1) / TLS 検証無効化 / シェルコマンドインジェクションのみ — B2 の一部）。B3 の担保候補: 横断リンター（import-exists = 存在しないパッケージの import 検出）。いずれも B2/B3 の一部のみを担保し、残り（SQL/XSS・デシリアライゼーション・既知脆弱性のある依存等）は AI レビュー担保。未配線プロダクトはカバレッジマップで AI レビュー担保に割り当てる。
> OWASP 項目との対応（`Axx` は OWASP の項番であり、カタログ番号ではない）: A03（インジェクション）と A02 のうち弱い暗号・TLS 検証の無効化検出 → B2 / A06（脆弱な依存）・A08（依存の整合性）→ B3 / A08 のうちデシリアライゼーション攻撃への対策 → B2 / A09 のログ出力そのもの → F2。
> A01（アクセス制御・IDOR）・A04（設計）・A05（設定）・A07（認証）・A10（SSRF の許可先設計）等の設計・運用面はカタログ対応なし — AI レビュー恒久担保。ただし認可アノテーションの有無・デバッグモード有効化・セキュリティヘッダー設定の有無・SSRF の実装パターンといった**機械検出可能な部分**は B2 として Lint 化予定。

- **A01: Broken Access Control**: 全てのエンドポイントで認証・認可チェックを実施。IDORに注意（他ユーザーのリソースにアクセスできないこと）
- **A02: Cryptographic Failures**: パスワードはbcrypt/scrypt/Argon2でハッシュ化。通信はTLS必須。機密データは保存時も暗号化を検討
- **A03: Injection**: 全ての外部入力にパラメタライズドクエリを使用。動的SQLの文字列結合は禁止。ログ出力時もCR/LFをサニタイズ（ログインジェクション防止）
- **A04: Insecure Design**: 脅威モデリングを意識した設計。ビジネスロジックの乱用防止（レートリミット、ワークフロー制御）。セキュリティ要件を設計段階で定義
- **A05: Security Misconfiguration**: 本番環境でデバッグモード無効。不要なHTTPメソッド無効（許可リスト方式 → S-6）。適切なセキュリティヘッダー設定（基準値 → S-2）
- **A06: Vulnerable and Outdated Components**: 既知の脆弱性がある依存パッケージを使用しない（本番依存の監査 → S-1）。セキュリティアップデートは速やかに適用
- **A07: Identification and Authentication Failures**: セッショントークンは十分なエントロピーで生成。ブルートフォース対策（アカウントロックアウト、レートリミット）。ログイン失敗の応答からアカウントの実在を推測させない・仮パスワードの期限を既存セッションにも効かせる（→ S-4）
- **A08: Software and Data Integrity Failures**: 依存パッケージの整合性を検証（lockfileの一貫性維持）。CI/CDパイプラインの改ざん防止。デシリアライゼーション攻撃への対策
- **A09: Security Logging and Monitoring Failures**: セキュリティイベント（ログイン失敗、認可拒否、入力バリデーション失敗）を確実にログ出力。監視・アラート体制の構築
- **A10: SSRF (Server-Side Request Forgery)**: 外部URLを受け取る機能はホワイトリスト方式で制限。内部ネットワークへのリクエストをブロック

### CSRF Protection

> Catalog: B2 — `csrf().disable()` 等の危険なセキュリティデフォルト・Cookie 属性欠落の検出（Lint 化予定）。
> どの対策を組み合わせるかの設計妥当性（SameSite + Content-Type / カスタムヘッダーの選択）はカタログ対応なし — AI レビュー恒久担保。

- 状態変更リクエスト（POST/PUT/DELETE）にCSRF対策を実施
- SPAの場合: `SameSite Cookie（Lax以上）` + CORS + `Content-Type: application/json` のみ受付（またはカスタムヘッダー `X-Requested-With` 検証）
- `SameSite=Lax` のみでは不十分なケースがある（form-encoded POSTが通る）。必ずContent-Typeチェックまたはカスタムヘッダーを併用

### API Response Security

> Catalog: B1（「APIレスポンスに不要な個人情報を含めない」および「ログにパスワード・トークン・個人情報を出力しない」の両項目）/ F2（ログ規律として後者に併せて対応）。B1 の担保候補: 横断リンター（secrets — ハードコードされたトークン / ログへの機密出力を検出。API レスポンス設計の妥当性は AI レビュー担保）。未配線プロダクトはカバレッジマップで AI レビュー担保に割り当てる。

- APIレスポンスに不要な個人情報を含めない
- ログにパスワード・トークン・個人情報を出力しない

### Dependency Security

> Catalog: B3 — 担保候補: 横断リンター（import-exists = 存在しないパッケージの import / typosquatting 検出）。既知脆弱性・lockfile 整合性は npm audit 等の別手段 / AI レビュー担保。未配線プロダクトはカバレッジマップで AI レビュー担保に割り当てる

- 既知の脆弱性がある依存パッケージを使用しない
- セキュリティアップデートは速やかに適用
- lockfileをコミットし、CI/CDでの整合性を保証する
- 新規依存パッケージ追加時はメンテナンス状況・ダウンロード数を確認（typosquatting注意）

### Web アプリの基本対策（S-1〜S-6）

Web を配信する・認証付き API を持つプロジェクト向けの基準。該当しない項目（例: 画面を配信しないなら S-2・S-3）は対象外と記録してよい。**新しい機械的ゲートではなく、規則とレビュー観点**である。AI は影響を判断して対応する。レビューのチェックリストは `.github/review-security.md`。

#### S-1 本番依存の既知脆弱性（A06）

- `lint-scaffolding` が配線した `audit:prod`（本番依存だけを監査する）を `quality-check` Step 2 で実行し、結果（件数・重大度・対応）をレポートに記録する。`lint:all` には束ねず、**失敗しても機械的にブロックしない**（新しく公開された脆弱性だけで作業を止めない）。
- AI は各検出について、実際に到達できる経路か（その機能を使っているか、入力が外部から届くか）を判断して記録する。
- high / critical で**修正版がある**ものは AI が上げる（lockfile を更新し、テストを通す）。上げられない・修正版が無いものは理由を添えて残す。
- 残ったものはプロジェクトごとに **Issue 1 件**にまとめる（パッケージ・重大度・影響の判断・待っている修正版）。検出ごとに Issue を作らない。

#### S-2 セキュリティヘッダ（A05）

Web アプリの基準値（HTML・API・静的配信のすべての応答に付ける）:

| ヘッダ | 基準値 |
|---|---|
| `Content-Security-Policy` | `default-src 'self'` を基本に、`frame-ancestors 'none'`・`object-src 'none'`・`base-uri 'self'` を付ける。必要な許可先だけを個別に足す |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY`（CSP の `frame-ancestors` と併用） |
| `Strict-Transport-Security` | HTTPS で配信する場合。`max-age` は 1 年以上を目標（導入直後は短く始める）。`includeSubDomains`・`preload` は影響を理解してから。プロキシの後ろでは、アプリが HTTPS と認識する設定（転送ヘッダの信頼）が要る |
| `Referrer-Policy` | `strict-origin-when-cross-origin` など。`no-referrer` は下の注意 (b) |

注意:
- (a) `X-XSS-Protection` は付けない（主要ブラウザが XSS フィルタを廃止している）。
- (b) `Referrer-Policy: no-referrer` にすると、GET/HEAD 以外のリクエストの `Origin` が `null` になる（Fetch 仕様）。`Origin` を照合する CSRF 対策を使っているなら `no-referrer` にしない。
- (c) 静的配信とエラー応答（404・405・500・CSRF の 403）を含む**全経路**にヘッダが付くことを、実際のミドルウェアの連なりを通す統合テスト（本物のアプリを呼ぶ。ミドルウェアのモックでは確かめられない）で確かめる。

テストの例（アプリ本体を直接呼ぶ形。Hono の場合）:

```ts
const cases: [string, string][] = [
  ['GET', '/'], ['GET', '/api/me'], ['GET', '/assets/app.js'],
  ['GET', '/no-such-path'],   // 404
  ['TRACE', '/'],             // 405
  ['POST', '/api/items'],     // CSRF の 403（トークン無し）
];
for (const [method, path] of cases) {
  const res = await app.request(path, { method });
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.has('x-xss-protection')).toBe(false);
}
```

#### S-3 外部 CSS・フォント・スクリプト（A05）

- 外部のスタイルシート・フォント・スクリプトは**原則として自前で配信**する（npm の `@fontsource/*` など）。外部 CDN は CSP を `'self'` に保てず、利用者の IP アドレスも第三者へ送られる。
- やむを得ず外部を使う場合は、SRI（`integrity` + `crossorigin`）を付け、CSP の許可先を**ホスト単位で明示**する。
- 落とし穴: Vite は 4KB 未満のアセットを data URI に埋め込む（`build.assetsInlineLimit`）。小さいフォントが `data:` になり `font-src 'self'` に違反する。`assetsInlineLimit` でフォントを埋め込まない設定にするか、やむを得なければ `font-src` に `data:` を足す（前者を推奨）。ビルド後の CSS に `data:font` が無いことを確かめる。

#### S-4 認証の応答（A07）

- ログイン失敗の応答は、**パスワード誤り・存在しない利用者・ロック中・無効化**のどれでも区別できないようにする（ステータス・本文・ヘッダ・応答時間）。ロック中だけ別の応答を返すと、失敗を繰り返すだけでアカウントの実在が分かる。ロック中や存在しない利用者で照合を省くと応答が速くなるので、同じアルゴリズム・同じコストのダミーハッシュで照合する（コストを上げたらダミーも作り直す）。ロックや無効化の通知は、本人へのメールなど別の経路で行う。
- 管理者が発行する仮パスワード・初期パスワードには**有効期限**を設ける。期限は**ログインの時点だけでなく、発行済みのセッションにも効かせる**（セッションの有効期間が長いと、ログイン時の判定だけでは期限後も仮パスワードのセッションで操作できる）。期限切れの仮パスワードのセッションは、パスワード変更以外を拒否する。

#### S-5 認証済み API のキャッシュ指定（A05）

- 認証が必要な API の応答は、既定で `Cache-Control: no-store` にする。再検証が要るもの（ETag 付きの画像など）だけを個別に指定する。
- 注意: 既定値をミドルウェアで付ける場合は**順序**に気をつける。セッション延長などの別のミドルウェアが、後から `private` などを足す・上書きすることがある。既定値は他のミドルウェアが済んだ後（応答の最終段）に、ハンドラが個別指定していないときだけ付ける。統合テストで認証付き GET の実際のヘッダを確かめる。
- `Pragma`・`Expires`・HTML の meta は不要（`Cache-Control` で足りる）。フレームワークが付けていても指摘にしない。

#### S-6 使わない HTTP メソッドの無効化（A05）

2 層で考える。
1. **アプリ全体の許可リスト（最も外側）**: 使うメソッド以外を `405` にし、`Allow` ヘッダを付ける。静的配信がどのメソッドにもファイルを返す、`TRACE` が通る、といった状態を防ぐ。
2. **経路ごと**: その経路が受けないメソッドは `405` + `Allow`。存在しない経路は `404` のまま。

CDN（CloudFront など）は、POST を通すと全メソッドを通す組み合わせしか選べないことがある。CDN では絞れないので、アプリ側で絞る。`GET`/`POST`/`HEAD` 以外を一律に禁止しない（`PATCH` などを使う設計を崩すだけで、安全性は上がらない）。

実装例（Hono。他のどのミドルウェアよりも先に登録する）:

```ts
const ALLOWED = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
app.use('*', async (c, next) => {
  if (!ALLOWED.includes(c.req.method)) {
    return c.body(null, 405, { Allow: ALLOWED.join(', ') });
  }
  await next();
});
```

テストの観点: `TRACE`・`CONNECT` 等が静的パスと API パスの両方で `405` + `Allow` になる / 405 の応答にも S-2 のヘッダが付く / 許可リスト内のメソッドは通る / 存在しない経路は `404`。

> 含めないもの（検討して外した）: パスワードの文字種の強制（NIST SP 800-63B が推奨しない。強さは長さで担保する）、`X-Permitted-Cross-Domain-Policies` など廃止済み・プラグイン時代のヘッダ。

## 5. Performance Rules

### Required

> Catalog: D1（「N+1 problem prevention」「Pagination」「No unnecessary column fetching（`SELECT *`）」の3項目。Lint 化予定。N+1 は静的検出のみでは担保済みとみなさない — カタログ §3 の二段構えを参照）
> 「Index design」はカタログ対応なし — AI レビュー恒久担保。

- **N+1 problem prevention**: Use JOIN or batch fetch
- **Index design**: Set on frequently queried columns
- **Pagination**: Required for large datasets
- **No unnecessary column fetching**: No SELECT *

## 6. Architecture & Design Principles

Language- and framework-independent design principles. This document is the canonical generic statement of them.

> 移行注記: スタック別ルール文書（配布後は AI ツール別の rules ディレクトリ）は、これらの原則の言語・FW 固有の表現のみを持つ**ようにする**。スタック別の詳細規約（`stacks/<stack>/documents/coding-rules/` 配下、配布後は `documents/development/coding-rules/`）の縮約は対応する Lint 資産の配線状態に応じて段階的に行うため、スタック別ルール文書側に元の記述が残っている場合がある。

### 6.1 Layer Responsibilities

> Catalog: C1（レイヤー境界・依存方向。Lint 化予定）
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

> Catalog: C5（コピペコードの機械検出のみ Lint 化予定。既存ユーティリティ確認・抽象化要否の判断は AI レビュー恒久担保）

- Check existing utilities, helpers, and shared components **before** writing new code.
- Extract duplicated logic into a shared location once the same intent appears in multiple places.
- Do not abstract prematurely: duplication of *appearance* without duplication of *intent* is not a DRY violation.

### 6.3 Specification-Based Testing

> Catalog: E1（空 assertion 等のテスト妥当性のみ Lint 化予定。仕様準拠かどうかの判断は AI レビュー恒久担保）

- Test **functional requirements**, not internal state or implementation details.
- Assertions must be traceable to a specification, requirement, or documented calculation basis (test oracle).
- Never derive an expected value by running the implementation and copying its output.

> Details of the test oracle principle are defined in `../quality-policy.md` §4.

## 7. Cross-Language Prohibited Patterns

Rules promoted from stack-specific rule documents because the same concept holds in two or more major languages. Language-specific examples are illustrative; apply the concept to whichever language the product uses.

> 記載根拠: 昇格判定はカタログ（`../static-check-standard.md`）§4.2、移行期にこれらを本文書へ記載する扱いは同 §4.1 に基づく。**本節は Lint 配線を確認した後に削除する。**
> 移行注記: スタック別の詳細規約（`stacks/<stack>/documents/coding-rules/` 配下、配布後は `documents/development/coding-rules/`）には、これらのルールの言語固有の表現が重複して残っている。§6 と同じ移行形であり、縮約は対応する Lint 資産の配線後に行う。

### 7.1 Wildcard imports prohibited

> Catalog: A1（Lint 化予定）

Import each symbol explicitly.

- Java: `import java.util.*;` → `import java.util.List;` / `import java.util.Map;`
- Python: `from x import *` → `from x import parse_config`

### 7.2 Fully-qualified name usage prohibited

> Catalog: A1（Lint 化予定）

Always add an import statement and use the short name.

- Java: `java.util.Map<String, Object> data = new java.util.HashMap<>();` → import `Map` / `HashMap` and use `Map<String, Object> data = new HashMap<>();`
- C#: `System.Collections.Generic.List<T>` written inline → `using System.Collections.Generic;` and use `List<T>`

### 7.3 Unused imports prohibited

> Catalog: C3（Lint 化予定）

Remove imports that are no longer referenced. The concept holds identically in TypeScript, Java, and Python.

### 7.4 Magic numbers prohibited

> Catalog: C6（Lint 化予定）

Extract unexplained literals into named constants or enums. The concept holds identically in TypeScript, Java, and Python.

- Exceptions: conventional values whose meaning is unambiguous in context (`0`, `1`, `-1`, array indices in a loop).

## Checklist

> Lint 配線を確認した項目はこのチェックリストから削除する。未配線の間は移行形として現状維持し、対応するカタログ番号を各節に付記する。既存の静的チェックで担保済みの項目は Lint 担保として扱う（カタログ §4.1）。それ以外を AI レビューで担保する。カタログ対応のない項目は恒久的に残す。

### Git/GitHub

> Catalog: C7（ブランチ命名。採用基準は任意）/ その他はカタログ対応なし — AI レビュー恒久担保

- [ ] Commit message follows `<type>: <subject>` format
- [ ] Type is correct
- [ ] Subject line 50 chars or less
- [ ] Branch name is kebab-case and follows conventions

### Security

> Catalog: B1（シークレット・ログへの機密データ・API レスポンスへの不要な個人情報）/ B2（インジェクション系の実装パターン）/ F2（ログ規律）（Lint 化予定）
> 上記以外の項目 — サーバーサイド入力検証・IDOR（認可チェック）・CSRF 対策・セキュリティヘッダー設定 — はカバレッジが分割される。**実施の有無**（バリデーション・認可アノテーションの付与、CSRF 設定、セキュリティヘッダー設定の存在、`csrf().disable()` 等の危険なデフォルト）は機械検出可能で Lint 化予定（B2）。**内容・ロジックの妥当性**（誰がどのリソースにアクセスしてよいか、検証の境界条件、ヘッダー値の適切さ）はカタログ対応なし — AI レビュー恒久担保とし、恒久的にこのチェックリストに残す。

- [ ] No hardcoded API keys or secrets
- [ ] Secrets managed via environment variables
- [ ] Log output masked for sensitive data
- [ ] Input validation implemented (server-side required)
- [ ] No IDOR vulnerabilities (authorization checked for resource access)
- [ ] CSRF protection implemented
- [ ] Security headers configured (production) with baseline values, verified on all paths (S-2)
- [ ] External CSS/fonts/scripts self-hosted (S-3); login failures indistinguishable and temporary-password expiry enforced on sessions (S-4)
- [ ] Authenticated API responses default to `Cache-Control: no-store` (S-5); method allowlist returns 405 with `Allow` (S-6)
- [ ] Production dependency audit run and judged (S-1)
- [ ] No sensitive data in API responses beyond what's necessary

### Performance

> Catalog: D1（「No N+1 problems」「Pagination for large datasets」の2項目。Lint 化予定）
> 「Proper caching strategy」「Proper indexes set」はカタログ対応なし。AI レビュー恒久担保とし、恒久的にこのチェックリストに残す。

- [ ] No N+1 problems
- [ ] Proper caching strategy
- [ ] Pagination for large datasets
- [ ] Proper indexes set

### Code Quality

> Catalog: C8（TODO/FIXME 期限・コメントアウトコード）/ A1（`console.log` / `System.out.println` 禁止）/ A3（空 catch・握りつぶし等のエラーハンドリング規律）（Lint 化予定）
> 「Documentation comments appropriate」およびエラーハンドリングの設計妥当性（どこで捕捉し何を返すか）はカタログ対応なし。AI レビュー恒久担保とし、恒久的にこのチェックリストに残す。

- [ ] Documentation comments appropriate
- [ ] TODO/FIXME has deadline/priority
- [ ] No System.out.println / console.log in production
- [ ] No commented-out code
- [ ] Proper error handling
