import { db, initDb } from "@/lib/db";
import { media, accountMedia } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { json } from "@/lib/reqAuth";

// Worker marks a panel-uploaded video as stored in the real X media library:
// body { mediaId, accountId, mediaKey: "13_<id>", mediaType: "VIDEO" }.
export async function POST(req: Request) {
  await initDb();
  const auth = req.headers.get("x-worker-token");
  if (auth !== process.env.WORKER_TOKEN) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const { mediaId, mediaKey, accountId } = body || {};
  if (!mediaId || !mediaKey) return json({ error: "mediaId and mediaKey required" }, 400);

  const m = (
    await db.select().from(media).where(eq(media.id, mediaId)).limit(1)
  )[0];
  if (!m) return json({ error: "Media not found" }, 404);

  const key = String(mediaKey);
  if (accountId) {
    const pending = await db.select().from(accountMedia).where(
      and(eq(accountMedia.mediaId, String(mediaId)), eq(accountMedia.accountId, String(accountId)))
    ).limit(1);
    if (!pending.length) return json({ error: "No pending upload for this account" }, 404);
    // Per-account key (the normal path).
    await db
      .insert(accountMedia)
      .values({
        id: crypto.randomUUID(),
        mediaId,
        accountId: String(accountId),
        mediaKey: key,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [accountMedia.accountId, accountMedia.mediaId],
        set: { mediaKey: key },
      });
    return json({ ok: true, mediaKey });
  }

  // Legacy: no accountId -> global media row key (ads-synced media).
  if (m.mediaKey) return json({ error: "already uploaded", mediaKey: m.mediaKey });
  await db
    .update(media)
    .set({ mediaKey: key, mediaType: "VIDEO" })
    .where(eq(media.id, mediaId));
  return json({ ok: true, mediaKey });
}
