import { db, initDb } from "@/lib/db";
import { media } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getUser, json } from "@/lib/reqAuth";
import { cardStatus, ensureCard } from "@/lib/postOne";
import { getPrep, markReady, prepKey, startPrep } from "@/lib/prep";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// /api/posts/prepare — warm the website-card for a (video, link) pair.
//
// Card creation uploads the video into the X ads library and takes ~10-60s.
// Doing it when the user PICKS the video (not when they click Post) keeps the
// actual post under a few seconds, which is what makes posting survive a
// flaky browser → Cloudflare → tunnel hop.
//
// NOTE: videos uploaded through the panel are pre-warmed into the ads library
// at UPLOAD time (see /api/media/register), so this is normally instant.
//
//   GET  ?mediaId=&url=          → { ready, status, error?, elapsedMs }
//   POST { mediaId, url, title }  → { status: "ready" | "warming" | "failed", error? }
// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  const t = raw.trim().replace(/[.,;]+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, "")}`;
}

export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const u = new URL(req.url);
  const mediaId = u.searchParams.get("mediaId") || "";
  const url = normalizeUrl(u.searchParams.get("url") || "");
  if (!mediaId || !url) return json({ ready: false, status: "idle", error: "mediaId+url required" }, 400);
  const m = (await db.select().from(media).where(eq(media.id, mediaId)).limit(1))[0];
  if (!m) return json({ error: "Media not found" }, 404);

  if (await cardStatus(m.mediaKey, m.id, url)) {
    markReady(prepKey(m.id, url));
    return json({ ready: true, status: "ready" });
  }

  // Report the in-flight build honestly instead of making the UI poll blind.
  const st = getPrep(prepKey(m.id, url));
  if (!st) return json({ ready: false, status: "idle" });
  return json({
    ready: st.status === "ready",
    status: st.status,
    error: st.error,
    elapsedMs: Date.now() - st.startedAt,
  });
}

export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const body = await req.json().catch(() => null);
  const mediaId = String(body?.mediaId ?? "");
  const url = normalizeUrl(String(body?.url ?? ""));
  const title = String(body?.title ?? "").trim();
  if (!mediaId || !url) return json({ status: "failed", error: "mediaId+url required" }, 400);

  const m = (await db.select().from(media).where(eq(media.id, mediaId)).limit(1))[0];
  if (!m) return json({ error: "Media not found" }, 404);
  if (user.role !== "admin" && m.userId !== user.id) return json({ error: "Not your media" }, 403);

  if (await cardStatus(m.mediaKey, m.id, url)) {
    markReady(prepKey(m.id, url));
    return json({ status: "ready" });
  }

  // Already building (or just failed — the registry remembers the reason
  // briefly so a retry can be explicit rather than a silent 3-minute wait).
  const existing = getPrep(prepKey(m.id, url));
  if (existing && existing.status === "warming") {
    return json({ status: "warming", elapsedMs: Date.now() - existing.startedAt });
  }
  if (existing && existing.status === "failed") {
    return json({ status: "failed", error: existing.error });
  }

  // Fire and forget — the composer polls GET until ready.
  startPrep(prepKey(m.id, url), () => ensureCard(m.mediaKey, m.url, url, title || "Learn more", m.id));
  return json({ status: "warming" });
}
