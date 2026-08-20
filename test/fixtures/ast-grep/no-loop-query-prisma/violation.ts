// N+1 patterns: Prisma queries inside a loop and inside a .map() callback.

// Violation 1: Prisma findUnique inside a for-of loop
export async function loadEach(prisma: PrismaLike, ids: string[]) {
  const users = [];
  for (const id of ids) {
    users.push(await prisma.user.findUnique({ where: { id } }));
  }
  return users;
}

// Violation 2: Prisma findFirst inside a .map() callback
export async function loadMapped(prisma: PrismaLike, ids: string[]) {
  return Promise.all(ids.map((id) => prisma.user.findFirst({ where: { id } })));
}

// Violation 3: Prisma update inside a while loop
export async function updateWhile(prisma: PrismaLike, queue: string[]) {
  while (queue.length > 0) {
    const id = queue.pop();
    await prisma.user.update({ where: { id }, data: { seen: true } });
  }
}

interface PrismaLike {
  user: {
    findUnique(args: object): Promise<unknown>;
    findFirst(args: object): Promise<unknown>;
    update(args: object): Promise<unknown>;
  };
}
