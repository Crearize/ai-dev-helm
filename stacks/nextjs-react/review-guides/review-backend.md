# Backend Review Guide

**Note**: Review only when server-side files have been changed (Next.js Route Handlers, Server Actions, server-only modules, or a separate Node API server such as `apps/api`).

## Required Reference Documents

1. `documents/development/development-policy.md` - Development guidelines
2. `documents/development/coding-rules/common-rules.md` - Common coding rules
3. `documents/development/coding-rules/api-design-rules.md` - API design rules
4. `documents/development/coding-rules/frontend-rules.md` - TypeScript / Next.js rules (server-side code follows the same TypeScript conventions)
5. `documents/development/error-codes.md` - Error code list

---

## Review Checklist

### 1. Input Validation at the Boundary

- [ ] Every Route Handler, Server Action, and API endpoint validates its input with a schema (e.g., zod) before use
- [ ] Body, query, params, headers, cookies, and `FormData` are all treated as untrusted (`unknown`, not cast with `as`)
- [ ] Validation failures return a 4xx with a safe message (not a thrown 500)
- [ ] Types are derived from the schema (`z.infer`), not duplicated by hand
- [ ] File uploads: size, type, and count limits enforced
- [ ] No mass assignment: request bodies / `Object.fromEntries(formData)` are not passed to the ORM `data` as-is; writable fields are listed explicitly (e.g., not `role` / `ownerId`)
- [ ] Outbound requests to user-supplied URLs use an allowlist (SSRF); redirects to user-supplied targets are validated (open redirect); user input never forms a filesystem path

### 2. Authentication and Authorization

- [ ] Authentication is checked inside each handler / action (a Server Action is a public endpoint; do not rely on the UI hiding it)
- [ ] Authorization is checked per resource, not just per route (IDOR: the caller owns or may access the record with this ID)
- [ ] Tenant / user scoping is applied in the query itself (`where: { id, ownerId }`), not by filtering afterwards
- [ ] Middleware alone is not the only guard for sensitive data
- [ ] CSRF considered for cookie-authenticated mutations (Server Actions origin checks, SameSite, tokens for Route Handlers)
- [ ] Rate limiting considered for public-facing and authentication endpoints

### 3. Error Handling

- [ ] Errors are handled in one place or through shared helpers (not ad-hoc try/catch in every handler)
- [ ] New error codes added to the error code list
- [ ] Expected errors (validation, not found, forbidden) are separated from unexpected ones
- [ ] Responses never contain stack traces, SQL, file paths, or internal IDs
- [ ] Appropriate HTTP status codes returned (no 200 with an error body)
- [ ] No swallowed errors (`catch {}` without handling or logging); promises are awaited

### 4. Database Access

- [ ] Parameterized queries or a type-safe query builder / ORM only; no SQL built with string concatenation or template literals around user input
- [ ] Raw query APIs (`$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw`, `sql.raw` and similar) are not used with user input
- [ ] N+1 avoided (`include` / join / batch fetch / DataLoader)
- [ ] Multi-step writes that must succeed together run in one transaction
- [ ] No `SELECT *` or over-fetching; only the needed columns are returned
- [ ] Pagination on list queries; queries use indexed columns
- [ ] Migrations are sequential, existing migration files are not edited, and design docs are updated
- [ ] DB client is a shared instance (no new client per request / per hot reload)

### 5. Secrets and Server-Only Code

- [ ] Server-only modules (DB, auth, secrets) import `server-only` so a Client Component import fails the build
- [ ] No secrets in `NEXT_PUBLIC_*` variables (they are inlined into the client bundle)
- [ ] Secrets come from environment variables, validated at startup, and are never committed
- [ ] Server data passed to Client Components or returned from actions contains only what the UI needs (no password hashes, tokens, internal fields)
- [ ] Server Action arguments and return values are serializable and contain no secrets

### 6. Caching and Revalidation

- [ ] Cache behavior is explicit for each fetch / data function (static, `revalidate`, tags, `no-store`)
- [ ] User-specific or authenticated responses are never cached in a shared cache
- [ ] Mutations revalidate the affected data (`revalidatePath` / `revalidateTag`) after the write succeeds
- [ ] Route Handlers that read cookies / headers are not accidentally static
- [ ] Cache keys include every input that changes the result (user, locale, tenant)

### 7. Logging

- [ ] Important business operations and failures are logged with a structured logger (no scattered `console.log`)
- [ ] Log levels appropriate (error / warn / info / debug)
- [ ] No sensitive data logged (passwords, tokens, cookies, PII, full request bodies)
- [ ] Request correlation ID included where the project has one

### 8. API Design & Performance

- [ ] Request/Response types defined; HTTP methods used correctly (GET is side-effect free)
- [ ] API versioning strategy followed (api-design-rules.md); breaking changes avoided or documented
- [ ] Response payload size appropriate (no unnecessary fields in list responses)
- [ ] Independent async calls run in parallel (`Promise.all`), not sequentially
- [ ] External calls have timeouts and error handling
- [ ] CORS whitelist explicit (no wildcard `*` in production) for a separate API server
- [ ] Long-running work is moved out of the request path

### 9. Testing

- [ ] Line coverage target 80%+ (business logic 90%+)
- [ ] Branch coverage target 75%+
- [ ] Handlers / actions tested for invalid input, unauthenticated, and unauthorized access (including another user's resource)
- [ ] Test names are descriptive; given-when-then pattern used
- [ ] Mocking limited to external dependencies (DB, external API)
- [ ] Tests independent of execution order
- [ ] Tests are based on functional requirements (specification-based), not on internal state
- [ ] Dependency vulnerabilities checked (`npm audit` / the project's `audit:prod`) when dependencies change

### 10. Static Analysis

- [ ] Type check (`tsc --noEmit`) and lint pass without warnings/errors
- [ ] No `any`, non-null assertions, or `@ts-ignore` without justification
- [ ] No unjustified new exclusions in lint configuration
