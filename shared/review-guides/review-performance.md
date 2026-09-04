# Performance Review Guide

**Note**: Used by the Performance Engineer specialist pass when quality-check dispatches it (the change touches queries, collection loops, caching, bundles, or hot paths and no higher-priority specialist applies - quality-check Step 1 review roster), and by the integrated reviewer's performance checklist in every cycle.

## Required Reference Documents

1. `documents/development/development-policy.md` - Development guidelines

---

## Review Checklist

### 1. Algorithmic Complexity

- [ ] No accidental O(n^2) or worse in loops over collections (nested loops, repeated `includes`/`indexOf` scans)
- [ ] Expensive computations are not repeated inside loops when they can be hoisted or precomputed
- [ ] Appropriate data structures used (Map/Set for lookups instead of arrays)
- [ ] Recursion has bounded depth or is converted to iteration where input size is unbounded

### 2. Database / Query Performance

- [ ] No N+1 query patterns (queries inside loops, lazy-loading in iterations)
- [ ] Queries fetch only needed columns/rows (no `SELECT *` on wide tables, pagination for unbounded result sets)
- [ ] New query patterns are covered by existing indexes, or new indexes are added and documented
- [ ] Bulk operations use batch APIs instead of per-row round trips
- [ ] Transactions are kept short; no external I/O inside transactions

### 3. Network / API Efficiency

- [ ] No redundant API calls (same data fetched multiple times per request/render)
- [ ] Response payloads are appropriately sized (no over-fetching of nested resources)
- [ ] Parallelizable independent calls are not serialized
- [ ] Appropriate timeouts and retry policies for external calls

### 4. Caching

- [ ] Cacheable expensive computations or fetches are cached where the project has a caching layer
- [ ] Cache keys include all inputs that affect the result
- [ ] Cache invalidation is handled when underlying data changes
- [ ] No unbounded in-memory caches (size limits or TTL present)

### 5. Frontend Performance (if applicable)

- [ ] No unnecessary re-renders (stable references for props/deps, memoization where measured to matter)
- [ ] Bundle size impact of new dependencies considered (no heavyweight library for a trivial utility)
- [ ] Large lists are virtualized or paginated
- [ ] Images/assets are appropriately sized and lazy-loaded

### 6. Memory / Resource Efficiency

- [ ] No unbounded growth of arrays, maps, queues, or listeners
- [ ] Resources (connections, file handles, subscriptions, timers) are released on completion or error paths
- [ ] Large objects are not retained longer than needed (closures, module-level state)

### 7. Scalability

- [ ] Behavior is acceptable when data volume grows 10x-100x (no full-table scans, no loading entire datasets into memory)
- [ ] Hot paths avoid locks or shared mutable state that would serialize concurrent requests
- [ ] Background/batch work does not starve interactive requests

### 8. Verifying a Fix

- [ ] The fix is measured with the reviewer's exact reproduction input AND with the worst-case shape the finding describes (an input that actually exercises the path in question)
- [ ] Measured numbers are recorded with the review result, not just "faster"
