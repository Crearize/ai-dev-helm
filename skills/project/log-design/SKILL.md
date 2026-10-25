---
name: log-design
description: ログ設計の妥当性チェック。一般的なログ基準と日本国内法的要件（電子帳簿保存法・個人情報保護法等）に基づき、ログ設計・実装を検証する。
---

# Log Design Check - ログ設計チェック

導入先の補足ファイル `documents/development/project/log-design.md` があれば、その段で読む。補足ファイルは製品への当てはめ（コマンド・パス・ポート等）だけを持ち、本スキルの規則を緩めない。食い違えば本スキルが優先する。

プロジェクトのログ設計が一般的な基準と法的要件を満たしているか体系的にチェックし、不足があれば実装パターンを提示する。

> **参照**: セキュリティ関連のログルールは `documents/development/coding-rules/common-rules.md` Section 4 も併せて確認すること。

## 実行フロー

```
Step 1: 現状分析（既存のログ設定・出力を確認）
  ↓
Step 2: 一般的ログ基準チェック
  ↓
Step 3: 法的要件チェック
  ↓
Step 4: 不足箇所の実装パターン提示
  ↓
Step 5: レポート出力
```

---

## Step 1: 現状分析

以下を確認する：
- ログライブラリ・設定ファイル（logback-spring.xml、pino設定等）
- 既存のログ出力箇所
- 取り扱うデータの種類（取引データ、個人情報、メール送信等）

---

## Step 2: 一般的ログ基準チェック

### ログレベル基準

| レベル | 用途 | 例 |
|--------|------|-----|
| ERROR | システム異常、復旧不可能なエラー | DB接続失敗、外部API障害、未処理例外 |
| WARN | 想定内だが注意が必要な事象 | リトライ発生、閾値超過、非推奨API使用 |
| INFO | ビジネス上重要なイベント | ユーザーログイン/ログアウト、決済完了、重要な状態遷移 |
| DEBUG | 開発・調査用の詳細情報 | リクエスト/レスポンス詳細、SQL実行詳細（本番では無効化） |

### 構造化ログ実装パターン

**Spring Boot + Logback (JSON形式):**

```java
// logback-spring.xml で net.logstash.logback.encoder.LogstashEncoder を使用
// または logback-spring.xml で JSON パターンを定義

// 出力例:
// {
//   "timestamp": "2025-01-08T10:00:00.000+09:00",
//   "level": "INFO",
//   "logger": "com.example.service.PaymentService",
//   "message": "Payment completed",
//   "traceId": "abc123",
//   "userId": "user-001",
//   "action": "PAYMENT_COMPLETE",
//   "amount": 10000,
//   "paymentId": "pay-001"
// }

@Slf4j
@Service
public class PaymentService {
    public void completePayment(Payment payment) {
        // MDC にトレース情報をセット
        MDC.put("action", "PAYMENT_COMPLETE");
        MDC.put("paymentId", payment.getId().toString());
        log.info("Payment completed: amount={}", payment.getAmount());
        MDC.clear();
    }
}
```

**Next.js (API Routes / Server Actions):**

```typescript
// lib/logger.ts - 構造化ログユーティリティ
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// 使用例: API Route
export async function POST(request: Request) {
  const body = await request.json();
  logger.info(
    { action: 'ORDER_CREATED', orderId: body.id, userId: session.userId },
    'Order created'
  );
}
```

### 機密情報マスキングパターン

**ログに出力してはいけない情報:**
- パスワード、トークン、APIキー
- クレジットカード番号（PCI DSS）
- マイナンバー（個人番号）

**マスキング実装例 (Java):**

```java
public class PiiMasker {
    public static String maskEmail(String email) {
        if (email == null) return "***";
        int atIndex = email.indexOf('@');
        if (atIndex < 0) return "***"; // @がない場合は全マスク
        if (atIndex <= 1) return "***@" + email.substring(atIndex + 1);
        return email.charAt(0) + "***@" + email.substring(atIndex + 1);
    }

    public static String maskPhone(String phone) {
        if (phone == null || phone.length() < 4) return "****";
        return "****" + phone.substring(phone.length() - 4);
    }

    public static String maskCardNumber(String cardNumber) {
        if (cardNumber == null) return "****";
        String digits = cardNumber.replaceAll("[^0-9]", "");
        if (digits.length() < 4) return "****";
        return "****-****-****-" + digits.substring(digits.length() - 4);
    }

    public static String maskMyNumber(String myNumber) {
        // マイナンバーは12桁の数字。全桁マスクが原則（部分表示も不可）
        if (myNumber == null) return "************";
        return "************";
    }
}
```

### ログインジェクション防止

ユーザー入力をログ出力する際、改行コード（CR/LF）を含む文字列がそのまま出力されると、偽のログ行が挿入される（ログインジェクション/ログフォージング）。監査ログの信頼性を損なうため、必ずサニタイズする。

```java
public static String sanitizeForLog(String input) {
    if (input == null) return "";
    return input.replaceAll("[\\r\\n]", " ");
}

// 使用例
log.info("User search: query={}", sanitizeForLog(userInput));
```

```typescript
function sanitizeForLog(input: string): string {
  return input.replace(/[\r\n]/g, ' ');
}
```

