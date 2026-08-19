# Development Guidelines

Development policies, standards, and processes for this project.

## 1. AI-Driven Development

### 1.1 Basic Principles
- **AI as primary developer**: Code development and review driven by AI tools
- **Human role**: Requirements definition, design decisions, final review
- **Prompt-based**: Development instructions communicated via clear prompts

### 1.2 Development Flow

#### Branch Verification Before Work
Before all development and documentation work:

1. **Check current branch**: `git branch --show-current`
2. **If on main**: Create a new branch before starting
3. **If on another branch**: Verify it matches the task

```
Branch check → Prompt instructions → AI implementation → PR creation → AI review → Human review → Merge
```

### 1.3 Configuration File Role
- CLAUDE.md / .cursorrules: Initial configuration file loaded by AI tools
- Contains project overview and development guideline references

### 1.4 Prompt Best Practices
- **Clear requirements**: What to build, expected behavior
- **Specific instructions**: Technologies, patterns, constraints
- **Expected results**: Completion criteria, output format, error handling
- **Incremental steps**: Break complex features into small steps

## 2. Architecture

### 2.1 Project Structure

Organize your project with clear separation of concerns:

```
project/
├── backend/               # API server
│   ├── src/main/          # Source code
│   ├── src/test/          # Test code
│   └── src/main/resources/# Configuration, migrations
├── frontend/              # Web application(s)
│   ├── apps/              # Application(s)
│   └── packages/          # Shared packages (utilities only)
├── documents/             # Project documentation
├── .github/               # CI/CD configuration
└── CLAUDE.md              # AI configuration
```

## 3. Development Environment Setup

### Prerequisites
- Language runtime (Java, Node.js, Python, etc.)
- Package manager
- Docker (for databases and services)
- Database

## 4. Development Workflow

### Feature Development Flow
1. **Check current branch** (`git branch --show-current`)
2. **Create new branch if on main**
3. Specify requirements and approach via prompts
4. Implement with AI tools
5. Write tests alongside implementation
6. Local verification
7. Create PR

## 5. Branch Strategy (GitHub Flow)

### Basic Rules

#### Pre-Work Verification (Required)
1. **Check current branch**: `git branch --show-current`
2. **If on main**: Direct work prohibited. Create new branch.
3. **If on other branch**: Verify branch name matches task.

#### Branch Naming
```
feature/[feature-name]     # New feature
fix/[bug-description]      # Bug fix
docs/[document-name]       # Documentation
refactor/[target]          # Refactoring
test/[test-target]         # Test additions/fixes
```

### PR Creation and Review
1. Meaningful commit units
2. Follow PR template
3. Automated review (if configured)
4. Human final review
5. Merge to main

## 6. API Design (RESTful)

### Endpoint Conventions
```
GET    /api/v1/resources          # List resources
GET    /api/v1/resources/{id}     # Get single resource
POST   /api/v1/resources          # Create resource
PUT    /api/v1/resources/{id}     # Full update
PATCH  /api/v1/resources/{id}     # Partial update
DELETE /api/v1/resources/{id}     # Delete resource
```

### Response Format
- **Format**: JSON
- **Content-Type**: `application/json`

## 7. Error Handling

### Error Response Format
```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource not found",
    "details": {}
  },
  "timestamp": "2025-01-08T10:00:00Z"
}
```

### HTTP Status Codes
- **200 OK**: Success
- **201 Created**: Resource created
- **204 No Content**: Deletion success
- **400 Bad Request**: Validation error
- **401 Unauthorized**: Authentication error
- **403 Forbidden**: Authorization error
- **404 Not Found**: Resource not found
- **409 Conflict**: Conflict (duplicate, etc.)
- **500 Internal Server Error**: System error

## 8. Logging

### Log Levels
- **ERROR**: System errors, unexpected exceptions
- **WARN**: Recoverable errors, retry operations
- **INFO**: Important business events
- **DEBUG**: Debug information (dev/staging only)

### Sensitive Information
- Never log passwords, API keys, or tokens
- Mask personal information when necessary
- Never log credit card numbers

## 9. Testing Strategy

### Coverage Targets

> カバレッジ目標は**下限**であり、テスト十分性の**証明ではない**。テスト層の選択（Failure Mode 起点）とテストオラクル（期待値の根拠）の原則は `quality-policy.md` §3 / §4 を参照。

- Overall: 80%+
- Business logic (Service layer): 90%+
- Utilities: 100%

### Test Types
- **Unit tests**: Individual component testing with mocks
- **Integration tests**: Component interaction testing
- **API tests**: Endpoint testing
- **E2E tests**: Full workflow testing

## 10. Checklist

### Before Starting Work
- [ ] Check current branch
- [ ] Create new branch if on main
- [ ] Branch name matches task

### During Development
- [ ] Documentation updated (if needed)
- [ ] Test code written
- [ ] Error handling implemented
- [ ] Logging implemented

### PR Creation
- [ ] Commit messages follow conventions
- [ ] All tests pass
- [ ] Coverage targets met
- [ ] Review points documented
