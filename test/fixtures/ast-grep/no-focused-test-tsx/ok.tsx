declare const describe: any;
declare const it: any;
declare const test: any;
declare const expect: any;
declare const permissions: { only(role: string): boolean };

// OK: ordinary describe / it without .only
describe('checkout flow', () => {
  it('charges the card', () => {
    expect(1).toBe(1);
  });

  it.each([1, 2])('handles %i items', (n: number) => {
    expect(n).toBeGreaterThan(0);
  });
});

// OK: ordinary test block
test('renders the header', () => {
  expect(1).toBe(1);
});

// OK: near-miss - an unrelated helper that happens to be named only
export function isAdminOnly(role: string): boolean {
  return permissions.only(role);
}

// OK: near-miss - a helper named fitToScreen is not the focused alias fit
export function fitToScreen(width: number): number {
  return width;
}

// OK: near-miss - the word only appears in a test title
test('shows admin-only actions', () => {
  expect(1).toBe(1);
});
