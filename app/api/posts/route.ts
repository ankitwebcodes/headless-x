import { db, initDb } from "@/lib/db";
import { accounts, media } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getUser, json } from "@/lib/reqAuth";
import { attemptPost } from "@/lib/postOne";

// ---------------------------------------------------------------------------
// POST /api/posts — instant single-account post (card + tweet, no queue wait).
// One video+link → ONE account. For many accounts at once use /api/posts/bulk.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const { accountId, mediaId, caption, url, title } = body || {};
  if (!accountId || !mediaId) return json({ error: "accountId and mediaId required" }, 400);

  const acct = (
    await db.select().from(accounts).where(eq(accounts.id, String(accountId))).limit(1)
  )[0];
  if (!acct) return json({ error: "Account not found" }, 404);
  if (acct.status !== "approved") return json({ error: "Account not approved by admin yet" }, 403);
  if (acct.enabled !== 1) return json({ error: "Account is disabled by admin" }, 403);
  if (acct.userId !== user.id && user.role !== "admin") {
    return json({ error: "Not your account" }, 403);
  }

  const m = (
    await db.select().from(media).where(eq(media.id, String(mediaId))).limit(1)
  )[0];
  if (!m) return json({ error: "Media not found" }, 404);
  if (m.accountId && m.accountId !== acct.id) {
    return json({ error: "That video belongs to a different account — pick a video from the selected account's library" }, 403);
  }
  if (!m.accountId && m.userId !== user.id && user.role !== "admin") {
    return json({ error: "Not your media" }, 403);
  }

  const captionTxt = String(caption ?? acct.defaultCaption ?? "").trim();
  const urlTxt = String(url ?? acct.defaultUrl ?? "").trim();
  const titleTxt = String(title ?? acct.defaultTitle ?? "").trim() || "Learn more";

  const result = await attemptPost(acct, m, captionTxt, urlTxt, titleTxt, user.id).catch(
    (e) => ({
      accountId: acct.id,
      handle: acct.handle,
      status: "failed" as const,
      tweetUrl: null,
      error: String((e as Error)?.message ?? e).slice(0, 300),
    })
  );

  if (result.status === "failed") {
    return json({ job: result, status: "failed", error: result.error }, 400);
  }
  return json({
    job: result,
    status: result.status,
    tweetUrl: result.tweetUrl,
    note: result.status === "queued"
      ? "Video is being stored into the X media library first — it posts automatically as soon as it's up."
      : undefined,
  });
}
