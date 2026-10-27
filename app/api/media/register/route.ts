import { NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { media, accountMedia, accounts } from "@/lib/schema";
import { uid, verifySessionToken } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { warmAdsMedia } from "@/lib/postOne";

// Registers a Direct-to-Blob upload as a media row.
// The browser uploads the file straight into Vercel Blob (via /api/media/upload
// tokens) and then calls this with the resulting blob URL — no file bytes ever
// pass through a serverless function, so there is no 4.5MB body limit.

const MAX_BYTES = 200 * 1024 * 1024;

export async function POST(req: Request) {
  await initDb();

  const token = req.headers.get("cookie")?.match(/xp_session=([^;]+)/)?.[1];
  const user = token ? await verifySessionToken(token) : null;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = (await req.json().catch(() => null)) as {
    name?: string; url?: string; sizeBytes?: number; mimeType?: string;
    accountIds?: string[];
  } | null;
  const url = (b?.url ?? "").trim();
  const sizeBytes = Number(b?.sizeBytes ?? 0);
  if (!url.startsWith("https://")) {
    return NextResponse.json({ error: "missing url" }, { status: 400 });
  }
  if (!sizeBytes || sizeBytes < 0 || sizeBytes > MAX_BYTES) {
    return NextResponse.json({ error: "bad sizeBytes" }, { status: 400 });
  }

  const targets = Array.isArray(b?.accountIds)
    ? Array.from(new Set(b.accountIds.map((x) => String(x).trim()).filter(Boolean)))
    : [];
  if (!targets.length) return NextResponse.json({ error: "Select an account before uploading" }, { status: 400 });
  const permitted = user.role === "admin"
    ? await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.status, "approved"), eq(accounts.enabled, 1)))
    : await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, user.id), eq(accounts.status, "approved"), eq(accounts.enabled, 1)));
  const permittedIds = new Set(permitted.map((a) => a.id));
  if (targets.some((id) => !permittedIds.has(id))) {
    return NextResponse.json({ error: "One or more target accounts are unavailable" }, { status: 403 });
  }

  const row = {
    id: uid(),
    userId: user.id,
    name: (b?.name ?? "upload").slice(0, 200),
    url,
    sizeBytes,
    mimeType: b?.mimeType || "video/mp4",
    durationMs: null as number | null,
    accountId: targets.length === 1 ? targets[0] : null,
    mediaKey: null as string | null,  // worker fills this when pushing into the X library
    mediaType: (b?.mimeType || "video/mp4").startsWith("video") ? "VIDEO" : "IMAGE",
    createdAt: Date.now(),
  };
  await db.insert(media).values(row);
  const pendingRows = targets.map((acctId) => ({
    id: uid(),
    mediaId: row.id,
    accountId: acctId,
    mediaKey: null as string | null,
    createdAt: Date.now(),
  }));
  if (pendingRows.length) await db.insert(accountMedia).values(pendingRows);

  // PRE-WARM the ads library with this video NOW, in the background.
  //
  // The ads-library media object is link-independent (it holds only the video),
  // so it can be uploaded before the user has even picked a link. Doing it here
  // turns the composer's later card build from ~25-60s into ~1s — which is what
  // makes "card ready ✓" appear immediately instead of the user watching a
  // 3-minute spinner and then getting posts that time out.
  warmAdsMedia(null, row.id, row.url).catch(() => {});

  return NextResponse.json({ media: row, pendingAccounts: pendingRows.length });

}
