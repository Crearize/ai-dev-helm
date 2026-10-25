# Quick Checklist

A quick-reference checklist for AI tools when working on development tasks.

## Before Starting Work (AI auto-executes)

- [ ] Create GitHub Issue with `gh issue create` (in projects that use Issues)
- [ ] Get Issue number (in projects that use Issues)
- [ ] Create branch: `git checkout -b [type]/[description]-[issue-number]`

## Before Starting (Required)

- [ ] Branch confirmed (not on main)
- [ ] Issue number obtained (in projects that use Issues)
- [ ] Branch created with correct naming

## During Implementation (Important)

- [ ] Coding conventions followed
- [ ] Tests implemented
- [ ] Error codes added (if new)
- [ ] **Feature documentation created or updated** (via /feature-documentation)
  - When adding a new feature/service, requirement, prerequisite, or behavior change
  - Existing doc -> update; no doc yet -> create under `documents/` or `docs/`

## Before Merge (Required - via /quality-check)

> Run /quality-check before `gh pr merge`, `git merge` on main, or a direct push to main; feature-branch pushes are not gated. The rules themselves (flow, harness-only exemption, review roster, severity, round limit, speed mode, completion criteria, the hook's complete contract) live in the quality-check skill, and the numbers in `documents/development/quality-policy.md`; the items below only name them.
> 適用されるゲートの**強度**（要否）はリスクレベルで決まる（`documents/development/quality-policy.md` §2）。ゲートの列挙と実行条件は quality-check スキルを正とし、本チェックリストは項目名の一覧である。

### Static Checks
- [ ] **Backend quality check passed** (linting + static analysis + tests + coverage + build)
- [ ] **Frontend static check passed** (lint + format + build)

### Unit Tests
- [ ] **Frontend tests passed**

### Review Cycles (the quality-check skill's Step 1 "レビュー体制の決定" and Step 4)
- [ ] **Review roster completed** (chosen by the change content; mechanical checks pass before reviewers run)
- [ ] **Completion criteria met** (the quality-check skill's "完了条件")
- [ ] **Speed mode only** (the user said 「スピード優先」): the quality-check skill's "スピード優先モード" followed
- [ ] **Report data saved** (`.quality-check-report.json`)

### Additional Tests (Step 5)
- [ ] **Additional tests judged and recorded** (the test-recommendation skill: what runs without asking, what is asked in the final report, and the ledger)
- [ ] **Ledger and Step 5 artifacts committed before the flag** (`documents/development/test-recommendation-ledger.md`)

### Final Confirmation
- [ ] **Deviations from the design recorded before the flag** (spec `## 実装時の差異` / plan / working note)
- [ ] **Final message**: completion / deviations from the design / decisions needed only (`documents/development/development-policy.md` §1.0)
- [ ] Related documentation consistency verified
- [ ] (Optional) Self-improvement candidates noted (not a completion condition)
- [ ] PR created (with /implementation-report, closes #[issue-number])

## Documentation Update Checks

- [ ] **Feature/service added or changed -> Run /feature-documentation** (create or update)
- [ ] **Project prerequisites/requirements changed -> Run /feature-documentation**
- [ ] New error codes -> Add to error code list
- [ ] DB design changes -> Reflect in related documents
