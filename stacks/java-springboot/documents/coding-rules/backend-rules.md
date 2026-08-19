# Backend Coding Rules (Detailed)

> **Tech Stack**: Java + Spring Boot

> 本書は Java + Spring Boot の**詳細規約**である。言語・FW 非依存の汎用原則は `documents/development/coding-rules/common-rules.md` を正とし、Lint で担保可能な項目の**恒久の正**はカタログ（`documents/development/static-check-standard.md`）A1〜F2 とする。
> 本書には汎用ルールの言語固有表現が重複して残っている（移行形）。`> Catalog:` 注記の読み方は common-rules.md「Catalog 注記の読み方」を参照。**スタック別文書の項目は削除せず**、フェーズ3で Lint 資産が配線された後に「項目名 + カタログ番号 + Lint 資産参照」の形式へ縮約する（カタログ §4.1）。
> 要点版のルールは `.claude/rules/backend/coding.md`（配布後の AI ツール別ルール）を参照。パスはすべて配布後のプロダクト側表記（対応表はカタログ §5）。

## Basic Policy

- Google Java Style Guide compliance
- Readability and maintainability first
- AI-friendly code structure

## 1. Java Conventions (Google Java Style Guide)

### 1.1 Formatting

- Indent: **2 spaces**
- Max line length: **100 characters**
- Line ending: LF (Unix)
- Encoding: UTF-8
- Newline at end of file

### 1.2 Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Package | lowercase, dot-separated | `product.controller.admin` |
| Class | UpperCamelCase | `StudentService`, `PaymentHistory` |
| Method | lowerCamelCase | `getStudentById`, `calculatePayment` |
| Variable | lowerCamelCase | `studentName`, `courseCount` |
| Constant | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT` |

### 1.3 Class Design Principles

> Catalog: A1（フェーズ3で Lint 化予定）— 「No wildcard imports」（正は common-rules.md §7.1）と「Field injection prohibited」（Java/Spring 固有、正は本書のみ）の2項目が対応。本節の他項目（単一責務・不変性・DI スタイルの設計判断）はカタログ対応なし — AI レビュー恒久担保。

- **Single Responsibility**: 1 class = 1 responsibility
- **Field Injection Prohibited**: `@Autowired` on a field is prohibited; use constructor injection. Machine-detectable (Catalog A1).
- **Dependency Injection Design**: How injection is structured beyond that (e.g. when a growing constructor signals a responsibility split, optional/provider injection) is a design judgment — no catalog correspondence, permanent AI review.
- **Immutability**: Use final where possible for DTOs and entities
- **No wildcard imports**: `import java.util.*;` is prohibited

## 2. Spring Boot Conventions

### 2.1 Controller Conventions

#### Required
- `@RestController` and `@RequestMapping`
- `@RequiredArgsConstructor` for DI
- RESTful endpoint design (no verbs in URLs)
- Validation with `@Valid`

#### Prohibited
- Business logic in Controller
- Direct Repository calls from Controller

```java
@RestController
@RequestMapping("/api/v1/students")
@RequiredArgsConstructor
public class StudentController {
    private final StudentService studentService;

    @GetMapping("/{id}")
    public ResponseEntity<StudentResponse> getStudent(@PathVariable UUID id) {
        return ResponseEntity.ok(studentService.findById(id));
    }

