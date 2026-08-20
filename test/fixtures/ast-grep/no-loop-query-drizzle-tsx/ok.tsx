// Batched pattern: one select with inArray, then pure in-memory mapping.
// No query call sits inside a loop or .map() callback.
import { db, usersTable, inArray } from './client';

export async function loadAll(ids: number[]) {
  const rows = await db.select().from(usersTable).where(inArray(usersTable.id, ids));
  return rows.map((row) => row.id);
}

export async function insertBatch(values: Array<{ id: number }>) {
  await db.insert(usersTable).values(values);
}
