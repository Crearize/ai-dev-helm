# Security Review Guide (Web Application Baseline)

**Note**: Used by the Security Engineer specialist pass when quality-check dispatches it, and by the integrated reviewer's security checklist when the change touches HTTP handling, authentication, response headers, caching, frontend assets, or dependencies. Rules and rationale: `documents/development/coding-rules/common-rules.md` section 4 "Web アプリの基本対策（S-1〜S-6）". Skip items that do not apply to the project (record "not applicable" once, e.g. no UI is served). Items covered by a Lint-assured rule in the coverage map are out of scope here.

## Review Checklist

### S-1 Production dependencies (A06)

- [ ] The production-dependency audit (`audit:prod`) result is recorded in the report, and each finding has an impact judgement (reachable or not)
- [ ] High/critical findings with a fixed version were upgraded in this change (not deferred); remaining ones are summarized in the project's single dependency-audit issue
- [ ] A new dependency introduced by the diff has no known high/critical finding

### S-2 Security headers (A05)

- [ ] CSP is `default-src 'self'` based with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; allowed origins are listed explicitly
- [ ] `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and HSTS (when served over HTTPS; check the proxy/forwarded-header setting) are set
- [ ] `X-XSS-Protection` is NOT set
- [ ] `Referrer-Policy: no-referrer` is not used together with an `Origin`-checking CSRF defense (Origin becomes `null` on non-GET/HEAD)
- [ ] An integration test through the real middleware chain asserts the headers on HTML, API, static assets, and error responses (404 / 405 / 500 / CSRF 403)

### S-3 External resources (A05)

- [ ] No external CSS, fonts, or scripts (CDN) are loaded; they are self-hosted (e.g. `@fontsource/*`)
- [ ] If an external resource is unavoidable: SRI (`integrity` + `crossorigin`) and an explicit per-host CSP entry
- [ ] Vite `assetsInlineLimit` does not turn fonts into `data:` URIs that violate `font-src 'self'`

### S-4 Authentication responses (A07)

- [ ] Login failure responses (status, body, headers, timing) are indistinguishable across wrong password, unknown user, locked, and disabled; no early return that skips password verification (use a dummy hash of the same algorithm and cost)
- [ ] Temporary / initial passwords issued by an admin expire, and the expiry is enforced on already-issued sessions (not only at login)

### S-5 Cache-Control (A05)

- [ ] Authenticated API responses default to `Cache-Control: no-store`; only revalidated resources (e.g. images with ETag) are specified individually
- [ ] The default is applied after other middleware (session renewal etc.), so a later `private` or overwrite cannot replace it
- [ ] `Pragma` / `Expires` added by a framework are not flagged

### S-6 HTTP methods (A05)

- [ ] An allowlist at the outermost layer returns 405 with an `Allow` header for unused methods (including static serving, `TRACE`, `CONNECT`); the allowlist is not narrowed to GET/POST/HEAD only
- [ ] Per-route 405 + `Allow` for methods a route does not accept; unknown routes stay 404
- [ ] Tests cover a disallowed method on a static path and an API path, and the 405 response also carries the S-2 headers
