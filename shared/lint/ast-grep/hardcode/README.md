# hardcode

Rules in this category detect environment-specific values baked into source.
Such a value works in the environment it was written for and silently breaks
elsewhere, and it cannot be rotated without a code change. Adoption is
per-directory: a product opts these rules in or out for the directories it wants
covered, so fixture and infrastructure-sample directories can stay excluded.
Each rule ships as `-ts`, `-tsx` and `-js` variants so `.ts`, `.tsx`, `.js` and
`.jsx` files are all actually scanned.

## Coverage of catalog C6 is PARTIAL

**Covered (C6 - hardcoded environment values):**
- An IPv4 address baked into source, matched by CONTEXT rather than by value to
  avoid flagging version strings like `"1.2.3.4"`: the whole literal is a
  PRIVATE-range IPv4 (10/8, 192.168/16, 172.16/12), or an IPv4 host appears in
  a URL / DSN such as `postgres://u:p@10.0.0.1/db` or `http://8.8.8.8/`
  (`no-hardcoded-ip-*`).

**Not covered (C6) - stays with AI review:**
- Hardcoded hostnames, full URLs, ports, and file-system paths.
- Hardcoded secrets, API keys, and tokens.
- A bare PUBLIC IPv4 assigned to a plain constant (e.g. `const x = '8.8.8.8'`)
  with no URL/DSN context - the deliberate trade-off that keeps version strings
  like `"1.2.3.4"` from being flagged.
- IPv6 addresses, and any other environment-specific magic value.

Do NOT list this directory as full coverage of C6 in a review guide; the
uncovered items above stay assigned to AI review in the coverage map.
