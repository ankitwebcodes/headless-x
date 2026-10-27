import { db, initDb } from "@/lib/db";
import { jobs, accounts, media } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { json } from "@/lib/reqAuth";

// Worker polls this to pick up the oldest queued job.
// Safe JSON.parse — some accounts have empty/invalid oauth1_json; a raw
// JSON.parse("") throws and 500s the whole claim route, stalling ALL jobs.
function safeParse(s: string | null): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
// Returns the job + the secrets the worker needs (cookies, oauth1, ads id, media url).
export async function GET(req: Request) {
  await initDb();
  const auth = req.headers.get("x-worker-token");
  if (auth !== process.env.WORKER_TOKEN) return json({ error: "Unauthorized" }, 401);

  const queued = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "queued"))
    .orderBy(jobs.createdAt);
  if (queued.length === 0) return json({ job: null });

  const job = queued[0];
  const acct = (
    await db.select().from(accounts).where(eq(accounts.id, job.accountId)).limit(1)
  )[0];
  const med = (
    await db.select().from(media).where(eq(media.id, job.mediaId)).limit(1)
  )[0];
  if (!acct || !med) {
    await db
      .update(jobs)
      .set({ status: "failed", error: "account/media missing", updatedAt: Date.now() })
      .where(eq(jobs.id, job.id));
    return json({ job: null });
  }

  return json({
    job: {
      id: job.id,
      caption: job.caption,
      url: job.url,
      title: job.title,
      // Private blob URLs 403 for direct fetches — route through the
      // presigned proxy instead (twimg URLs pass through unchanged).
      mediaUrl: med.url.includes("vercel-storage.com")
        ? `/api/proxy-media?u=${encodeURIComponent(med.url)}`
        : med.url,
      mediaName: med.name,
      mediaKey: med.mediaKey,
      mediaType: med.mediaType,
      handle: acct.handle,
    },
    secrets: {
      sessionJson: safeParse(acct.sessionJson),
      // The X app the browser extension grabs credentials for does NOT have
      // X Ads API access — card creation 403s with UNAUTHORIZED_CLIENT_APPLICATION
      // and the whole post used to fail. Fall back to the shared Ads-enabled
      // "gold" credentials so the worker can still build cards.
      oauth1Json: withGoldOAuth1(safeParse(acct.oauth1Json)),
      adsAccountId: acct.adsAccountId || process.env.GOLD_ADS_ACCOUNT_ID || "",
    },
  });
}

// An account OAuth1 blob is only usable if it carries a consumer_key.
function withGoldOAuth1(own: unknown): unknown {
  if (own && typeof own === "object" && (own as Record<string, unknown>).consumer_key) return own;
  const raw = process.env.GOLD_OAUTH1_JSON;
  if (!raw) return own;
  try {
    return JSON.parse(raw);
  } catch {
    return own;
  }
}