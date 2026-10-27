import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { verifySessionToken, type SessionUser } from "@/lib/auth";

export async function getUser(req: Request): Promise<SessionUser | null> {
  const token = req.headers.get("cookie")?.match(/xp_session=([^;]+)/)?.[1];
  if (!token) return null;
  return verifySessionToken(token);
}

/** Constant-time compare that never throws on length mismatch. */
function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Auth for machine callers — specifically the browser extension that hands over
 * the automation account's X cookies.
 *
 * The extension cannot present the xp_session cookie: it is SameSite=Lax, so a
 * request originating from chrome-extension:// counts as cross-site and the
 * cookie is never attached. Instead the extension sends the shared key in the
 * `x-dm-key` header, compared against DM_INGEST_KEY from .env.local.
 *
 * Falls back to normal cookie auth, so a logged-in browser tab still works.
 */
export async function getUserOrKey(req: Request): Promise<SessionUser | null> {
  const want = process.env.DM_INGEST_KEY;
  const got = req.headers.get("x-dm-key");
  if (want && got && safeEq(got, want)) {
    return { id: "ext-ingest", email: "ext@local", name: "Extension ingest", role: "admin" };
  }
  return getUser(req);
}

/** CORS for the extension origin (chrome-extension:// is an opaque origin). */
export function cors(headers: Record<string, string> = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-dm-key, cookie",
    "access-control-max-age": "86400",
    ...headers,
  };
}

export function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return NextResponse.json(data, { status, headers: extraHeaders });
}
