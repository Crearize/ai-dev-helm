# error-handling

Rules in this category detect places where a failure is caught and then lost: an empty catch block (including a comment-only body) and a catch whose whole body is a single `console.*` call. Both shapes turn a real failure into a silent one, so the caller sees success and the incident surfaces much later somewhere unrelated. Adoption is per-directory: a product opts these rules in or out for the directories it wants covered, so legacy areas can stay excluded while new code is held to them. Catalog categories covered: A3 (error handling / swallowed errors).
