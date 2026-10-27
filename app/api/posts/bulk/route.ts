import { db, initDb } from "@/lib/db";
import { accounts, media } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { getUser, json } from "@/lib/reqAuth";
import { runFanout } from "@/lib/fanout";
import { addResult, createRun, finishRun, getRun, latestRunFor } from "@/lib/runs";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// /api/posts/bulk — ONE post fanned out to MULTIPLE accounts at once.
//
// POST returns a runId IMMEDIATELY (the fan-out keeps running in the
// background) and GET ?runId=… reports progress. Before this, the whole
// fan-out — including the 20-60s cold card build — ran inside the request:
// a dropped connection (browser → Cloudflare → tunnel) meant "Network error"
// in the UI, no job rows, and the user had no idea whether the post had gone
// out. Now a dropped connection costs nothing; the panel just re-attaches.
//
// dry: true (admin only) runs the ENTIRE path — session probe, media resolve,
// card build — but never publishes a tweet. Used to verify posting health.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const { accountIds, all, mediaId, caption, url, title } = body || {};
  const dry = user.role === "admin" && body?.dry === true;
  if (!mediaId) return json({ error: "mediaId required" }, 400);
  if (!Array.isArray(accountIds) && !all) {
    return json({ error: "accountIds (array) or all: true required" }, 400);
  }

  const m = (
    await db.select().from(media).where(eq(media.id, String(mediaId))).limit(1)
  )[0];
  if (!m) return json({ error: "Media not found" }, 404);

  // which accounts may this user fan out to?
  const admin = user.role === "admin";
  if (!admin && m.userId !== user.id) return json({ error: "Not your media" }, 403);
  let targets = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.status, "approved"), eq(accounts.enabled, 1)));

  if (!admin) {
    targets = targets.filter((a) => a.userId === user.id);
    if (Array.isArray(accountIds) && accountIds.length) {
      targets = targets.filter((a) => accountIds.includes(a.id));
    }
  } else if (Array.isArray(accountIds) && accountIds.length) {
    targets = targets.filter((a) => accountIds.includes(a.id));
  }

  if (!targets.length) {
    return json(
      { error: admin ? "No approved+enabled accounts selected" : "No accounts assigned to you yet — ask the admin." },
      403
    );
  }

  const captionTxt = String(caption ?? "").trim();
  const titleTxt = String(title ?? "").trim() || "Learn more";

  // HARD RULE: a post without a Website URL would publish a bare video with no
  // link and no card. That happened once (job with url="") and the user had no
  // way to know. Refuse it here, before any run starts.
  let urlTxt = String(url ?? "").trim().replace(/[.,;]+$/, "");
  if (!urlTxt) {
    const fallback = String(targets[0]?.defaultUrl ?? "").trim();
    urlTxt = fallback;
  }
  if (urlTxt && !/^https?:\/\//i.test(urlTxt)) urlTxt = `https://${urlTxt.replace(/^\/+/, "")}`;
  if (!urlTxt) {
    return json(
      { error: "Website URL is required — a post with no link goes out with no card. Paste your link in the Website URL field and post again." },
      400
    );
  }

  // Kick the fan-out off outside the request and answer instantly. Progress is
  // read back with GET ?runId=… (or ?latest=1 after a client-side hiccup).
  const payload = {
    id: m.id,
    mediaKey: m.mediaKey,
    url: m.url,
    name: m.name,
    accountId: m.accountId,
  };
  const targetRows = targets.map((a) => ({
    id: a.id,
    handle: a.handle,
    sessionJson: a.sessionJson,
    oauth1Json: a.oauth1Json,
    adsAccountId: a.adsAccountId,
    defaultUrl: a.defaultUrl,
    defaultTitle: a.defaultTitle,
    defaultCaption: a.defaultCaption,
  }));

  const run = createRun(user.id, targetRows.length, dry);
  runFanout(run, targetRows, payload, captionTxt, urlTxt, titleTxt, user.id).catch((e) => {
    addResult(run, {
      accountId: "",
      handle: "?",
      status: "failed",
      tweetUrl: null,
      error: String((e as Error)?.message ?? e).slice(0, 300),
    });
    finishRun(run);
  });

  return json({
    runId: run.id,
    dry,
    summary: { total: targetRows.length, done: 0, queued: 0, failed: 0 },
    results: [],
  });
}

export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const u = new URL(req.url);
  const runId = u.searchParams.get("runId") || "";
  const run = runId ? getRun(runId) : latestRunFor(user.id);
  if (!run) return json({ error: "no run" }, 404);
  if (run.userId !== user.id && user.role !== "admin") {
    return json({ error: "Not your run" }, 403);
  }
  return json({
    runId: run.id,
    dry: run.dry,
    status: run.status,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: run.summary,
    results: run.results,
  });
}
