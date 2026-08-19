// Conforming fixture for the harness.config.mjs preset smoke test.
// This file must produce ZERO errors and ZERO warnings under the preset.
import { useRef } from 'react';

export type Status = 'active' | 'inactive';

const MAX_TOTAL = 512;

export function describeStatus(status: Status): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'inactive':
      return 'Inactive';
  }
}

function loadCount(): Promise<number> {
  return Promise.resolve(1);
}

export async function loadTotal(ids: readonly string[]): Promise<number> {
  const counts = await Promise.all(ids.map(() => loadCount()));
  const total = counts.reduce((sum, count) => sum + count, 0);
  return Math.min(total, MAX_TOTAL);
}

// Non-exported uppercase helper: allowed alongside the single exported
// component below.
function Label({ text }: { text: string }) {
  return <strong>{text}</strong>;
}

export function StatusBadge({ status }: { status: Status }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  return (
    <span ref={ref}>
      <Label text={describeStatus(status)} />
    </span>
  );
}
