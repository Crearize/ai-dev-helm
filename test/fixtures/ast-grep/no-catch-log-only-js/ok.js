function risky() {}
const logger = { error(msg, err) {} };

// OK: near-miss - logs to console AND rethrows, so the error is not swallowed
export async function logsThenRethrows() {
  try {
    return await risky();
  } catch (e) {
    console.error('risky failed', e);
    throw e;
  }
}

// OK: near-miss - uses a real logger, not console
export async function usesLogger() {
  try {
    return await risky();
  } catch (e) {
    logger.error('risky failed', e);
    return 'fallback';
  }
}

// OK: console.error outside any catch clause is irrelevant here
export function plainLogging() {
  console.error('startup diagnostics');
}

// OK: catch that logs and then returns a recovery value
export async function logsAndRecovers() {
  try {
    return await risky();
  } catch (e) {
    console.error(e);
    return 'default';
  }
}
