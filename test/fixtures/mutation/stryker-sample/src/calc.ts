// Pure functions with arithmetic, comparison and logic operators so Stryker
// has a rich set of mutation points (ArithmeticOperator, EqualityOperator,
// ConditionalExpression, LogicalOperator, ...). Kept intentionally small.

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function isEven(n: number): boolean {
  return n % 2 === 0;
}

// Boundary comparison: `>=` is a classic mutation target (>=, >, <, <=).
export function isAdult(age: number): boolean {
  return age >= 18;
}

// Logical operator, exercised only partially by the tests below so at least
// one mutant survives and the score is provably < 100%.
export function inRange(n: number, lo: number, hi: number): boolean {
  return n >= lo && n <= hi;
}
