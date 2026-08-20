declare const userInput: string;

// Violation 1: eval on user-controlled input
export function runExpression(): unknown {
  return eval(userInput);
}

// Violation 2: new Function compiles a string into code
export function compile(body: string): () => unknown {
  return new Function(body) as () => unknown;
}

// Violation 3: eval with a template literal
export function runTemplate(name: string): unknown {
  return eval(`config.${name}`);
}

// Violation 4: bare Function(...) call (no new) still compiles a string
export function compileBare(body: string): () => unknown {
  return Function(body) as () => unknown;
}

// Violation 5: setTimeout with a string first argument is eval'd
export function scheduleString(): void {
  setTimeout('doWork()', 0);
}

// Violation 6: setInterval with a template-literal first argument is eval'd
export function pollString(name: string): void {
  setInterval(`poll(${name})`, 1000);
}
