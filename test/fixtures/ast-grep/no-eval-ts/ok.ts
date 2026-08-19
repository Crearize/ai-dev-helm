declare const userInput: string;
declare const parser: { eval(expr: string): number };

// OK: near-miss - a method named eval on a safe expression parser object
export function evaluateSafely(): number {
  return parser.eval(userInput);
}

// OK: near-miss - an ordinary function declaration named Function-like
export function makeHandler(name: string): () => string {
  return () => name;
}

// OK: JSON parsing instead of eval
export function parseConfig(raw: string): unknown {
  return JSON.parse(raw);
}

// OK: near-miss - the word eval appears only in a string and an identifier
export const evalStrategy = 'eval';
