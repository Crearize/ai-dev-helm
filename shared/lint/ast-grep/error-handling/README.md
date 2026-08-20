# error-handling

Rules in this category detect places where a failure is caught and then lost.
Both shapes below turn a real failure into a silent one, so the caller sees
success and the incident surfaces much later somewhere unrelated. Adoption is
per-directory: a product opts these rules in or out for the directories it wants
covered, so legacy areas can stay excluded while new code is held to them. Each
rule ships as `-ts`, `-tsx` and `-js` variants (plus `-java` for empty catch) so
`.ts`, `.tsx`, `.js`, `.jsx` and `.java` files are all actually scanned.

## Coverage of catalog A3 is PARTIAL

**Covered (A3 - swallowed errors):**
- An empty catch block - including a body that is only a comment, a bare `;`,
  `null;`, `undefined;`, or `void 0;` (`no-empty-catch-ts` / `-tsx` / `-js` /
  `no-empty-catch-java`).
- A catch whose entire body is a single `console.*` call, i.e. logged and then
  swallowed (`no-catch-log-only-*`).

**Not covered (A3) - stays with AI review:**
- A catch that "handles" the error by returning `undefined` / a default and
  hiding the failure with real-looking code.
- Over-broad catch types, or a rethrow that drops the original cause.
- Swallowing via `promise.catch(() => {})` or an ignored rejected promise.
- A catch that logs through a real logger (not `console`) and then swallows -
  only the `console.*`-only shape is matched, to stay false-positive-safe.

Do NOT list this directory as full coverage of A3 in a review guide; the
uncovered items above stay assigned to AI review in the coverage map.
