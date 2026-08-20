function risky() {}

// Violation 1: catch body is exactly one console.error call
export async function logAndSwallow() {
  try {
    return await risky();
  } catch (e) {
    console.error(e);
  }
}

// Violation 2: console.log only, with a comment alongside
export async function logAndForget() {
  try {
    await risky();
  } catch (err) {
    // swallowed below
    console.log('risky failed', err);
  }
}

// Violation 3: console.warn only
export async function warnOnly() {
  try {
    await risky();
  } catch {
    console.warn('ignored');
  }
}
