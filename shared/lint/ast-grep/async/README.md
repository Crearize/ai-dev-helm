# async

Rules in this category detect asynchronous code that compiles and runs but does
not do what it reads like. Adoption is per-directory: a product opts these rules
in or out for the directories it wants covered, which matters for the loop rule
since some pipelines intentionally serialize. Each rule ships as `-ts`/`-tsx`
(and `-js` where the construct is common in plain JavaScript) so `.ts`, `.tsx`,
`.js` and `.jsx` files are all actually scanned.

## Coverage of catalog A2 and D2 is PARTIAL

These rules cover only the specific shapes listed below.

**Covered (A2 - async correctness):**
- A Promise combinator (`Promise.all/any/race/resolve/allSettled`) used
  directly as an `if` condition, which is always truthy so one branch is dead
  (`no-promise-in-condition-*`).

**Covered (D2 - avoidable sequential I/O):**
- A discarded `await` statement directly inside a `for` / `for-of` / `for-in` /
  `while` / `do-while` loop body, i.e. iterations that run strictly
  sequentially (`no-await-in-loop-*`).

**Not covered - stays with AI review:**
- A2: floating / unhandled promises, a missing `await` on a returned promise,
  forgotten `.catch`, promise combinators used in other truthiness contexts
  (`while`, ternary, `&&`/`||`), and genuine race conditions.
- D2: sequential awaits spread across separate statements or an async
  `.reduce`/`for await` chain, and awaits whose result is bound to a variable
  (left alone deliberately, since that is often a real data dependency).

Do NOT list this directory as full coverage of A2 or D2 in a review guide; the
uncovered items above stay assigned to AI review in the coverage map.
