// Conforming plain-JS (CommonJS) fixture: must produce ZERO errors and ZERO
// warnings under the preset. Exercises the Node + browser globals wiring so
// `process`/`require`/`module`/`window` are not reported as `no-undef`, and
// avoids every guarded sink (no eval, no dynamic code, no `javascript:` URL,
// no console).
'use strict';

const path = require('path');

const ROOT = process.cwd();

function resolveConfig(name) {
  return path.join(ROOT, name);
}

// A browser global must not trip no-undef either.
const hasWindow = typeof window !== 'undefined';

module.exports = { resolveConfig, hasWindow };
