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

// Violation 4: a bare semicolon is not a real statement
export function swallowSemicolon(): void {
  try {
    risky();
  } catch (e) {
    ;
  }
}

// Violation 5: `null;` does nothing
export function swallowNull(): void {
  try {
    risky();
  } catch (e) {
    null;
  }
}

// Violation 6: `void 0;` does nothing
export function swallowVoid(): void {
  try {
    risky();
  } catch (e) {
    void 0;
  }
}
