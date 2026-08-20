declare function send(id: string): Promise<void>;
declare function next(): Promise<string | null>;

// Violation 1: sequential await inside a for-of body
export async function sendAllSequentially(ids: string[]): Promise<void> {
  for (const id of ids) {
    await send(id);
  }
}

// Violation 2: sequential await inside a classic for body
export async function sendByIndex(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await send(ids[i]);
  }
}

// Violation 3: sequential await inside a while body
export async function drain(count: number): Promise<void> {
  let remaining = count;
  while (remaining > 0) {
    await send(String(remaining));
    remaining -= 1;
  }
}

// Violation 4: sequential await inside a do-while body
export async function drainAtLeastOnce(count: number): Promise<void> {
  let remaining = count;
  do {
    await send(String(remaining));
    remaining -= 1;
  } while (remaining > 0);
}
