// Batched pattern: one findMany with an `in` filter, then pure in-memory
// mapping. No query call sits inside a loop or .map() callback.
export async function loadAll(prisma: PrismaLike, ids: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: ids } } });
  return Promise.all(users.map((user) => Promise.resolve(user.name)));
}

interface PrismaLike {
  user: {
    findMany(args: object): Promise<Array<{ name: string }>>;
  };
}
