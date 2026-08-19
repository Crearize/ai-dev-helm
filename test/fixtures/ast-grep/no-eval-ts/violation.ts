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
