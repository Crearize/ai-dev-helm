# Requirements Consistency Review Guide

**Note**: Used by the Requirements Consistency Reviewer specialist pass when quality-check dispatches it (a feature-level diff with an Issue, spec or design document and no higher-priority specialist applies - quality-check Step 1 review roster), and by the integrated reviewer's requirements-alignment checklist in every cycle. Verifies that the implementation builds the right thing, not just that it is built right.

## Required Reference Documents

1. The GitHub Issue linked to the current branch (branch name contains the issue number)
2. Related requirement / design documents under `documents/`
3. `documents/development/development-policy.md` - Development guidelines

---

## Review Checklist

### 1. Issue Alignment

- [ ] The change implements what the linked Issue asks for
- [ ] All items listed in the Issue are addressed, or explicitly deferred with a reason
- [ ] The change does not silently expand beyond the Issue scope

### 2. Acceptance Criteria

- [ ] Each acceptance criterion (if defined) is verifiably met by the implementation
- [ ] Tests exist that demonstrate the acceptance criteria
- [ ] Edge conditions mentioned in requirements are handled

### 3. Design Document Alignment

- [ ] Implementation follows the agreed design (architecture, data model, API contracts)
- [ ] Deviations from the design are justified and documented
- [ ] API request/response shapes match the spec (field names, types, optionality, error formats)

### 4. Domain Terminology

- [ ] Names in code (classes, fields, endpoints, DB columns) match the domain terms used in requirements
- [ ] No conflicting or ambiguous synonyms introduced for existing concepts
- [ ] New terms are added to the naming conventions / glossary if the project maintains one

### 5. Over-Implementation

- [ ] No features, options, or configuration added that no requirement asks for
- [ ] No speculative abstractions or extension points without a concrete need
- [ ] No premature generalization of single-use code

### 6. Under-Implementation

- [ ] No requirement silently dropped or stubbed out
- [ ] Error cases and non-happy paths required by the spec are implemented
- [ ] Migration/compatibility requirements (if any) are fulfilled

### 7. Documentation Divergence

- [ ] Feature documents under `documents/` reflect the implemented behavior
- [ ] README / setup instructions still accurate after the change
- [ ] Error code list updated when new error codes are introduced
- [ ] Changed public interfaces are reflected in API specs
