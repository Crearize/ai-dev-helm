# Backend Coding Rules

> **Tech Stack**: Java + Spring Boot

> 言語横断の禁止パターン（ワイルドカード import・完全修飾名の直書き・未使用 import・マジックナンバー）は `documents/development/coding-rules/common-rules.md` §7 / カタログ A1・C3・C6 を参照。
> レイヤー責務・DRY・仕様ベーステストの一般原則は同 §6、セキュリティ・パフォーマンスの汎用原則は同 §4 / §5 を参照。本書が持つのは Java + Spring Boot 固有の具体のみである。
> `> Catalog:` 注記の読み方は common-rules.md「Catalog 注記の読み方」を参照。ただし**スタック別ルール文書の項目はカタログへは移さず**、フェーズ3で Lint 資産が配線された後に「項目名 + カタログ番号 + Lint 資産参照」の短縮形へ縮約する（削除はしない）。そのため本書の注記は `（フェーズ3で Lint 資産提供予定）` 形式を用いる。
> 上記のパスは**配布後のプロダクト側表記**（カタログ §5 の対応表）。ハーネスリポジトリでは `shared/documents/coding-rules/common-rules.md`。

## Prohibited Patterns

### Unnecessary try-catch prohibited

> Catalog: A3 — 空 catch・握りつぶし・過度に広い catch の機械検出のみフェーズ3で Lint 資産提供予定（PMD / ast-grep）。
> どこで捕捉し何を返すかの設計判断はカタログ対応なし — AI レビュー恒久担保。

Delegate to the common exception handler (`@RestControllerAdvice`). Only use try-catch for special cases (resource management, etc.).

## Layer Architecture (Spring mapping)

> Catalog: C1（レイヤー境界・依存方向。フェーズ3で ArchUnit の Lint 資産提供予定）
> 責務分割・依存方向・トランザクション境界の所在といった一般原則は common-rules.md §6.1 を正とする。本節はその Spring における対応のみを示す。

| 汎用レイヤー（common-rules.md §6.1） | Spring での対応 | Spring 固有の具体 |
|---|---|---|
| Presentation | `@RestController` | Routing と `@Valid` による入力検証のみ。Repository を直接呼ばない |
| Business logic | `@Service` | `@Transactional`（読み取りは `readOnly = true`）でトランザクション境界を持つ |
| Data access | `@Repository` / Spring Data | データ入出力のみ。クエリ品質の規約は common-rules.md §5（カタログ D1）を参照 |

## Coding Conventions

> Catalog: C4 / C7 — Google Java Style Guide 準拠（行長・ファイルサイズは C4、命名・構造は C7。google-java-format / Checkstyle）/ A1 — フィールドインジェクション（`@Autowired` フィールド）禁止（ArchUnit / Checkstyle）。いずれもフェーズ3で Lint 資産提供予定。

- Google Java Style Guide compliance
- Constructor injection (`@RequiredArgsConstructor`) — no field injection

> DRY 原則は common-rules.md §6.2、仕様ベーステストの原則は同 §6.3 を参照。

## Performance Requirements

> 汎用のクエリ品質規約（N+1 防止・`SELECT *` 禁止・ページネーション・インデックス設計）は common-rules.md §5（カタログ D1）を正とする。
> JPA / jOOQ 固有の具体（JOIN FETCH・バッチフェッチ・DTO プロジェクション・バルク操作等）は `documents/development/coding-rules/backend-rules.md` §6 を参照。

## Security Requirements

> 汎用のセキュリティ原則（全エンドポイントでの認証・認可、IDOR 防止、ログへの機密データ出力禁止、OWASP Top 10 観点）は common-rules.md §4 を正とする。本節は Spring 固有の実現手段のみを持つ。
> Catalog: B2 — CORS の `*` 直書き等、機械検出可能な設定パターンのみフェーズ3で Lint 資産提供予定。
> 許可オリジン集合の妥当性・FilterChain の認可設計はカタログ対応なし — AI レビュー恒久担保。

- Spring Security FilterChain で全エンドポイントの認証・認可を設定する
- CORS: 許可オリジンをホワイトリストで明示（本番環境でワイルドカード `*` は禁止）
