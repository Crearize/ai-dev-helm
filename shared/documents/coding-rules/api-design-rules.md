# API Design Rules

REST API design rules for this project.

## 1. Endpoint Naming

### Basic Rules
- **Lowercase + hyphen-case**: `/api/v1/student-courses`
- **Resource names are plural**: `/api/v1/students`, `/api/v1/payments`
- **No verbs**: HTTP methods express operations (`/api/v1/students/create` is prohibited)

### Prefix Examples
| Target | Prefix | Example |
|--------|--------|---------|
| Admin | `/admin/v1/` | `/admin/v1/students` |
| User-facing | `/api/v1/` | `/api/v1/me` |
| Public (no auth) | `/public/v1/` | `/public/v1/products` |
| Debug (local only) | `/debug/v1/` | `/debug/v1/token` |

## 2. URL Nesting Limit

- **2 levels max**: `/api/v1/students/{id}/courses` is OK
- **3+ levels should be flattened**: Use query parameters

```
# NG - 3+ levels (prohibited)
GET /api/v1/students/{studentId}/courses/{courseId}/payments

# OK - flattened (recommended)
GET /api/v1/payments?studentId={studentId}&courseId={courseId}
```

## 3. HTTP Method Usage

| Method | Purpose | Idempotent | Request Body |
|--------|---------|-----------|--------------|
| GET | Retrieve | Yes | None |
| POST | Create | No | Yes |
| PUT | Full update | Yes | Yes |
| PATCH | Partial update | No | Yes |
| DELETE | Delete | Yes | None |

## 4. Path Parameters vs Query Parameters

| Usage | Use | Example |
|-------|-----|---------|
| Resource identification | Path parameter | `/students/{id}` |
| Filtering | Query parameter | `?status=active` |
| Sorting | Query parameter | `?sort=createdAt,desc` |
| Paging | Query parameter | `?page=0&size=20` |

## 5. Pagination

> Catalog: D1（ページネーション欠落・無制限クエリの検出。フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

### Request Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | int | 0 | Page number (0-based) |
| `size` | int | 20 | Items per page |
| `sort` | String | - | Sort criteria (e.g., `createdAt,desc`) |

### Response Format
```json
{
  "content": [...],
  "totalElements": 100,
  "totalPages": 5,
  "number": 0,
  "size": 20,
  "first": true,
  "last": false
}
```

## 6. Error Response Format

Unified error response format:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource not found",
    "details": {
      "resourceId": "550e8400-e29b-41d4-a716-446655440000"
    }
  },
  "timestamp": "2025-01-08T10:00:00+09:00"
}
```

### Top-Level Fields
| Field | Type | Description |
|-------|------|-------------|
| `error` | Object | Error detail object |
| `timestamp` | String | Error timestamp (ISO 8601 with timezone) |

### `error` Object Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | String | Yes | Error code (defined in error-codes.md) |
| `message` | String | Yes | Human-readable error message |
| `details` | Object | No | Additional info (validation field details, etc.) |

## 7. Backward Compatibility

### Breaking Change の定義
以下は breaking change であり、既存クライアントに影響する：
- エンドポイントURLの変更・削除
- HTTPメソッドの変更
- 必須リクエストパラメータの追加
- レスポンスフィールドの削除・型変更
- ステータスコードの変更
- エラーコードの変更

### 非Breaking Change（安全な変更）
- 新規エンドポイントの追加
- オプショナルなリクエストパラメータの追加
- レスポンスフィールドの追加
- 新しいエラーコードの追加

### バージョニング戦略
- URLパスベースのバージョニング: `/api/v1/`, `/api/v2/`
- breaking changeが必要な場合は新バージョンを作成
- 旧バージョンは deprecation period を設けてから削除

## 8. API Response Design

> Catalog: D1 / B1（リスト取得のページネーション必須は D1、レスポンスへの機密・個人情報混入禁止は B1。フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

### 成功レスポンスの一貫性
- 単体取得: リソースオブジェクトを直接返す
- リスト取得: ページネーション情報付きのラッパーオブジェクトで返す
- 作成: 201 Created + 作成されたリソースを返す
- 更新: 200 OK + 更新されたリソースを返す
- 削除: 204 No Content（レスポンスボディなし）

### レスポンスフィールド命名
- camelCase を使用
- boolean型は `is` / `has` プレフィックス: `isActive`, `hasPermission`
- 日時は ISO 8601 形式（タイムゾーン付き）: `2025-01-08T10:00:00+09:00`
- ID は文字列型（UUID）: `"id": "550e8400-e29b-41d4-a716-446655440000"`

## Checklist

> Catalog: D1（ページネーション関連項目）/ B1（レスポンスの機密情報混入）（フェーズ3で Lint 化予定 — 現在は AI レビュー担保）

- [ ] Endpoints use lowercase + hyphen-case
- [ ] Resource names are plural
- [ ] URL nesting 2 levels or less
- [ ] HTTP methods appropriate
- [ ] Pagination uses page/size/sort parameters
- [ ] Error responses follow unified format
- [ ] Breaking change がないことを確認（または新バージョンで対応）
- [ ] 成功レスポンス形式がAPI設計ルールに準拠
- [ ] レスポンスフィールド命名規則に準拠（camelCase, ISO 8601日時）
- [ ] 新規エンドポイントにページネーション対応（リスト系）
