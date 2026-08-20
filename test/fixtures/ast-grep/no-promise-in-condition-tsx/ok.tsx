declare function loadUser(): Promise<boolean>;
declare function loadOrders(): Promise<boolean>;
declare function handle(): void;

// OK: near-miss - awaited before being used as a condition
export async function checkAwaited(): Promise<void> {
  const [user, orders] = await Promise.all([loadUser(), loadOrders()]);
  if (user && orders) {
    handle();
  }
}

// OK: near-miss - await directly inside the condition
export async function checkAwaitInline(): Promise<void> {
  if (await Promise.race([loadUser(), loadOrders()])) {
    handle();
  }
}

// OK: Promise.all outside of any condition
export async function collect(): Promise<boolean[]> {
  return Promise.all([loadUser(), loadOrders()]);
}

// OK: near-miss - a promise-returning call, then a real boolean condition
export async function checkResolved(): Promise<void> {
  const ready = await Promise.resolve(true);
  if (ready) {
    handle();
  }
}
