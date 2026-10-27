import { NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { accounts, accountMedia, media } from "@/lib/schema";
import { desc, eq, and, inArray } from "drizzle-orm";
import { uid, verifySessionToken } from "@/lib/auth";
import { saveMedia } from "@/lib/storage";
import { mediaTypeFilter } from "@/lib/media-policy";

async function getUser(req: Request) {
  const token = req.headers.get("cookie")?.match(/xp_session=([^;]+)/)?.[1];
  if (!token) return null;
  return verifySessionToken(token);
}

// Media library.
//  - admin: ALL media.
//  - user:  media belonging to approved+enabled accounts (the shared, admin-
//           managed accounts they can post to) + their own local uploads.
//  - ?accountId=X → only that account's library (users must have access).
export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = user.role === "admin";
  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");

  const rowsForAccount = async (id: string) => {
    const [direct, uploaded] = await Promise.all([
      db.select().from(media).where(eq(media.accountId, id)).orderBy(desc(media.createdAt)),
      db.select({ item: media })
        .from(accountMedia)
        .innerJoin(media, eq(accountMedia.mediaId, media.id))
        .where(eq(accountMedia.accountId, id)),
    ]);
    const unique = new Map<string, (typeof direct)[number]>();
    for (const item of direct) unique.set(item.id, item);
    for (const { item } of uploaded) unique.set(item.id, { ...item, accountId: id });
    return mediaTypeFilter(Array.from(unique.values()).sort((a, b) => b.createdAt - a.createdAt));
  };

  if (admin) {
    const rows = accountId
      ? await rowsForAccount(accountId)
      : mediaTypeFilter(await db.select().from(media).orderBy(desc(media.createdAt)));
    return NextResponse.json({ media: rows });
  }

  // users: ONLY the accounts the admin assigned to them (private per user)
  const assigned = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, user.id),
        eq(accounts.status, "approved"),
        eq(accounts.enabled, 1)
      )
    );
  const sharedIds = assigned.map((a) => a.id);

  if (accountId) {
    if (!sharedIds.includes(accountId)) {
      return NextResponse.json({ error: "No access to that account's library" }, { status: 403 });
    }
    const rows = await rowsForAccount(accountId);
    return NextResponse.json({ media: rows });
  }

  const mine = mediaTypeFilter(await db.select().from(media).where(eq(media.userId, user.id)).orderBy(desc(media.createdAt)));
  const sharedRows = sharedIds.length
    ? (await Promise.all(sharedIds.map(rowsForAccount))).flat()
    : [];
  const byId = new Map<string, (typeof mine)[number]>();
  for (const m of mine) byId.set(m.id, m);
  for (const m of sharedRows) byId.set(m.id, m);
  const rows = Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  return NextResponse.json({ media: rows });
}

// Upload a video into the panel library. Pass accountId to have it stored into
// that account's REAL X media library (the worker performs the X library upload
// as soon as it sees a row with mediaKey=null + accountId set).
export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (buf.length > 200 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 200MB)" }, { status: 400 });
  }

  const accountId = String(form.get("accountId") || "").trim();
  if (!accountId) return NextResponse.json({ error: "Select an account before uploading" }, { status: 400 });
  {
    const acct = (
      await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
    )[0];
    if (
      !acct ||
      (user.role !== "admin" && acct.userId !== user.id) ||
      acct.status !== "approved" ||
      acct.enabled !== 1
    ) {
      return NextResponse.json({ error: "That account is not available" }, { status: 403 });
    }
  }

  const saved = await saveMedia(file.name, buf, file.type || "video/mp4");
  const row = {
    id: uid(),
    userId: user.id,
    name: file.name,
    url: saved.url,
    sizeBytes: saved.sizeBytes,
    mimeType: file.type || "video/mp4",
    durationMs: null,
    accountId: accountId || null,
    mediaKey: null,
    mediaType: null,
    createdAt: Date.now(),
  };
  await db.insert(media).values(row);
  await db.insert(accountMedia).values({
    id: uid(), mediaId: row.id, accountId, mediaKey: null, createdAt: Date.now(),
  }).onConflictDoNothing();
  return NextResponse.json({ media: row });
}