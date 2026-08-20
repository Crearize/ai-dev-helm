# Frontend Coding Rules (Detailed)

> **Tech Stack**: Next.js + React + TypeScript

> 本書は Next.js + React + TypeScript の**詳細規約**である。言語・FW 非依存の汎用原則は `documents/development/coding-rules/common-rules.md` を正とし、Lint で担保可能な項目の**恒久の正**はカタログ（`documents/development/static-check-standard.md`）A1〜F2 とする。
> 本書には汎用ルールの言語固有表現が重複して残っている（移行形）。`> Catalog:` 注記の読み方は common-rules.md「Catalog 注記の読み方」を参照。**スタック別文書の項目は削除せず**、対応する Lint 資産の提供後に「項目名 + カタログ番号 + Lint 資産参照」の形式へ縮約する（カタログ §4.1）。
> 要点版のルールは `.claude/rules/frontend/coding.md`（配布後の AI ツール別ルール）を参照。パスはすべて配布後のプロダクト側表記（対応表はカタログ §5）。

## Basic Policy

- TypeScript strict mode required
- UI library components preferred over custom implementations
- Specification-based testing

## 1. TypeScript Conventions

### 1.1 Type Safety

- **any type prohibited**: Use `unknown` type
- **Explicit type annotations** for function return types and parameters
- **strict mode required**: `"strict": true` in tsconfig.json

```typescript
// NG
function process(data: any) { ... }

// OK
function process(data: unknown) { ... }
```

### 1.2 interface vs type

- **Object types**: Use `interface` (extensible)
- **Union/intersection/primitive aliases**: Use `type`

```typescript
// Object type -> interface
interface StudentResponse {
  id: string;
  name: string;
  email: string;
}

// Union type -> type
type CourseStatus = 'active' | 'completed' | 'cancelled';
```

### 1.3 Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Component | PascalCase | `StudentList`, `PaymentForm` |
| Custom Hook | camelCase + use prefix | `useStudentData`, `useAuth` |
| Function | camelCase | `fetchStudents`, `formatDate` |
| Variable | camelCase | `studentName`, `isLoading` |
| Type/Interface | PascalCase | `StudentResponse`, `CourseStatus` |
| Constant | UPPER_SNAKE_CASE | `API_BASE_URL`, `MAX_PAGE_SIZE` |

## 2. Next.js App Router

### 2.1 Server/Client Component Selection

| Condition | Choice |
|-----------|--------|
| Data fetch only | Server Component |
| useState/useEffect used | Client Component (`'use client'`) |
| Event handlers used | Client Component |
| Browser API used | Client Component |

### 2.2 Required Files

| File | Purpose | Placement |
|------|---------|-----------|
| `loading.tsx` | Loading UI | Routes with data fetching |
| `error.tsx` | Error UI | All routes (recommended) |
| `not-found.tsx` | 404 UI | Dynamic routes |

### 2.3 Route Handlers

Place under `app/api/`. Prefer Server Actions over Route Handlers when possible.

## 3. React Conventions

### 3.1 Hooks Rules

- **Top-level calls only**: No hooks inside conditionals
- **Custom hooks require `use` prefix**
- **Accurate dependency arrays**

### 3.2 Prohibited Patterns

> Catalog: A1 — 担保: `lint/eslint/rules/no-forwardref.js`（`harness/no-forwardref`）

- **React.forwardRef prohibited**: Scheduled for deprecation. Receive ref via props: `({ ref, ...props }: Props & { ref?: React.Ref<T> })`.

## 4. Form Implementation (React Hook Form + Zod)

- Use **zodResolver** for validation schema integration
- User-friendly validation messages
- Proper default values

```typescript
const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Please enter a valid email address'),
});

const { control, handleSubmit } = useForm({
  resolver: zodResolver(schema),
  defaultValues: { name: '', email: '' },
});
```

## 5. State Management

| Library | Purpose | When to Use |
|---------|---------|-------------|
| TanStack React Query | Server state | API data caching & sync |
| Jotai / Zustand | Client state | UI state, non-form local state |
| React Hook Form | Form state | Form input & validation |

### queryKey Factory Pattern

```typescript
export const studentKeys = {
  all: ['students'] as const,
  lists: () => [...studentKeys.all, 'list'] as const,
  list: (filters: StudentFilters) => [...studentKeys.lists(), filters] as const,
  details: () => [...studentKeys.all, 'detail'] as const,
  detail: (id: string) => [...studentKeys.details(), id] as const,
};
```

## 6. Async Processing

### Basic Rules

- **async/await preferred**: Avoid Promise chains (`.then()`)
- **Independent async operations**: Use `Promise.all` for parallel execution
- **Error handling**: try-catch + appropriate UI display

```typescript
// NG - Promise chain
fetchStudents().then(students => {
  setStudents(students);
}).catch(error => {
  setError(error);
});

// OK - async/await
try {
  const students = await fetchStudents();
  setStudents(students);
} catch (error) {
  setError(error);
}

// OK - parallel independent async operations
const [students, courses] = await Promise.all([
  fetchStudents(),
  fetchCourses(),
]);
```

