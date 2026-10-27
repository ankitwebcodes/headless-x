import { db, initDb } from "@/lib/db";
import { jobs, accounts, media } from "@/lib/schema";
import { desc, eq } from "drizzle-orm";
import { uid } from "@/lib/auth";
import { getUser, json } from "@/lib/reqAuth";

// List jobs (user: own; admin: all)
export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const rows =
    user.role === "admin"
      ? await db.select().from(jobs).orderBy(desc(jobs.createdAt))
      : await db.select().from(jobs).where(eq(jobs.userId, user.id)).orderBy(desc(jobs.createdAt));
  return json({ jobs: rows });
}

// Create a post job: pick media + approved account + caption/url/title
export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const { accountId, mediaId, caption, url, title } = body || {};
  if (!accountId || !mediaId) return json({ error: "accountId and mediaId required" }, 400);

  const acct = (
    await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
  )[0];
  if (!acct) return json({ error: "Account not found" }, 404);
  if (acct.status !== "approved") return json({ error: "Account not approved by admin yet" }, 403);
  if (acct.userId !== user.id && user.role !== "admin") {
    return json({ error: "Not your account" }, 403);
  }
  const m = (
    await db.select().from(media).where(eq(media.id, mediaId)).limit(1)
  )[0];
  if (!m) return json({ error: "Media not found" }, 404);
  if (m.userId !== user.id && user.role !== "admin") {
    return json({ error: "Not your media" }, 403);
  }

  const row = {
    id: uid(),
    userId: user.id,
    accountId: acct.id,
    mediaId: m.id,
    caption: String(caption ?? acct.defaultCaption ?? ""),
    url: String(url ?? acct.defaultUrl),
    title: String(title ?? acct.defaultTitle),
    status: "queued" as const,
    tweetUrl: null,
    error: null,
    claimedBy: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.insert(jobs).values(row);
  return json({ job: row });
}