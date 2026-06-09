# Quick Checklist

A quick-reference checklist for AI tools when working on development tasks.

## Before Starting Work (AI auto-executes)

- [ ] Create GitHub Issue with `gh issue create`
- [ ] Get Issue number
- [ ] Create branch: `git checkout -b [type]/[description]-[issue-number]`

## Before Starting (Required)

- [ ] Branch confirmed (not on main)
- [ ] Issue number obtained
- [ ] Branch created with correct naming

## During Implementation (Important)

- [ ] Coding conventions followed
- [ ] Tests implemented
- [ ] Error codes added (if new)
- [ ] **Feature documentation created or updated** (via /feature-documentation)
  - When adding a new feature/service, requirement, prerequisite, or behavior change
  - Existing doc -> update; no doc yet -> create under `documents/` or `docs/`

## Before Push (Required - via /quality-check)

### Static Checks
- [ ] **Backend quality check passed** (linting + static analysis + tests + coverage + build)
- [ ] **Frontend static check passed** (lint + format + build)

### Unit Tests
- [ ] **Frontend tests passed**

### Review Cycles (minimum 2 cycles)
- [ ] **Multi-persona review completed** (Security / Architect / QA / Integration / Performance / Requirements)
- [ ] **Must-fix items (Priority: High) = 0**
- [ ] **Report data saved** (`.quality-check-report.json`)

### E2E Tests (Final Verification)
- [ ] **E2E tests passed**

### Final Confirmation
- [ ] Related documentation consistency verified
- [ ] **Self-improvement candidates reviewed** (applied / skipped / not required)
- [ ] PR created (with /implementation-report, closes #[issue-number])

## Documentation Update Checks

- [ ] **Feature/service added or changed -> Run /feature-documentation** (create or update)
- [ ] **Project prerequisites/requirements changed -> Run /feature-documentation**
- [ ] New error codes -> Add to error code list
- [ ] DB design changes -> Reflect in related documents