**フロントエンド (Server-side only):**

```typescript
// 機密情報をクライアントサイドに送信しない
// - API RouteやServer Actionのログにのみ詳細情報を記録
// - クライアントには汎用エラーメッセージのみ返す
// - console.log/console.error は本番ビルドで除去する（eslint no-console）
```

### 必須ログ出力ポイント

| カテゴリ | ログ対象 | レベル |
|---------|---------|--------|
| 認証 | ログイン成功/失敗、ログアウト、トークンリフレッシュ | INFO |
| 認可 | 権限不足によるアクセス拒否 | WARN |
| データ変更 | 重要データのCRUD操作（誰が・いつ・何を） | INFO |
| 決済 | 決済開始・完了・失敗 | INFO/ERROR |
| 外部連携 | 外部API呼び出し（リクエスト/レスポンス概要） | INFO |
| エラー | 未処理例外、システム障害 | ERROR |

---

## Step 3: 法的要件チェック

### 電子帳簿保存法（電子取引データ保存）

**該当条件**: 電子的に授受した取引情報（注文書、請求書、領収書、見積書等に相当するデータ）を扱う場合

**チェックリスト:**
- [ ] 取引データの電子保存が可能な設計になっているか
- [ ] タイムスタンプ要件: 取引データに信頼できるタイムスタンプが付与されるか（NTPサーバー同期、またはタイムスタンプサービス利用）
- [ ] 改ざん防止: 取引データの変更履歴（監査ログ）が記録されるか、または変更不可の設計か
- [ ] 検索要件: 取引年月日・取引金額・取引先で検索可能か
- [ ] 保存期間: 原則7年間（欠損金繰越控除適用時は10年間）のデータ保持設計があるか

**監査ログ実装パターン:**

```java
// 監査ログテーブル設計例
// audit_logs テーブル
// - id: UUID (PK)
// - entity_type: VARCHAR (対象エンティティ種別)
// - entity_id: UUID (対象エンティティID)
// - action: VARCHAR (CREATE/UPDATE/DELETE)
// - actor_id: UUID (操作者ID)
// - before_value: JSONB (変更前の値、NULLable)
// - after_value: JSONB (変更後の値)
// - created_at: TIMESTAMP WITH TIME ZONE (操作日時)

// Spring AOP で自動記録する実装パターン
@Aspect
@Component
@RequiredArgsConstructor
public class AuditLogAspect {
    private final AuditLogRepository auditLogRepository;

    @AfterReturning("@annotation(Auditable)")
    public void logAudit(JoinPoint joinPoint) {
        // 操作内容を自動記録
    }
}

// 使用例
@Auditable
@Transactional
public OrderResponse createOrder(CreateOrderRequest request) {
    // 注文作成処理
}
```

### 個人情報保護法

**該当条件**: 個人情報（氏名、メールアドレス、住所、電話番号等）を取り扱う場合

**チェックリスト:**
- [ ] 個人情報を含むログ出力が適切にマスキングされているか
- [ ] アクセスログ: 個人情報へのアクセスが記録されているか（誰が・いつ・どのデータに）
- [ ] データ削除: 利用者からの削除要求に対応できる設計か（論理削除 or 物理削除 + ログ保持）
- [ ] 保存期間: 利用目的に必要な期間を超えて個人情報を保持しない設計か
- [ ] 第三者提供: 外部APIに個人情報を送信する場合、同意取得とログ記録の設計があるか

**個人情報アクセスログ実装パターン:**

```java
// アクセスログ出力例
log.info("Personal data accessed: entity={}, entityId={}, fields={}, actor={}",
    "Student", studentId, "name,email,phone", currentUserId);
```

### 特定電子メール法

**該当条件**: 広告・宣伝目的の電子メールを送信する場合

**チェックリスト:**
- [ ] 送信記録の保存: 送信日時、送信先、送信内容の記録が保存されるか
- [ ] オプトイン記録: 受信同意の記録（同意日時、同意方法）が保存されるか
- [ ] オプトアウト対応: 配信停止要求の記録と即時反映の設計があるか

---

## Step 4: 実装パターン提示

チェック結果に基づき、不足箇所について上記の実装パターンをプロジェクトのスタックに合わせて提示する。

---

## Step 5: レポート出力

チェック結果をMarkdownチェックリスト形式でコンソールに出力する：

```markdown
## Log Design Check Report

### 一般的ログ基準
- [x] ログレベル基準が定義されている
- [ ] 構造化ログが導入されていない -> 実装パターンを提示
- [x] 機密情報マスキングが実装されている

### 法的要件（電子帳簿保存法）
- [x] 該当: 取引データを扱う
- [ ] タイムスタンプ要件: 未対応 -> 実装パターンを提示
- [x] 改ざん防止: 監査ログ実装済み

### 法的要件（個人情報保護法）
- [x] 該当: 個人情報を扱う
- [x] マスキング: 実装済み
- [ ] アクセスログ: 未実装 -> 実装パターンを提示

### 法的要件（特定電子メール法）
- [ ] 非該当（メール送信機能なし）

### Summary
- チェック項目: 12件
- 対応済み: 8件
- 要対応: 4件（実装パターン提示済み）
```
