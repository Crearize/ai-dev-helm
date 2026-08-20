declare function loadUser(): Promise<boolean>;
declare function loadOrders(): Promise<boolean>;
declare function handle(): void;

// Violation 1: Promise.all is always truthy, the branch always runs
export async function checkAll(): Promise<void> {
  if (Promise.all([loadUser(), loadOrders()])) {
    handle();
  }
}

// Violation 2: Promise.race used directly as a condition
export async function checkRace(): Promise<void> {
  if (Promise.race([loadUser(), loadOrders()])) {
    handle();
  }
}

// Violation 3: Promise.resolve used directly as a condition
export function checkResolve(flag: boolean): void {
  if (Promise.resolve(flag)) {
    handle();
  }
}
