declare const describe: any;
declare const it: any;
declare const expect: any;
declare function isEnabled(): boolean;
declare function total(): number;

describe('real assertions', () => {
  // OK: near-miss - a real value compared against a literal
  it('reports enabled', () => {
    const result = isEnabled();
    expect(result).toBe(true);
  });

  // OK: near-miss - a real value compared against a numeric literal
  it('sums the cart', () => {
    expect(total()).toBe(42);
  });

  // OK: near-miss - two different literals is a failing assertion, not a
  // tautology, and is caught by the test run itself
  it('compares distinct literals', () => {
    expect(total()).toBe(1);
  });

  // OK: near-miss - identical literals but a different matcher shape
  it('checks membership', () => {
    expect([1, 2, 3]).toContain(1);
  });
});
