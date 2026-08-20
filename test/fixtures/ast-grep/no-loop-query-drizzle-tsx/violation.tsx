// N+1 patterns: Drizzle queries inside loops and inside a .map() callback.
import { db, usersTable, eq } from './client';

// Violation 1: Drizzle update inside a for-of loop
export async function updateEach(rows: Array<{ id: number; n: number }>) {
  for (const row of rows) {
    await db.update(usersTable).set({ n: row.n }).where(eq(usersTable.id, row.id));
  }
}

// Violation 2: Drizzle insert inside a .map() callback
export async function insertMapped(rows: Array<{ id: number }>) {
  await Promise.all(rows.map((row) => db.insert(usersTable).values(row)));
}

// Violation 3: Drizzle select inside a while loop
export async function selectWhile(ids: number[]) {
  const found = [];
  while (ids.length > 0) {
    const id = ids.pop();
    found.push(await db.select().from(usersTable).where(eq(usersTable.id, id)));
  }
  return found;
}
