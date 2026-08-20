# security

Rules in this category flag a few specific, high-confidence security-sensitive
constructs. Adoption is per-directory: a product opts these rules in or out for
the directories it wants covered, so a build-script directory can be treated
differently from request-handling code. Each rule ships as `-ts`, `-tsx` and
`-js` variants (and a `-java` variant where relevant) so `.ts`, `.tsx`, `.js`,
`.jsx` and `.java` files are all actually scanned - ast-grep binds one grammar
per file extension, so a `TypeScript`-only rule silently skips `.tsx`/`.js`.

## Coverage of catalog B2 is PARTIAL

B2 (security-sensitive constructs) is a broad catalog category. These rules
cover only the items listed under "Covered" below. Everything under "Not
covered" is NOT detected here and stays assigned to AI review in the coverage
map.

**Covered (B2):**
- Dynamic code execution - `eval(...)`, `new Function(...)`, a bare
  `Function(...)` call, and `setTimeout`/`setInterval` with a string or
  template-literal first argument (`no-eval-*`).
- Broken hashing / MAC / signature / cipher primitives - MD5 & SHA-1 via
  `createHash`/`createHmac`/`crypto.hash` (JS/TS) and via
  `MessageDigest.getInstance`, `Mac.getInstance`, `Signature.getInstance`
  (SHA-1/MD5), plus DES/ECB via `Cipher.getInstance` (Java) (`no-weak-hash-*`).
- TLS certificate verification turned off - `rejectUnauthorized: false`/`0`
  (identifier, quoted, or computed key) and
  `NODE_TLS_REJECT_UNAUTHORIZED = '0'` (`no-tls-verify-off-*`).
- Shell command injection - a command assembled by string interpolation or
  concatenation and passed to the `exec`/`execFile`/`spawn` family
  (`no-exec-string-interp-*`).

**Not covered (B2) - stays with AI review:**
- SQL/NoSQL injection (string-built queries).
- XSS sinks - `dangerouslySetInnerHTML`, `innerHTML`, `document.write`.
- Path traversal, SSRF, open redirects.
- Insecure deserialization, unsafe YAML/XML parsing (XXE).
- Permissive CORS (`Access-Control-Allow-Origin: *` with credentials), missing
  auth checks, ReDoS.
- Hardcoded secrets / API keys / credentials.
- Weak-hash or eval where the algorithm/target is held in a variable, and the
  eval indirection forms `(0, eval)(x)` / `globalThis.eval`.
- `spawn('sh', ['-c', <interp>])` (interpolation in an args-array element) and
  the `{ shell: true }` option correlation.
- TLS disabled through a value read from configuration rather than a literal.

Do NOT list this directory as full coverage of B2 in a review guide; the
uncovered items above stay assigned to AI review in the coverage map.
