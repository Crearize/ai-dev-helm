# Frontend Coding Rules

> **Tech Stack**: Next.js + React + TypeScript

> 言語横断の禁止パターン（未使用 import・マジックナンバー・ワイルドカード import 等）は**カタログ A1・C3・C6（`documents/development/static-check-standard.md`）を恒久の正**とする。移行期（フェーズ3まで）の本文は `documents/development/coding-rules/common-rules.md` §7 を参照（同 §7 は Lint 配線の確認後に削除される）。
> DRY 原則は common-rules.md §6.2、仕様ベーステストの原則は同 §6.3、セキュリティの汎用原則は同 §4 を参照。**レイヤー責務（同 §6.1）と DB クエリ品質（同 §5）はサーバーサイドのデータアクセス層を持つプロダクト向けであり、本スタックの構造規約（Server Component / Server Actions 等の責務分割）は本書と `documents/development/coding-rules/frontend-rules.md` を正とする。**
> フロントエンド性能はカタログ D3（採用基準: 任意）と `documents/development/coding-rules/frontend-rules.md` §9（再レンダリング防止・バンドルサイズ・データフェッチ）を参照。アクセシビリティの詳細は同 §10 を参照。本書が持つのは Next.js / React / TypeScript 固有の要点のみである。
> `> Catalog:` 注記の読み方は common-rules.md「Catalog 注記の読み方」を参照。ただし**スタック別ルール文書の項目はカタログへは移さず**、フェーズ3で Lint 資産が配線された後に「項目名 + カタログ番号 + Lint 資産参照」の短縮形へ縮約する（削除はしない）。そのため本書の注記は `（フェーズ3で Lint 資産提供予定）` 形式を用いる。
> **パス表記について**: 本書が挙げるパスはすべて**配布後のプロダクト側表記**である。ハーネスリポジトリでの対応は `documents/development/static-check-standard.md` → `shared/documents/static-check-standard.md`、`documents/development/coding-rules/common-rules.md` → `shared/documents/coding-rules/common-rules.md`、`documents/development/coding-rules/frontend-rules.md` → `stacks/nextjs-react/documents/coding-rules/frontend-rules.md`。完全な対応表はカタログ §5。

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

見出し階層・ランドマーク・フォーカストラップ・代替テキスト等の詳細は `documents/development/coding-rules/frontend-rules.md` §10 を参照。
