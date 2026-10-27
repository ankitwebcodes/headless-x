import { db, initDb } from "@/lib/db";
import { users, accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { hashPassword, uid } from "@/lib/auth";
import { getUser, json } from "@/lib/reqAuth";

// Admin: create users, list users (with their assigned account handles)
export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (user.role !== "admin") return json({ error: "Admin only" }, 403);
  const rows = await db.select().from(users);
  const acctRows = await db.select({ id: accounts.id, userId: accounts.userId, handle: accounts.handle }).from(accounts);
  const byUser = new Map<string, string[]>();
  for (const a of acctRows) {
    const arr = byUser.get(a.userId) ?? [];
    arr.push(a.handle);
    byUser.set(a.userId, arr);
  }
  return json({
    users: rows.map(({ passwordHash, ...rest }) => ({
      ...rest,
      accounts: byUser.get(rest.id) ?? [],
    })),
  });
}

export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (user.role !== "admin") return json({ error: "Admin only" }, 403);

  const body = await req.json().catch(() => null);
  const { email, password, name } = body || {};
  if (!email || !password || String(password).length < 8) {
    return json({ error: "email + password (min 8 chars) required" }, 400);
  }
  const e = String(email).toLowerCase().trim();
  const dup = (
    await db.select().from(users).where(eq(users.email, e)).limit(1)
  )[0];
  if (dup) {
    return json({ error: "Email already exists" }, 409);
  }
  const row = {
    id: uid(),
    email: e,
    passwordHash: await hashPassword(String(password)),
    name: String(name || e.split("@")[0]),
    role: "user" as const,
    createdAt: Date.now(),
  };
  await db.insert(users).values(row);
  return json({ user: { id: row.id, email: row.email, name: row.name, role: row.role } });
}

// Admin: delete a user — their assigned accounts fall back to the admin
export async function DELETE(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (user.role !== "admin") return json({ error: "Admin only" }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id query param required" }, 400);
  if (id === user.id) return json({ error: "You cannot delete yourself" }, 400);

  const victim = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  if (!victim) return json({ error: "User not found" }, 404);

  // unassign their accounts back to the admin (never orphan them)
  await db
    .update(accounts)
    .set({ userId: user.id })
    .where(and(eq(accounts.userId, id)));

  await db.delete(users).where(eq(users.id, id));
  return json({ ok: true, deleted: id, accountsReassignedTo: user.id });
}
