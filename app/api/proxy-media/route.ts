// GET /api/proxy-media?u=<twimg url | vercel blob url>
// twimg: streams video.twimg.com / pbs.twimg.com through the panel so the
// BROWSER never sends a cross-origin Referer (twimg 403s those). Range
// requests are forwarded so <video preload="metadata"> thumbnails work.
// Blob: the store is PRIVATE — unsigned GETs are rejected by the CDN — so for
// blob URLs this route 302-redirects to a short-lived presigned URL
// (issueSignedToken -> presignUrl, @vercel/blob 2.x). One delegation token is
// issued per hour and cached module-level; presigning itself is local HMAC
// (no network), so library renders stay fast.
import { issueSignedToken, presignUrl } from "@vercel/blob";

const TWIMG_RE = /^https:\/\/(video|pbs)\.twimg\.com\//;
const BLOB_RE = /^https:\/\/[a-z0-9-]+\.private\.blob\.vercel-storage\.com\//;
const BLOB_PUBLIC_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//;

type Issued = {
  clientSigningToken: string;
  delegationToken: string;
  validUntil: number;
};

let delegation: Issued | null = null;

async function getDelegation(): Promise<Issued> {
  if (delegation && delegation.validUntil > Date.now() + 120_000) return delegation;
  const t = await issueSignedToken({
    operations: ["get", "head"],
    validUntil: Date.now() + 3_600_000,
  });
  delegation = t;
  return t;
}

// Netlify edge-cache poison guard: this route MUST never be cached. A single
// public,max-age=86400 response once poisoned the edge for ALL proxy-media
// URLs (query string ignored) — every library video rendered one JPEG.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const res = await handle(req);
  res.headers.set("cache-control", "private, no-store, max-age=0");
  return res;
}

async function handle(req: Request) {
  const u = new URL(req.url).searchParams.get("u");
  if (!u) return new Response("bad url", { status: 400 });

  // Private blob: stream server-side with the store token (presign path was
  // 500ing; direct authenticated GET supports Range and is simpler).
  if (BLOB_RE.test(u)) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return new Response("no blob token", { status: 501 });
    }
    const range = req.headers.get("range") ?? undefined;
    const up = await fetch(u, {
      headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`, ...(range ? { range } : {}) },
      cache: "no-store",
    });
    if (!up.ok && up.status !== 206) {
      return new Response(`blob upstream ${up.status}`, { status: 502 });
    }
    const h = new Headers();
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = up.headers.get(k);
      if (v) h.set(k, v);
    }
    h.set("cache-control", "private, max-age=0, must-revalidate");
    return new Response(up.body, { status: up.status, headers: h });
  }

  if (!TWIMG_RE.test(u) && !BLOB_PUBLIC_RE.test(u)) {
    return new Response("bad url", { status: 400 });
  }

  const range = req.headers.get("range") ?? undefined;
  const up = await fetch(u, {
    headers: range ? { range } : undefined,
    redirect: "follow",
    cache: "no-store",
  });
  const h = new Headers();
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("cache-control", "private, max-age=0, must-revalidate");
  return new Response(up.body, { status: up.status, headers: h });
}
