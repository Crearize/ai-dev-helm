# Frontend Coding Rules

> **Tech Stack**: Next.js + React + TypeScript

> 言語横断の禁止パターン（ワイルドカード import・完全修飾名の直書き・未使用 import・マジックナンバー）は `documents/development/coding-rules/common-rules.md` §7 / カタログ A1・C3・C6 を参照。
> レイヤー責務・DRY・仕様ベーステストの一般原則は同 §6、セキュリティ・パフォーマンスの汎用原則は同 §4 / §5 を参照。本書が持つのは Next.js / React / TypeScript 固有の具体のみである。
> `> Catalog:` 注記の読み方は common-rules.md「Catalog 注記の読み方」を参照。ただし**スタック別ルール文書の項目はカタログへは移さず**、フェーズ3で Lint 資産が配線された後に「項目名 + カタログ番号 + Lint 資産参照」の短縮形へ縮約する（削除はしない）。そのため本書の注記は `（フェーズ3で Lint 資産提供予定）` 形式を用いる。
> 上記のパスは**配布後のプロダクト側表記**（カタログ §5 の対応表）。ハーネスリポジトリでは `shared/documents/coding-rules/common-rules.md`。

## Prohibited Patterns

### any type prohibited

> Catalog: A1（フェーズ3で Lint 資産提供予定 — `@typescript-eslint/no-explicit-any`）

Use `unknown` type instead.

```typescript
// NG
function process(data: any) { ... }

// OK
function process(data: unknown) { ... }
```

### React.forwardRef prohibited

> Catalog: A1（フェーズ3で Lint 資産提供予定 — 独自 ESLint ルール）

Scheduled for deprecation. Use props to receive ref instead.

```typescript
// NG
const Button = React.forwardRef<HTMLButtonElement, Props>((props, ref) => ...)

// OK
const Button = ({ ref, ...props }: Props & { ref?: React.Ref<HTMLButtonElement> }) => ...
```

## Coding Conventions

> Catalog: C7 — 「1 file = 1 component」「Export at definition」（フェーズ3で独自 ESLint ルールの Lint 資産提供予定）/ A5 — 「Type safety」のうち機械検出可能な部分（`as any`・non-null assertion 乱用・理由なし `@ts-ignore` 等。typescript-eslint。フェーズ3で Lint 資産提供予定）。
> 型設計の妥当性、および「UI library first」（既存コンポーネントで足りるかの判断）はカタログ対応なし — AI レビュー恒久担保。

- **1 file = 1 component**: Separate even internal-only components into their own files
- **Export at definition**: `export const ComponentName = ...`
- **Type safety**: Define TypeScript types appropriately
- **UI library first**: Check existing UI library components before creating new ones

## Accessibility Requirements

> Catalog: F1（フェーズ3で Lint 資産提供予定 — eslint-plugin-jsx-a11y）
> 「Color contrast must meet WCAG 2.1 AA」は静的解析では判定できない — AI レビュー / 実測ツールで恒久担保。

- Semantic HTML elements preferred over `div` + ARIA roles
- All interactive elements must be keyboard accessible
- Form inputs must have associated labels (`htmlFor` or `aria-label`)
- Icon-only buttons must have `aria-label`
- Color contrast must meet WCAG 2.1 AA (4.5:1 text, 3:1 large text)
