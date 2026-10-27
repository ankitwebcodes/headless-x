# Edits for per-account mediaKey (autoupload + instant post)
import re, sys

def rd(p):
    with open(p, "r", encoding="utf-8") as f: return f.read()

def wr(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f: f.write(s)
    print("wrote", p)

ROOT = r"C:/Users/ankit/x_panel"

# ---------- 1. schema.ts: accountMedia table ----------
p = ROOT + "/lib/schema.ts"
s = rd(p)
assert "accountMedia" not in s, "already patched"
s = s.replace(
    'import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";',
    'import { pgTable, text, integer, bigint, uniqueIndex } from "drizzle-orm/pg-core";'
)
s += """
// Per-account media keys: media keys are per-account in X, so a video
// uploaded from the panel gets pushed into EACH target account's real X
// media library. Post routes resolve the key per (account, media) first.
export const accountMedia = pgTable(
  "account_media",
  {
    id: text("id").primaryKey(),
    mediaId: text("media_id").notNull(),
    accountId: text("account_id").notNull(),
    mediaKey: text("media_key"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({ amIdx: uniqueIndex("account_media_am_idx").on(t.accountId, t.mediaId) })
);
"""
wr(p, s)

# ---------- 2. register route: create account_media rows ----------
p = ROOT + "/app/api/media/register/route.ts"
s = rd(p)
s = s.replace(
    'import { media } from "@/lib/schema";',
    'import { media, accountMedia, accounts } from "@/lib/schema";'
).replace(
    'import { uid, verifySessionToken } from "@/lib/auth";',
    'import { uid, verifySessionToken } from "@/lib/auth";\nimport { eq, and } from "drizzle-orm";'
)
s = s.replace(
    """  const b = (await req.json().catch(() => null)) as {
    name?: string; url?: string; sizeBytes?: number; mimeType?: string;
  } | null;""",
    """  const b = (await req.json().catch(() => null)) as {
    name?: string; url?: string; sizeBytes?: number; mimeType?: string;
    accountIds?: string[];
  } | null;"""
)
s = s.replace(
    """  await db.insert(media).values(row);
  return NextResponse.json({ media: row });""",
    """  await db.insert(media).values(row);

  // Target accounts: caller-supplied list, otherwise every approved account.
  let targets = (b?.accountIds ?? []).map((x) => String(x)).filter(Boolean);
  if (!targets.length) {
    const approved = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.status, "approved")));
    targets = approved.map((a) => a.id);
  } else {
    // Only allow this user's accounts.
    const mine = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    const mineIds = new Set(mine.map((a) => a.id));
    targets = targets.filter((t) => mineIds.has(t));
  }
  const pendingRows = targets.map((acctId) => ({
    id: uid(),
    mediaId: row.id,
    accountId: acctId,
    mediaKey: null as string | null,
    createdAt: Date.now(),
  }));
  if (pendingRows.length) await db.insert(accountMedia).values(pendingRows);

  return NextResponse.json({ media: row, pendingAccounts: pendingRows.length });"""
)
wr(p, s)

# ---------- 3. pending-uploads route: account_media driven, fail-soft ----------
p = ROOT + "/app/api/worker/pending-uploads/route.ts"
s = """import { db, initDb } from "@/lib/db";
import { accounts, accountMedia, media } from "@/lib/schema";
import { eq, isNull } from "drizzle-orm";
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
    .where(isNull(accountMedia.mediaKey))
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
    uploads.push({
      id: m.id,
      name: m.name,
      url: m.url,
      accountId: acct.id,
      handle: acct.handle,
      adsAccountId: acct.adsAccountId,
      sessionJson,
    });
  }
  return json({ uploads });
}
"""
wr(p, s)

# ---------- 4. uploaded route: per-account upsert ----------
p = ROOT + "/app/api/worker/uploaded/route.ts"
s = """import { db, initDb } from "@/lib/db";
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
"""
wr(p, s)

# ---------- 5. postOne.ts: instant per-account upload before queueing ----------
p = ROOT + "/lib/postOne.ts"
s = rd(p)
old = """  // No mediaKey -> needs upload into the real X library first -> queue for worker
  if (!m.mediaKey) {
    const now = Date.now();
    const jobId = uid();
    const jobRow = {
      id: jobId,
      userId,
      accountId: acct.id,
      mediaId: m.id,
      caption: captionTxt,
      url: urlTxt,
      title: titleTxt,
      status: "queued" as const,
      tweetUrl: null,
      error: null,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(jobs).values(jobRow);
    return { ...base, status: "queued", tweetUrl: null, error: null, jobId, path: "worker-upload" };
  }

  // Optional OAuth1 (parsed BEFORE the probe - the fallback path needs it)
  let creds: OAuth1Creds | null = null;
  try {
    const parsed = JSON.parse(acct.oauth1Json);
    if (parsed?.consumer_key && parsed?.access_token) {
      creds = {
        consumer_key: String(parsed.consumer_key),
        consumer_secret: String(parsed.consumer_secret ?? ""),
        access_token: String(parsed.access_token),
        access_token_secret: String(parsed.access_token_secret ?? ""),
      };
    }
  } catch {
    /* no oauth1 */
  }
"""
# Note: file uses "->" arrow comments with actual unicode? Original had "—" style dashes? Original text: 'needs upload into the real X library first → queue for worker'
old = old.replace("first -> queue for worker", "first \u2192 queue for worker")
old = old.replace("(parsed BEFORE the probe - the fallback path needs it)", "(parsed BEFORE the probe \u2014 the fallback path needs it)")
if old not in s:
    print("postOne old block NOT FOUND verbatim; dumping region"); print(s[s.find("No mediaKey")-100:s.find("No mediaKey")+2400]); sys.exit(1)
new = """  // Optional OAuth1 (parsed BEFORE everything \u2014 the instant-upload path needs it)
  let creds: OAuth1Creds | null = null;
  try {
    const parsed = JSON.parse(acct.oauth1Json);
    if (parsed?.consumer_key && parsed?.access_token) {
      creds = {
        consumer_key: String(parsed.consumer_key),
        consumer_secret: String(parsed.consumer_secret ?? ""),
        access_token: String(parsed.access_token),
        access_token_secret: String(parsed.access_token_secret ?? ""),
      };
    }
  } catch {
    /* no oauth1 */
  }

  // Per-account mediaKey first (panel uploads push per-account; ads-synced
  // keys live on the media row itself).
  try {
    const r = await db.execute(
      sql`select media_key from account_media where media_id = ${m.id} and account_id = ${acct.id} limit 1`
    );
    const row = (r as { rows?: Array<{ media_key?: unknown }> }).rows?.[0];
    if (row?.media_key) m.mediaKey = String(row.media_key);
  } catch {
    /* table may not exist yet \u2014 fall through */
  }

  // Still no key \u2192 INSTANT path: upload straight into THIS account's X media
  // library (worker may not have pre-warmed yet). Only queue as a last resort.
  if (!m.mediaKey && creds) {
    try {
      const upId = await uploadMediaOAuth1(creds, m.url);
      if (upId) {
        m.mediaKey = `13_${upId}`;
        try {
          await db.execute(
            sql`insert into account_media (id, media_id, account_id, media_key, created_at)
                values (${randomUUID()}, ${m.id}, ${acct.id}, ${m.mediaKey}, ${Date.now()})
                on conflict (account_id, media_id) do update set media_key = ${m.mediaKey}`
          );
        } catch { /* best-effort cache */ }
      }
    } catch {
      /* fall through to worker queue */
    }
  }

  // FINAL fallback: queue for the background worker (worker-upload path).
  if (!m.mediaKey) {
    const now = Date.now();
    const jobId = uid();
    const jobRow = {
      id: jobId,
      userId,
      accountId: acct.id,
      mediaId: m.id,
      caption: captionTxt,
      url: urlTxt,
      title: titleTxt,
      status: "queued" as const,
      tweetUrl: null,
      error: null,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(jobs).values(jobRow);
    return { ...base, status: "queued", tweetUrl: null, error: null, jobId, path: "worker-upload" };
  }
"""
s = s.replace(old, new)
assert "FINAL fallback: queue for the background worker" in s
wr(p, s)

# ---------- 6. worker.py: fail-soft per item ----------
p = ROOT + "/worker/worker.py"
s = rd(p)
old = """    for u in up.get("uploads", []):
        log(f"[worker] uploading {u['name']} -> X library of @{u['handle']}")
        sys.path.insert(0, PIPELINE)
        import config as pcfg
        import prep, upload
        tmp_profile = os.path.join(pcfg.PROFILES, f"_panel_{u['handle']}")
        session_file, _ = write_profile(tmp_profile, u["sessionJson"], {}, u["handle"],
                                        u["adsAccountId"], "", "")
        media_path = os.path.join(HERE, "tmp", "up_" + u["id"] + ".mp4")
        os.makedirs(os.path.dirname(media_path), exist_ok=True)
        try:
"""
assert old in s, "worker.py block not found"
new = """    for u in up.get("uploads", []):
        log(f"[worker] uploading {u['name']} -> X library of @{u['handle']}")
        media_path = os.path.join(HERE, "tmp", "up_" + u["id"] + ".mp4")
        os.makedirs(os.path.dirname(media_path), exist_ok=True)
        try:
            sys.path.insert(0, PIPELINE)
            import config as pcfg
            import prep, upload
            tmp_profile = os.path.join(pcfg.PROFILES, f"_panel_{u['handle']}")
            session_file, _ = write_profile(tmp_profile, u["sessionJson"], {}, u["handle"],
                                            u["adsAccountId"], "", "")
"""
s = s.replace(old, new)
wr(p, s)
print("ALL EDITS OK")
