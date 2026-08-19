# Backend Review Guide

**Note**: Review only when backend files have been changed.

## Required Reference Documents

1. `documents/development/development-policy.md` - Development guidelines
2. `documents/development/coding-rules/backend-rules.md` - Backend coding rules
3. `documents/development/coding-rules/common-rules.md` - Common coding rules
4. `documents/development/error-codes.md` - Error code list
5. `documents/development/coding-rules/api-design-rules.md` - API design rules

---

## Review Checklist

### 1. Pre-Implementation Verification

#### Logging
- [ ] Understanding of AOP-based automatic logging (request/response logging, SQL logging, MDC filter)
- [ ] No duplicate log output (manual logging of auto-logged content)

#### Exception Handling
- [ ] Using centralized ExceptionHandler (`@RestControllerAdvice`)
- [ ] Try-Catch used appropriately (basically unnecessary, only for special cases)

#### Utility Classes
- [ ] Checking existing utility packages before writing new code
- [ ] DRY principle followed (no wheel reinvention)

### 2. Coding Conventions (Google Java Style Guide)

- [ ] Package structure follows conventions (no unnecessary layers like service/impl)
- [ ] Naming conventions followed (classes, methods, variables)
- [ ] No wildcard imports
- [ ] No full package names (use import statements for short names)
- [ ] Lombok annotations used appropriately

### 3. Spring Boot Conventions

- [ ] `@RestController` / `@Service` / `@Repository` used appropriately
- [ ] Constructor injection (`@RequiredArgsConstructor`)
- [ ] `@Transactional` used appropriately (readOnly for reads)
- [ ] Business logic aggregated in Service layer (not in Controller)
- [ ] `RestClient` used (not deprecated `RestTemplate`)
- [ ] `@ConfigurationProperties` for type-safe configuration binding
- [ ] Bean Validation (`@Valid`, `@NotNull`, etc.) used appropriately

### 4. ORM / Query Builder Conventions

- [ ] Type-safe queries used
- [ ] No `SELECT *` (specify columns explicitly)
- [ ] N+1 problem avoided (JOIN or batch fetch)
- [ ] Transaction boundaries appropriate

### 5. Database Migration

- [ ] Version numbers sequential and appropriate
- [ ] No existing migration files modified
- [ ] Database design changes reflected in documentation

### 6. Error Handling

- [ ] New error codes added to error code list
- [ ] Business exceptions vs system exceptions properly separated
- [ ] Error messages don't contain sensitive information
- [ ] Appropriate HTTP status codes returned

### 7. Logging

- [ ] No duplicate logging of auto-logged content
- [ ] Important business operations properly logged
- [ ] Log levels (ERROR/WARN/INFO/DEBUG) appropriate
- [ ] Structured logging format used

### 8. Security

- [ ] Sensitive information handled properly
- [ ] SQL injection prevention (parameterized queries)
- [ ] Environment variables for secret management
- [ ] Security filter chain properly configured
- [ ] CORS settings appropriate
- [ ] JWT verification properly implemented
- [ ] IDOR vulnerability check (authorization verified for all resource access by ID)
- [ ] Rate limiting considered for public-facing endpoints
- [ ] CORS whitelist explicit (no wildcard `*` in production)
- [ ] No sensitive data logged (passwords, tokens, PII)
- [ ] Dependency vulnerability check considered (OWASP dependency-check / Snyk / Gradle dependencyCheck)

### 9. Testing

- [ ] Line coverage target 80%+ (business logic 90%+)
- [ ] Branch coverage target 75%+
- [ ] Test method names are descriptive
- [ ] given-when-then pattern used
- [ ] Mocking used appropriately (external dependencies only)

### 10. API Design & Performance

- [ ] API documentation annotations appropriate
- [ ] Request/Response DTOs properly defined
- [ ] HTTP methods used correctly (GET/POST/PUT/DELETE)
- [ ] API versioning strategy followed (api-design-rules.md)
- [ ] Breaking changes avoided (or explicitly documented with versioning)
- [ ] Response payload size appropriate (no unnecessary fields in list APIs)
- [ ] Pagination implemented for all list endpoints
- [ ] Query complexity appropriate (no unindexed full-table scans)
- [ ] Batch operations used for bulk data processing
- [ ] Connection pool settings appropriate for expected load

### 11. Static Analysis

- [ ] Build check passes without warnings/errors
- [ ] No new linting warnings in new code
- [ ] No unjustified new exclusions in filter configurations

### 12. Specification-Based Testing

- [ ] Tests based on functional requirements, not internal state
- [ ] No direct testing of private methods or cache internals
- [ ] Mock targets limited to external dependencies (DB, external API)
- [ ] Tests independent of execution order