## 7. Component Design

> Catalog: C7 — 担保: `lint/eslint/rules/one-component-per-file.js`・`lint/eslint/rules/export-at-definition.js`

- **1 file = 1 component**: Separate even internal-only components
- **Export at definition**: `export const ComponentName = ...`

## 8. Testing (Vitest + Testing Library)

### 8.1 Specification-Based Testing

- **No implementation-dependent tests**: Don't directly test internal state (useState etc.)
- **Test user operations and expected results**: Verify specification requirements directly
- **Role-based selectors preferred**: `getByRole` > `getByTestId`

```typescript
// NG - implementation-dependent test
expect(component.state.isOpen).toBe(true);

// OK - specification-based test
await userEvent.click(screen.getByRole('button', { name: 'Show details' }));
expect(screen.getByRole('dialog')).toBeInTheDocument();
```

### 8.2 Test File Naming

- `[ComponentName].test.tsx`
- `[hookName].test.ts`

## 9. Performance Rules

### 9.1 Rendering Performance
- **不要な再レンダリング防止**: `React.memo`、`useMemo`、`useCallback` を適切に使用（ただし過度な最適化は避ける）
- **重い計算の遅延**: `useDeferredValue` / `useTransition` で重い処理のUIブロッキングを防止
- **仮想化**: 大量リスト（100件以上）は `@tanstack/react-virtual` 等で仮想スクロールを検討
- **Suspense境界**: データフェッチ箇所には適切にSuspense境界を配置し、部分的なローディングを実現

### 9.2 Bundle Size
- **Dynamic Import**: 初期表示に不要なコンポーネントは `next/dynamic` で遅延読み込み
- **tree-shaking対応**: 名前付きインポート使用（`import { Button } from '@mui/material'` ではなく `import Button from '@mui/material/Button'`）
- **画像最適化**: `next/image` を使用し、適切な `width`/`height`/`sizes` を指定
- **フォント最適化**: `next/font` でフォントを最適化

### 9.3 Data Fetching Performance
- **staleTime設定**: TanStack React Queryの `staleTime` を適切に設定し、不要な再フェッチを防止
- **プリフェッチ**: ユーザーの次のアクション（ページ遷移等）で必要なデータを `prefetchQuery` で先読み
- **楽観的更新**: ユーザー操作のレスポンスを即座に反映し、バックグラウンドで同期

## 10. Accessibility (a11y) Rules

### 10.1 Semantic HTML
- **適切なHTML要素を使用**: `<button>` for clickable actions, `<a>` for navigation, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>` 等
- **見出し階層**: `h1` > `h2` > `h3` の順序を維持（レベルをスキップしない）
- **ランドマーク**: ページに `<main>`, `<nav>`, `<header>`, `<footer>` を適切に配置

### 10.2 Keyboard Navigation
- **全てのインタラクティブ要素にキーボードでアクセス可能**: Tab, Enter, Escape, Arrow keys
- **フォーカス表示**: `:focus-visible` スタイルを削除しない。カスタムする場合は視認性を確保
- **モーダルのフォーカストラップ**: モーダル表示中はフォーカスがモーダル内に閉じ込められること
- **スキップリンク**: 長いナビゲーションがある場合は「メインコンテンツへスキップ」リンクを検討

### 10.3 ARIA
- **セマンティックHTMLが第一選択**: ARIAは補助的手段。`<button>` に `role="button"` は不要
- **必須ARIA属性**: `aria-label`（ラベルなしのアイコンボタン等）、`aria-expanded`（開閉UI）、`aria-live`（動的更新領域）
- **フォームラベル**: 全ての入力フィールドに `<label htmlFor>` または `aria-label` を関連付け

### 10.4 Visual Design
- **色のコントラスト比**: WCAG 2.1 AA 準拠（通常テキスト 4.5:1、大テキスト 3:1）
- **色だけに頼らない**: エラー表示等で色以外の手段（アイコン、テキスト）も併用
- **テキストサイズ**: `rem` ベースで指定し、ブラウザのフォントサイズ設定を尊重
- **画像の代替テキスト**: 意味のある画像には `alt` テキスト、装飾画像には `alt=""`

## Checklist

- [ ] TypeScript strict mode - no errors
- [ ] No `any` type usage
- [ ] 1 file = 1 component
- [ ] UI library usage considered
- [ ] React Hook Form + Zod for forms
- [ ] async/await preferred, Promise.all for independent operations
- [ ] Specification-based tests (user operations and results)
- [ ] No unnecessary re-renders
- [ ] Bundle size impact considered (dynamic import for heavy components)
- [ ] Semantic HTML elements used appropriately
- [ ] All interactive elements keyboard accessible
- [ ] Form inputs have associated labels
- [ ] Color contrast meets WCAG 2.1 AA
- [ ] Images have appropriate alt text
- [ ] Focus styles visible and not removed
