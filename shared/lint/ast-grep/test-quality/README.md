# test-quality

Rules in this category detect tests that report green without proving anything.
Both shapes below make a suite look healthier than it is. Adoption is
per-directory: a product opts these rules in or out for the directories it wants
covered, normally the test directories only. Each rule ships as `-ts`, `-tsx`
and `-js` variants so `.ts`, `.tsx`, `.js` and `.jsx` test files are all
actually scanned.

## Coverage of catalog E1 and E2 is PARTIAL

**Covered (E1 - meaningless assertions):**
- A tautological assertion `expect(<literal>).toBe(<same literal>)` (boolean or
  number), which passes regardless of the code under test
  (`no-trivial-assert-*`).

**Covered (E2 - disabled or focused tests):**
- A focused test - `describe.only` / `it.only` / `test.only`, the Jasmine/Jest
  aliases `fit` / `fdescribe`, and the parameterised `*.only.each(...)` form -
  which silently disables every other test in the file (`no-focused-test-*`).

**Not covered - stays with AI review:**
- E1: a test with no `expect` at all, an `expect` with no matcher, a
  snapshot-only test, or an always-true custom assertion helper.
- E2: a SKIPPED test (`.skip`, `xit`, `xdescribe`, `it.skip`), an empty test
  body, a test disabled behind a condition, and the tagged-template
  `it.only.each\`...\`` spelling.

Do NOT list this directory as full coverage of E1 or E2 in a review guide; the
uncovered items above stay assigned to AI review in the coverage map.