    @PostMapping
    public ResponseEntity<StudentResponse> createStudent(
            @Valid @RequestBody CreateStudentRequest request) {
        StudentResponse created = studentService.create(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }
}
```

### 2.2 Service Layer

#### Required
- `@Service` annotation
- `@RequiredArgsConstructor` for DI
- `@Slf4j` for logging
- `@Transactional` with `readOnly = true` for reads, default for writes

#### Design Rules
- Business logic aggregation
- Depend on Repository only
- Proper validation implementation
- Appropriate exception throwing

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class StudentService {
    private final StudentRepository studentRepository;

    @Transactional(readOnly = true)
    public StudentResponse findById(UUID id) {
        Student student = studentRepository.findById(id)
            .orElseThrow(() -> new StudentNotFoundException(id));
        return StudentConverter.toResponse(student);
    }

    @Transactional
    public StudentResponse create(CreateStudentRequest request) {
        if (studentRepository.existsByEmail(request.getEmail())) {
            throw new DuplicateEmailException(request.getEmail());
        }
        Student student = StudentConverter.toEntity(request);
        Student created = studentRepository.save(student);
        return StudentConverter.toResponse(created);
    }
}
```

### 2.3 DTO Design

#### Naming Conventions
| DTO Type | Suffix | Example |
|----------|--------|---------|
| Request | Request | `CreateStudentRequest` |
| Response | Response | `StudentResponse` |
| Search | SearchCriteria | `StudentSearchCriteria` |

#### Validation
- `@NotBlank`: Required strings
- `@Size`: String length limits
- `@Email`: Email format
- `@Pattern`: Regex patterns

## 3. Repository Conventions

### Naming Conventions

| Operation | Prefix | Return Type | Example |
|-----------|--------|-------------|---------|
| Single fetch | findById | Optional<T> | `findById(UUID id)` |
| Multiple fetch | findBy/findAll | List<T> | `findByStatus(String status)` |
| Existence check | existsBy | boolean | `existsByEmail(String email)` |
| Insert | save/insert | T | `save(Student student)` |
| Update | update | int | `update(Student student)` |
| Delete | delete | int | `delete(UUID id)` |

### Query Optimization

- **No SELECT ***: Specify required columns only
- **Avoid N+1**: Use JOIN or batch fetch
- **Pagination**: Required for large datasets
- **Index usage**: Proper indexes for frequently queried columns

## 4. Testing Conventions

### Test Structure

- **Test class name**: `[TargetClass]Test`
- **Test method name**: Descriptive - "what_condition_expectedResult" format
- **Pattern**: given-when-then
- **Mocking**: Use Mockito for dependency isolation

### Coverage Targets

- **Line coverage**: 80%+ overall (business logic 90%+)
- **Branch coverage**: 75%+ overall

### Specification-Based Testing

- **No implementation-dependent tests**: Don't test internal state or private methods
- **Test functional requirements**: Derive test cases from specifications
- **Limited mock targets**: Only external dependencies (DB, external API, email, etc.)
- **Test independence**: Each test runs independently of others

```java
// NG - implementation-dependent test
@Test
void cacheContainsStudent() {
    service.getStudent(1L);
    assertThat(cache.get("student:1")).isNotNull();
}

// OK - specification-based test
@Test
void returnsStudentById() {
    Student result = service.getStudent(1L);
    assertThat(result.getName()).isEqualTo("Test User");
}
```

## 5. Exception Handling

### Exception Class Naming

| Type | Suffix | Example |
|------|--------|---------|
| Business | Exception | `StudentNotFoundException` |
| Validation | ValidationException | `EmailValidationException` |
| System | SystemException | `DatabaseSystemException` |

### Global Exception Handler

Use `@RestControllerAdvice` for centralized exception handling with appropriate HTTP status codes and error response format.

## 6. Performance Rules

### 6.1 Query Performance
- **EXPLAIN ANALYZE で実行計画を確認**: 複雑なクエリや大量データを扱うクエリは実行計画を確認すること
- **インデックス設計**: WHERE句・JOIN条件・ORDER BY で頻繁に使用されるカラムにはインデックスを設定
- **カバリングインデックス**: SELECT対象カラムもインデックスに含められる場合は検討
- **LIKE検索**: 前方一致(`LIKE 'prefix%'`)のみインデックスが有効。中間一致・後方一致はフルスキャン

### 6.2 JPA/jOOQ Performance
- **Lazy Loading の罠**: N+1問題を防ぐため、関連エンティティはJOIN FETCHまたはバッチフェッチで取得
- **ページネーション**: 全件取得禁止。大量データは必ずページネーション（OFFSET/LIMIT or キーセットページネーション）
- **射影の活用**: 必要なカラムのみSELECT。DTOプロジェクションを活用
- **バルク操作**: 大量INSERT/UPDATEはバッチ処理（`batchInsert`/`batchUpdate`）を使用

### 6.3 Application Performance
- **キャッシュ戦略**: 頻繁に読まれ、めったに変わらないデータには適切なキャッシュを検討
- **接続プール**: HikariCP のデフォルト設定を理解し、必要に応じて調整
- **非同期処理**: 長時間処理は `@Async` やメッセージキューで非同期化を検討
- **レスポンスサイズ**: 不要なフィールドをレスポンスに含めない。リスト系APIは必要最小限のフィールドを返す

## 7. Security Rules

### 7.1 Authentication & Authorization
- **Spring Security FilterChain**: 全エンドポイントに適切な認証・認可設定
- **@PreAuthorize / @Secured**: メソッドレベルの認可が必要な場合に使用
- **IDOR防止**: パスパラメータのIDに対して、リクエスト元ユーザーがアクセス権を持つか必ず検証

### 7.2 Data Protection
- **パスワード**: BCryptPasswordEncoder で必ずハッシュ化
- **個人情報**: レスポンスDTOで必要最小限のフィールドのみ公開
- **ログ**: パスワード、トークン、個人情報はログに出力しない（SLF4J MDC で制御）

### 7.3 API Security
- **Rate Limiting**: 公開APIにはレート制限を検討
- **CORS**: 許可するオリジンを明示的に設定（`*` は禁止）
- **CSP**: Content-Security-Policy ヘッダーを適切に設定

## Checklist

- [ ] Google Java Style Guide compliance
- [ ] Package structure follows conventions
- [ ] Naming conventions followed
- [ ] Controller contains no business logic
- [ ] Service layer properly uses @Transactional
- [ ] No SELECT * usage
- [ ] N+1 problem avoided
- [ ] Specification-based tests
- [ ] Branch coverage 75%+
- [ ] No sensitive information in error messages
- [ ] Query performance verified (indexes, no full-table scans)
- [ ] Pagination for list endpoints
- [ ] IDOR prevention (authorization check for resource access)
- [ ] No sensitive data in logs
