// Deliberately violating fixture for the harness.config.mjs preset smoke
// test. Every rule group in the preset must fire at least once in this file.
import { forwardRef } from 'react'; // harness/no-forwardref (import form)

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
