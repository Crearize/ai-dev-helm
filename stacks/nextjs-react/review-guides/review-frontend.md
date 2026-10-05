# Frontend Review Guide

**Note**: Review only when frontend files have been changed.

## Required Reference Documents

1. `documents/development/development-policy.md` - Development guidelines
2. `documents/development/coding-rules/frontend-rules.md` - Frontend coding rules
3. `documents/development/coding-rules/common-rules.md` - Common coding rules

---

## Review Checklist

### 1. TypeScript Conventions

- [ ] TypeScript strict mode - no errors
- [ ] No `any` type usage (use `unknown`)
- [ ] Naming conventions followed (PascalCase: components/types, camelCase: variables/functions)
- [ ] 1 file = 1 component (no multiple components in same file)
- [ ] Export at definition (`export const ComponentName = ...`)
- [ ] Proper type definitions (interface vs type usage)

### 2. Next.js App Router

- [ ] Server/Client Component properly selected
- [ ] `'use client'` directive correctly applied where needed
- [ ] Directory structure follows conventions
- [ ] `loading.tsx` / `error.tsx` / `not-found.tsx` implemented where needed
- [ ] `generateMetadata` for SEO (if applicable)
- [ ] `'use server'` properly placed for Server Actions
- [ ] Route Handlers (`app/api/`) properly implemented
- [ ] `next/image` for image optimization
- [ ] Dynamic Import (`next/dynamic`) used where appropriate

### 3. React Conventions

- [ ] Hooks called at top level only (no conditional calls)
- [ ] Custom hooks use `use` prefix
- [ ] Dependency arrays accurately specified
- [ ] React.forwardRef not used (receive ref via props)
- [ ] `useTransition` / `useDeferredValue` for heavy operations
- [ ] Suspense boundaries properly placed

### 4. State Management (TanStack React Query)

- [ ] `queryKey` managed with factory pattern
- [ ] `staleTime` / `gcTime` properly configured
- [ ] `useMutation` error handling implemented
- [ ] Optimistic updates used where appropriate
- [ ] `enabled` option prevents unnecessary queries
- [ ] `invalidateQueries` properly configured

### 5. UI Library Conventions

- [ ] UI library components considered before creating new ones
- [ ] `sx` prop used for styling (preferred over styled-components)
- [ ] Theme customization is consistent
- [ ] Latest component variants used

### 6. Form Implementation (React Hook Form + Zod)

- [ ] Forms use React Hook Form with Zod
- [ ] Zod schema type safety ensured
- [ ] Validation messages are user-friendly
- [ ] Error handling implemented
- [ ] Default values properly set
- [ ] `zodResolver` used

### 7. Performance

- [ ] No unnecessary re-renders (React DevTools Profiler verified if complex)
- [ ] Bundle size impact considered (dynamic import for heavy components)
- [ ] tree-shaking friendly imports
- [ ] Unused code removed
- [ ] Pagination or virtual scroll for large data sets
- [ ] Images use next/image with proper sizing
- [ ] staleTime/gcTime configured appropriately for queries

### 8. Security

- [ ] Public env vars use proper prefix (e.g., `NEXT_PUBLIC_`)
- [ ] XSS protection (output escaping)
- [ ] No sensitive data leaked to client-side
- [ ] No API keys or secrets hardcoded
- [ ] Server Actions and Route Handlers check authentication and per-resource authorization inside the handler (a Server Action is a public endpoint; middleware alone is not the guard)
- [ ] Server-only modules import `server-only` so a Client Component import fails the build

### 9. Testing

- [ ] Component tests implemented
- [ ] Tests contain meaningful assertions
- [ ] Mocking used appropriately (external dependencies only)
- [ ] Edge cases tested

### 10. Async Processing

- [ ] async/await preferred (avoid Promise chains `.then()`)
- [ ] Independent async operations use `Promise.all`
- [ ] Error handling (try-catch + appropriate UI)
- [ ] No unnecessary `await` on synchronous operations

### 11. Specification-Based Testing

- [ ] Tests based on functional requirements, not internal state
- [ ] No direct testing of useState or internal state
- [ ] Testing Library role-based selectors preferred (`getByRole` > `getByTestId`)
- [ ] Mock targets limited to external dependencies (API, browser API)
- [ ] Tests independent of execution order

### 12. Accessibility

- [ ] Semantic HTML elements used (nav, main, section, article, aside)
- [ ] Interactive elements keyboard accessible (Tab/Enter/Escape)
- [ ] ARIA attributes used where semantic HTML is insufficient
- [ ] Color contrast ratio meets WCAG 2.1 AA (4.5:1 for text, 3:1 for large text)
- [ ] Form inputs have associated labels (htmlFor or aria-label)
- [ ] Focus management appropriate (modal focus trap, skip links if needed)
- [ ] alt text provided for meaningful images (decorative images use alt="")
