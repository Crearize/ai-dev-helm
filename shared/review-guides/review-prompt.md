# Integrated Review Instructions

## Review Policy

Check the files changed in this PR and review only the applicable areas:
- Document changes (documents/**, *.md) -> Refer to `.github/review-docs.md`
- Backend changes (backend/**) -> Refer to `.github/review-backend.md`
- Frontend changes (frontend/**) -> Refer to `.github/review-frontend.md`
- Infra/CI changes (.github/workflows/**, Dockerfile, etc.) -> Refer to `.github/review-infra.md`
- Performance-sensitive changes (queries, loops over collections, bundle-affecting frontend changes) -> Also refer to `.github/review-performance.md`
- Any code change tied to an Issue/requirement -> Also refer to `.github/review-requirements.md`

Skip areas with no changes and do not output those sections.
Each review should be a separate section with clear headings.

---

## Common Steps (All Areas)

### Step 1: Check Previous Reviews (Prevent Duplicate Feedback)

**Critical: To avoid repeating already-addressed issues:**

1. Check all previous review comments on this PR
2. Do not re-raise items already marked as resolved
3. Only review new changes or unaddressed items
4. For synchronize events (additional pushes), focus on diff since last review

### Step 2: Understand Changes

Review the changed files and understand:
- Intent of changes (new feature, bug fix, refactoring, etc.)
- Impact scope (which modules/layers affected)
- Related existing implementations

### Step 3: Area-Specific Review

Read the relevant area review file and follow its instructions.

### Step 4: Self-Verification (Before Output)

**Before outputting review results, verify:**

1. **Evidence**: Does each finding reference specific conventions or documentation?
2. **Fact-check**: Is the issue actually present in the code? No speculation?
3. **Duplicate check**: Not repeating existing PR comments?
4. **Priority check**: Are "must-fix" items truly bugs, security issues, or rule violations?
5. **Specificity**: Do all "must-fix" items include concrete code examples?
6. **Side effects**: Could proposed fixes affect other functionality?

---

## Output Format

### Review Completion Criteria

Output "Review complete. No issues." ONLY when ALL of:
- Coding conventions compliant
- No security concerns
- Documentation consistent
- No performance concerns

### Feedback Format

**Important: Do NOT output items that passed review. Only output items with findings.**

#### Must-Fix (Priority: High)
Problem description with specific fix and code example.

#### Recommended Improvements (Priority: Medium)
Better implementation suggestions.

#### Minor Suggestions (Priority: Low)
Typos, comment improvements, etc.

#### Good Points
Actively commend good implementations.

### Bug Report Rules

When reporting potential bugs:
1. Clearly describe the symptom
2. Identify root cause with code evidence
3. Show reproduction conditions
4. Provide fix proposal with reasoning

---

## Common Notes

- Provide specific, constructive feedback
- Reference relevant documentation sections
- Do not repeat the same feedback
- Review from design and architecture perspectives, not just surface-level
- Do NOT output items that passed review (critical)
