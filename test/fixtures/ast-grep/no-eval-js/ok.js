import { parser } from './parser';

// OK: near-miss - a method named eval on a safe expression parser object
export function evaluateSafely(userInput) {
  return parser.eval(userInput);
}

// OK: near-miss - an ordinary function declaration
export function makeHandler(name) {
  return () => name;
}

// OK: JSON parsing instead of eval
export function parseConfig(raw) {
  return JSON.parse(raw);
}

// OK: near-miss - the word eval appears only in a string and an identifier
export const evalStrategy = 'eval';

// OK: near-miss - setTimeout with a function reference (not a string) is fine
export function scheduleFn(work) {
  setTimeout(work, 0);
}

// OK: near-miss - setInterval with an arrow function is fine
export function pollFn(work) {
  setInterval(() => work(), 1000);
}
