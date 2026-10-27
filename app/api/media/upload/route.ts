import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { verifySessionToken } from "@/lib/auth";

// Direct-to-Blob upload tokens.
//
// The old flow (POST /api/media with FormData) buffers the whole file inside a
// serverless function, and Vercel hard-caps request bodies at 4.5MB — so any
// real device video failed with FUNCTION_PAYLOAD_TOO_LARGE. This route instead
// hands the browser a short-lived token so it can PUT the file straight into
// Vercel Blob (client `upload()` with multipart: true), never passing through
// a serverless body. The client then registers the result via
// POST /api/media/register to create the DB row.

const MAX_BYTES = 200 * 1024 * 1024;

async function getUser(req: Request) {
  const token = req.headers.get("cookie")?.match(/xp_session=([^;]+)/)?.[1];
  if (!token) return null;
  return verifySessionToken(token);
}

export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Local dev without a Blob store: let the client fall back to the old
  // server-side FormData flow (fine under Node's no-limit bodies).
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "no-blob-token" }, { status: 501 });
  }

  const body = (await req.json()) as HandleUploadBody;
  // Client ping (empty body `{}`): report whether Direct-to-Blob is wired up
  // so the browser picks the blob flow or the legacy FormData fallback.
  if (body && typeof body === "object" && Object.keys(body).length === 0) {
    return NextResponse.json({ blob: true });
  }
  const json = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async () => ({
      addRandomSuffix: true,
      maximumSizeInBytes: MAX_BYTES,
      tokenPayload: JSON.stringify({ userId: user.id }),
    }),
    // Row registration happens client-side via POST /api/media/register, so
    // the Vercel-side completion callback is a no-op here.
    onUploadCompleted: async () => {},
  });
  return NextResponse.json(json);
}
