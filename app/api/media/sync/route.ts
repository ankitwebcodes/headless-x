import { db, initDb } from "@/lib/db";
import { accounts, media } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { uid } from "@/lib/auth";
import { getUser, json } from "@/lib/reqAuth";
import { adsFetchAllMedia, fetchUserMediaCookies, type OAuth1Creds } from "@/lib/xpost";
import { mediaTypeFilter } from "@/lib/media-policy";

// ---------------------------------------------------------------------------
// POST /api/media/sync — pull each approved account's X media library (videos
// AND images) into the panel. Triggered by the dashboard "Sync from X" button
// or by the worker (x-worker-token). Rows are owned by the account's owner so
// media libraries stay private per user.
//
// Per account: prefer the OAuth1 ads media library when creds exist, else fall
// back to the session-cookie UserMedia sync (cookie-only accounts — the xgrab
// extension gives us cookies but no OAuth1).
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  await initDb();
  const workerToken = req.headers.get("x-worker-token");
  const body = await req.json().catch(() => ({}));
  const requestedAccountId = String(body?.accountId ?? "").trim();
  if (workerToken === process.env.WORKER_TOKEN) {
    return json(await runSync(null, requestedAccountId || undefined));
  }
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (requestedAccountId) {
    const account = (await db.select({ id: accounts.id }).from(accounts).where(and(
      eq(accounts.id, requestedAccountId),
      eq(accounts.status, "approved"),
      eq(accounts.enabled, 1),
      ...(user.role === "admin" ? [] : [eq(accounts.userId, user.id)]),
    )).limit(1))[0];
    if (!account) return json({ error: "Account is unavailable" }, 403);
  }
  return json(await runSync(user, requestedAccountId || undefined));
}

async function runSync(user: { id: string; role: string } | null, requestedAccountId?: string) {
  const approved = and(eq(accounts.status, "approved"), eq(accounts.enabled, 1));
  const accountFilter = requestedAccountId ? [eq(accounts.id, requestedAccountId)] : [];
  // admin/worker → approved accounts; regular user → ONLY their own.
  const acctRows =
    user && user.role !== "admin"
      ? await db.select().from(accounts).where(and(approved, eq(accounts.userId, user.id), ...accountFilter))
      : await db.select().from(accounts).where(and(approved, ...accountFilter));

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const acct of acctRows) {
    let creds: OAuth1Creds | null = null;
    try {
      creds = JSON.parse(acct.oauth1Json) as OAuth1Creds;
    } catch {
      creds = null;
    }
    const hasOauth = !!(creds?.consumer_key && creds?.access_token && acct.adsAccountId);
    try {
      if (hasOauth) {
        const items = await adsFetchAllMedia(creds as OAuth1Creds, acct.adsAccountId);
        for (const it of items) {
          if (it.deleted) continue;
          const type = String(it.media_type || "");
          if (type !== "VIDEO") continue;
          const key = String(it.media_key || "");
          const url = String(it.media_url || "");
          if (!key || !url) continue;
          const dup = await db.select().from(media)
            .where(and(eq(media.mediaKey, key), eq(media.accountId, acct.id))).limit(1);
          if (dup.length > 0) {
            skipped++;
            continue;
          }
          const name = String(it.file_name || it.name || key);
          const createdAt = Date.parse(String(it.created_at || ""));
          await db.insert(media).values({
            id: uid(),
            userId: acct.userId,
            name,
            url,
            sizeBytes: 0,
            mimeType: type === "VIDEO" ? "video/mp4" : "image/jpeg",
            durationMs: null,
            mediaKey: key,
            accountId: acct.id,
            mediaType: type,
            createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
          });
          synced++;
        }
      } else {
        // cookie-only account: sync the user's own X media tab with the session
        const { items, error } = await fetchUserMediaCookies(acct.sessionJson);
        if (error) {
          errors.push(`${acct.handle}: ${error}`);
          continue;
        }
        for (const it of items) {
          const dup = await db.select().from(media)
            .where(and(eq(media.mediaKey, it.key), eq(media.accountId, acct.id))).limit(1);
          if (dup.length > 0) {
            skipped++;
            continue;
          }
          await db.insert(media).values({
            id: uid(),
            userId: acct.userId,
            name: it.name,
            url: it.url,
            sizeBytes: 0,
            mimeType: it.type === "VIDEO" ? "video/mp4" : "image/jpeg",
            durationMs: null,
            mediaKey: it.key,
            accountId: acct.id,
            mediaType: it.type,
            createdAt: it.createdAt ?? Date.now(),
          });
          synced++;
        }
      }
    } catch (e) {
      errors.push(`${acct.handle}: ${(e as Error).message ?? String(e)}`);
    }
  }

  return { synced, skipped, errors };
}