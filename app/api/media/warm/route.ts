import { db, initDb } from "@/lib/db";
import { media } from "@/lib/schema";
import { desc, eq } from "drizzle-orm";
import { getUser, json } from "@/lib/reqAuth";
import { adsMediaReady, warmAdsMedia } from "@/lib/postOne";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// /api/media/warm — push already-uploaded videos into the X ads library.
//
// New uploads are warmed automatically at register time, but videos uploaded
// before that change (and videos whose warm failed) still pay the slow
// ~25-60s ads-library upload when the user first picks a link. This lets the
// panel backfill them, so card prep is instant for every video in the library.
//
//   GET                  → { pending: [{id, name}] }   (not yet warmed)
//   POST { ids?: [] }    → warms the given ids, or up to 10 un-warmed videos
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const rows = await db
    .select({ id: media.id, name: media.name, mediaKey: media.mediaKey })
    .from(media)
    .where(eq(media.userId, user.id))
    .orderBy(desc(media.createdAt))
    .limit(80);

  const pending: Array<{ id: string; name: string }> = [];
  for (const r of rows) {
    if (!(await adsMediaReady(r.mediaKey, r.id))) pending.push({ id: r.id, name: r.name });
  }
  return json({ pending, checked: rows.length });
}

export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  let ids: string[] = Array.isArray(body?.ids) ? body.ids.map((x: unknown) => String(x)) : [];

  if (!ids.length) {
    // Scan a WIDE window and warm the first 10 that still need it. Scanning
    // only the 10 newest rows made backfill a no-op once those were warm
    // (it kept re-checking the same videos and reported nothing to do).
    const rows = await db
      .select({ id: media.id, name: media.name, mediaKey: media.mediaKey })
      .from(media)
      .where(eq(media.userId, user.id))
      .orderBy(desc(media.createdAt))
      .limit(80);
    for (const r of rows) {
      if (ids.length >= 10) break;
      if (!(await adsMediaReady(r.mediaKey, r.id))) ids.push(r.id);
    }
  }
  ids = ids.slice(0, 10);

  const warmed: Array<{ id: string; ok: boolean; ms: number; error?: string }> = [];
  for (const id of ids) {
    const m = (await db.select().from(media).where(eq(media.id, id)).limit(1))[0];
    if (!m) continue;
    if (user.role !== "admin" && m.userId !== user.id) continue;
    const r = await warmAdsMedia(m.mediaKey, m.id, m.url);
    warmed.push({ id, ...r });
  }
  return json({ warmed });
}
