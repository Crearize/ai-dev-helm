// Deliberately violating fixture for the harness.config.mjs preset smoke
// test. Every rule group in the preset must fire at least once in this file.
import { forwardRef, useState } from 'react'; // harness/no-forwardref (import form)

type Status = 'active' | 'inactive' | 'pending';

async function loadCount(): Promise<number> {
  return Promise.resolve(3);
}

// exhaustiveness (A7): 'pending' is missing and there is no default.
export function describeStatus(status: Status): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'inactive':
      return 'Inactive';
  }
  return 'unknown';
}

// correctness (A1/A2) + type-safety (A5)
export function logAll(values: any): void {
  console.log(values); // no-console
  loadCount(); // @typescript-eslint/no-floating-promises
}

// performance (D2) + maintainability (C6)
export async function loadSequentially(ids: string[]): Promise<number> {
  let total = 0;
  for (const id of ids) {
    total += await loadCount(); // no-await-in-loop
    total += id.length;
  }
  if (total > 512) {
    // 512 is a magic number -> @typescript-eslint/no-magic-numbers (warn)
    return 0;
  }
  return total;
}

// harness custom (A1/C7)
export const FancyInput = forwardRef<HTMLInputElement, { value: string }>(
  (props, ref) => <input ref={ref} value={props.value} readOnly />
); // harness/no-forwardref (call form)

// Two exported components -> harness/one-component-per-file on the second.
export const Badge = ({ label }: { label: string }) => <span>{label}</span>;

export function Panel({ title }: { title: string }) {
  return <div>{title}</div>;
}

// Bottom export of a locally defined function -> harness/export-at-definition.
function formatLabel(label: string): string {
  return label.trim();
}
export { formatLabel };

// security (A1/B1): dynamic code execution + javascript: URL sinks.
export function runUnsafe(source: string): void {
  const compiled = new Function('return 1'); // no-new-func + no-implied-eval
  setTimeout('doWork()', 100); // no-implied-eval (string body)
  eval(source); // no-eval
  location.href = 'javascript:void(0)'; // no-script-url
  console.log(compiled);
}

// react-hooks (D3): a hook called conditionally -> rules-of-hooks.
function useMaybe(active: boolean): number {
  if (active) {
    const [value] = useState(0); // react-hooks/rules-of-hooks
    return value;
  }
  return 0;
}

// react (A1): XSS-prone JSX sinks -> react/no-danger, jsx-no-script-url,
// jsx-no-target-blank.
export function Unsafe({ html, link }: { html: string; link: string }) {
  useMaybe(true);
  return (
    <div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <a href="javascript:alert(1)">bad</a>
      <a href={link} target="_blank">
        external
      </a>
    </div>
  );
}
