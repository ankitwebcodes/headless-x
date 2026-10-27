import { db, initDb } from "@/lib/db";
import { accounts, accountMedia, media } from "@/lib/schema";
import { eq, isNull, and } from "drizzle-orm";
import { json } from "@/lib/reqAuth";

// Worker polls this for uploaded-but-not-yet-in-X-library media rows.
// Each returned item has the target account's secrets so the worker can push
// the video into the account's REAL X media library (composer amplify upload),
// then call POST /api/worker/uploaded to record the resulting media_key.
export async function GET(req: Request) {
  await initDb();
  const auth = req.headers.get("x-worker-token");
  if (auth !== process.env.WORKER_TOKEN) return json({ error: "Unauthorized" }, 401);

  const pending = await db
    .select({ am: accountMedia, m: media })
    .from(accountMedia)
    .innerJoin(media, eq(accountMedia.mediaId, media.id))
    .where(and(isNull(accountMedia.mediaKey), isNull(media.mediaKey)))
    .orderBy(accountMedia.createdAt)
    .limit(20);

  const uploads: unknown[] = [];
  for (const { am, m } of pending) {
    const acct = (
      await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, am.accountId))
        .limit(1)
    )[0];
    if (!acct || acct.status !== "approved") continue;
    if (!acct.sessionJson) continue;
    let sessionJson: unknown = {};
    try { sessionJson = JSON.parse(acct.sessionJson); } catch { continue; }
    // Private blob URLs 403 for direct fetches — route through the signed
    // proxy exactly like /api/worker/claim does for job media. Without this
    // the worker gets "HTTP Error 403: Forbidden" on every pending upload and
    // retries forever (panel uploads never reach the X library).
    const proxied = m.url.includes("vercel-storage.com")
      ? `/api/proxy-media?u=${encodeURIComponent(m.url)}`
      : m.url;
    uploads.push({
      id: m.id,
      name: m.name,
      url: proxied,
      accountId: acct.id,
      handle: acct.handle,
      adsAccountId: acct.adsAccountId,
      sessionJson,
    });
  }
  return json({ uploads });
}
