function risky() {}
function report(err) {}
const logger = { error(msg, err) {} };

// OK: catch with real handling (rethrow)
export function rethrows() {
  try {
    risky();
  } catch (e) {
    throw new Error(`risky failed: ${String(e)}`);
  }
}

// OK: catch that handles the error, with a comment alongside the statement
export function handlesWithComment() {
  try {
    risky();
  } catch (e) {
    // near-miss: comment plus a real statement must NOT be flagged
    report(e);
  }
}

// OK: try/finally without catch at all
export function finallyOnly() {
  try {
    risky();
  } finally {
    logger.error('done', null);
  }
}
