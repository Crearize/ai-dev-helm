# async

Rules in this category detect asynchronous code that compiles and runs but does not do what it reads like: a Promise object used directly as an `if` condition (always truthy, so one branch is dead) and a discarded `await` inside a loop body (iterations run strictly sequentially instead of concurrently). Adoption is per-directory: a product opts these rules in or out for the directories it wants covered, which matters for the loop rule since some pipelines intentionally serialize. Catalog categories covered: A2 (async correctness) and D2 (avoidable sequential I/O).
