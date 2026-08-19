# test-quality

Rules in this category detect tests that report green without proving anything: a focused test (`describe.only` / `it.only` / `test.only`), which silently disables every other test in its file, and a tautological assertion such as `expect(true).toBe(true)`, which passes regardless of the code under test. Both make a suite look healthier than it is. Adoption is per-directory: a product opts these rules in or out for the directories it wants covered, normally the test directories only. Catalog categories covered: E1 (meaningless assertions) and E2 (disabled or focused tests).
