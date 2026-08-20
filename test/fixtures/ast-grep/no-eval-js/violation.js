// Violation 1: eval on user-controlled input
export function runExpression(userInput) {
  return eval(userInput);
}

// Violation 2: new Function compiles a string into code
export function compile(body) {
  return new Function(body);
}

// Violation 3: eval with a template literal
export function runTemplate(name) {
  return eval(`config.${name}`);
}

// Violation 4: bare Function(...) call (no new) still compiles a string
export function compileBare(body) {
  return Function(body);
}

// Violation 5: setTimeout with a string first argument is eval'd
export function scheduleString() {
  setTimeout('doWork()', 0);
}

// Violation 6: setInterval with a template-literal first argument is eval'd
export function pollString(name) {
  setInterval(`poll(${name})`, 1000);
}
