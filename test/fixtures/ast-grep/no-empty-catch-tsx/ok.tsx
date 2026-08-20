declare function risky(): void;
declare function report(err: unknown): void;
declare const logger: { error(msg: string, err: unknown): void };

// OK: catch with real handling (rethrow)
export function rethrows(): void {
  try {
    risky();
  } catch (e) {
    throw new Error(`risky failed: ${String(e)}`);
  }
}

// OK: catch that handles the error, with a comment alongside the statement
export function handlesWithComment(): void {
  try {
    risky();
  } catch (e) {
    // near-miss: comment plus a real statement must NOT be flagged
    report(e);
  }
}

// OK: try/finally without catch at all
export function finallyOnly(): void {
  try {
    risky();
  } finally {
    logger.error('done', null);
  }
}
