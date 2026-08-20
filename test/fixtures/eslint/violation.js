// Plain-JS (CommonJS) violation fixture for the harness.config.mjs preset.
// The type-aware block only sees TS/TSX, so this file proves the base
// security group and no-console guard plain `.js` too, while Node globals
// (`process`, `require`, `module`) must NOT be flagged as `no-undef`.
'use strict';

const userInput = process.argv[2]; // process: Node global, no no-undef

function run() {
  eval(userInput); // no-eval
  const compiled = new Function('return 2'); // no-new-func + no-implied-eval
  setTimeout('tick()', 50); // no-implied-eval (string body)
  const url = 'javascript:void(0)'; // no-script-url
  console.log(compiled, url); // no-console
}

module.exports = { run };
