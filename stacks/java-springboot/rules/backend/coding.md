# Backend Coding Rules

> **Tech Stack**: Java + Spring Boot

> 言語横断の禁止パターン（ワイルドカード import・完全修飾名の直書き・未使用 import・マジックナンバー）は**カタログ A1・C3・C6（`documents/development/static-check-standard.md`）を恒久の正**とする。移行期の本文は `documents/development/coding-rules/common-rules.md` §7 を参照（同 §7 は Lint 配線の確認後に削除される）。
> レイヤー責務・DRY・仕様ベーステストの一般原則は common-rules.md §6、セキュリティ・パフォーマンスの汎用原則は同 §4 / §5 を参照。本書が持つのは Java + Spring Boot 固有の具体のみである。
> `> Catalog:` 注記の読み方は common-rules.md「Catalog 注記の読み方」を参照。ただし**スタック別ルール文書の項目はカタログへは移さず**、対応する Lint 資産の提供後に「項目名 + カタログ番号 + Lint 資産参照」の短縮形へ縮約する（削除はしない）。事前ビルド資産が提供済みの項目は `Catalog: <番号> — 担保: <資産参照>` 形式（未配線のプロダクトではカバレッジマップで AI レビュー担保に割り当てる）、未提供の項目は `（Lint 資産提供予定）` 形式を用いる。
> **パス表記について**: 本書が挙げるパスはすべて**配布後のプロダクト側表記**である。ハーネスリポジトリでの対応は `documents/development/static-check-standard.md` → `shared/documents/static-check-standard.md`、`documents/development/coding-rules/common-rules.md` → `shared/documents/coding-rules/common-rules.md`、`documents/development/coding-rules/backend-rules.md` → `stacks/java-springboot/documents/coding-rules/backend-rules.md`。完全な対応表はカタログ §5。

## Prohibited Patterns

### Unnecessary try-catch prohibited

> Catalog: A3 — 空 catch・握りつぶし・過度に広い catch の機械検出は担保: `lint/checkstyle/checkstyle.xml`（error-handling グループ: EmptyCatchBlock / IllegalCatch）・`lint/ast-grep/error-handling/`（no-empty-catch-java）。
> どこで捕捉し何を返すかの設計判断はカタログ対応なし — AI レビュー恒久担保。

Delegate to the common exception handler (`@RestControllerAdvice`). Only use try-catch for special cases (resource management, etc.).

## Layer Architecture (Spring mapping)

> Catalog: C1 / C2 — レイヤー境界・依存方向・パッケージ循環の機械検出は担保: `lint/archunit/ArchitectureRulesTest.java`（テンプレート — ベースパッケージ置換で配線）。
> ArchUnit で機械検出できるのはそこまでであり、読み取り処理に `readOnly = true` が適切か・トランザクション境界の切り方が妥当かといった判断はカタログ対応なし — AI レビュー恒久担保。
> 責務分割・依存方向・トランザクション境界の所在といった一般原則は common-rules.md §6.1 を正とする。本節はその Spring における対応のみを示す。

| 汎用レイヤー（common-rules.md §6.1） | Spring での対応 | Spring 固有の具体 |
|---|---|---|
| Presentation | `@RestController` | Routing と `@Valid` による入力検証のみ。Repository を直接呼ばない |
| Business logic | `@Service` | `@Transactional`（読み取りは `readOnly = true`）でトランザクション境界を持つ |
| Data access | `@Repository` / Spring Data | データ入出力のみ。クエリ品質の規約は common-rules.md §5（カタログ D1）を参照 |

Spring 規約の詳細（Controller / Service / DTO / Repository の具体的な書き方とコード例）は `documents/development/coding-rules/backend-rules.md` §2 を参照。

## Coding Conventions

> Catalog: C4 — メソッド長・複雑度・引数数・ネスト深度の機械検出は担保: `lint/checkstyle/checkstyle.xml`（complexity グループ）/ C7 — Google Java Style Guide の命名・構造（google-java-format / Checkstyle。Lint 資産提供予定）/ A1 — フィールドインジェクション（`@Autowired` フィールド）禁止（Lint 資産提供予定 — Checkstyle 等の禁止パターン検出）。

- Google Java Style Guide compliance
- Constructor injection (`@RequiredArgsConstructor`) — no field injection

> DRY 原則は common-rules.md §6.2、仕様ベーステストの原則は同 §6.3 を参照。

## Performance Requirements

> 汎用のクエリ品質規約は common-rules.md §5 を正とする。カバレッジは同節のカーブアウトに従い分割される — N+1 防止・`SELECT *` 禁止・ページネーションはカタログ D1（Lint 化予定。N+1 は静的検出のみでは担保済みとみなさない）、インデックス設計はカタログ対応なし — AI レビュー恒久担保。
> JPA / jOOQ 固有の具体（JOIN FETCH・バッチフェッチ・DTO プロジェクション・バルク操作等）は `documents/development/coding-rules/backend-rules.md` §6 を参照。

## Security Requirements

> 汎用のセキュリティ原則（全エンドポイントでの認証・認可、IDOR 防止、ログへの機密データ出力禁止、OWASP Top 10 観点）は common-rules.md §4 を正とする。本節は Spring 固有の実現手段のみを持つ。
> Catalog: B2 — CORS の `*` 直書き等、機械検出可能な設定パターンのみ Lint 資産提供予定。
> 許可オリジン集合の妥当性・FilterChain の認可設計はカタログ対応なし — AI レビュー恒久担保。

- Spring Security FilterChain で全エンドポイントの認証・認可を設定する
- CORS: 許可オリジンをホワイトリストで明示（本番環境でワイルドカード `*` は禁止）
