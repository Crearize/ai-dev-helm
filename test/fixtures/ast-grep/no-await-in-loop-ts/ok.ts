declare function send(id: string): Promise<void>;
declare function fetchPage(n: number): Promise<string[]>;
declare function stream(): AsyncIterable<string>;

// OK: the recommended shape - build promises in the loop, await once
export async function sendAllInParallel(ids: string[]): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const id of ids) {
    pending.push(send(id));
  }
  await Promise.all(pending);
}

// OK: near-miss - a single await outside any loop
export async function sendOne(id: string): Promise<void> {
  await send(id);
}

// OK: near-miss - awaiting a nested async callback, not a loop body statement
export async function mapAll(ids: string[]): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      await send(id);
    })
  );
}

// OK: near-miss - for-await-of over an async stream is the intended idiom
export async function consumeStream(): Promise<string[]> {
  const seen: string[] = [];
  for await (const chunk of stream()) {
    seen.push(chunk);
  }
  return seen;
}

// OK: the awaited value is bound and used, so it is a real data dependency
export async function paginate(): Promise<string[]> {
  const all: string[] = [];
  for (let page = 0; page < 3; page++) {
    const items = await fetchPage(page);
    all.push(...items);
  }
  return all;
}
