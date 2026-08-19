declare function risky(): void;
declare function cleanup(): void;

// Violation 1: completely empty catch block
export function swallowSilently(): void {
  try {
    risky();
  } catch (e) {}
}

// Violation 2: comment-only catch body is still empty
export function swallowWithExcuse(): void {
  try {
    risky();
  } catch (e) {
    // ignore, probably fine
  }
}

// Violation 3: block-comment-only catch body is still empty
export function swallowWithBlockComment(): void {
  try {
    risky();
  } catch {
    /* intentionally ignored */
  } finally {
    cleanup();
  }
}
