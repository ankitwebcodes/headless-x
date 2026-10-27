import { NextResponse } from "next/server";
import { db, initDb } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { desc, eq, and } from "drizzle-orm";
import { uid } from "@/lib/auth";
import { getUser, json } from "@/lib/reqAuth";
import { parseXGrabBlob, normalizeOauth, parseCookiesField } from "@/lib/parseBlob";

// List accounts.
//  - admin:  ALL accounts (management view).
//  - user:   ONLY the accounts assigned to them by the admin (approved + enabled).
export async function GET(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const rows =
    user.role === "admin"
      ? await db.select().from(accounts).orderBy(desc(accounts.createdAt))
      : await db
          .select()
          .from(accounts)
          .where(
            and(
              eq(accounts.userId, user.id),
              eq(accounts.status, "approved"),
              eq(accounts.enabled, 1)
            )
          )
          .orderBy(desc(accounts.createdAt));
  // never leak secrets to the browser
  return json({
    accounts: rows.map(({ sessionJson, oauth1Json, ...rest }) => ({
      ...rest,
      hasSession: !!sessionJson,
      hasOauth1: !!oauth1Json,
    })),
  });
}

// Connect an account — ADMIN ONLY (all account setup happens on the admin side).
// SIMPLEST FLOW: paste the X Grabber blob into ONE field — the panel derives
// the handle + cookies, verifies the live identity of whatever was pasted and
// refuses mismatches, so one account can never post as another.

export async function POST(req: Request) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (user.role !== "admin") {
    return json({ error: "Only the admin connects/manages accounts. Users just pick an account and post." }, 403);
  }

  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  let { handle, sessionJson, oauth1Json, adsAccountId, defaultUrl, defaultTitle, defaultCaption, expandedUrl, blob, assignUserId } =
    body;

  // ---- X Grabber blob (the ONE-field flow) ----
  if (blob) {
    const xb = parseXGrabBlob(blob);
    if (xb.error) return json({ error: xb.error }, 400);
    if (xb.handle && !handle) handle = xb.handle;
    if (!sessionJson) sessionJson = xb.cookies;
    if (!oauth1Json && xb.oauth1) oauth1Json = xb.oauth1;
  }

  if (!handle) {
    return json({
      error: "Paste the X Grabber blob (the extension's copied JSON) — the handle is detected automatically.",
    }, 400);
  }

  // ---- parse tolerantly ----
  let sessionParsed: unknown = null;
  if (sessionJson) {
    const sess = parseCookiesField(sessionJson);
    if (sess.error) return json({ error: `sessionJson ❌ ${sess.error} (paste the X Grabber blob)` }, 400);
    sessionParsed = sess.value;
  }
  let oauth1Parsed: unknown = null;
  if (oauth1Json) {
    const oa = normalizeOauth(oauth1Json);
    if (oa.error) return json({ error: `oauth1Json ❌ ${oa.error}` }, 400);
    oauth1Parsed = oa.value;
  }

  const h = String(handle).replace(/^@/, "").trim().toLowerCase();
  const storedSession =
    sessionParsed == null ? "" : (typeof sessionParsed === "string" ? sessionParsed : JSON.stringify(sessionParsed));

  // ---- IDENTITY VERIFICATION (fills in the handle when the admin pasted just a blob) ----
  let oauthOwner: string | null = null;
  if (oauth1Parsed && typeof oauth1Parsed === "object") {
    const o = oauth1Parsed as Record<string, string>;
    if (o.consumer_key && o.access_token) {
      try {
        const { verifyOAuth1 } = await import("@/lib/xpost");
        const who = await verifyOAuth1({ consumer_key: o.consumer_key, consumer_secret: o.consumer_secret || "", access_token: o.access_token, access_token_secret: o.access_token_secret || "" });
        if (who) {
          oauthOwner = who.screen_name.toLowerCase();
          if (h && oauthOwner !== h) {
            return json({
              error: `❌ That OAuth1 token belongs to @${who.screen_name}, NOT @${h}. Connect that account instead (or label this one @${who.screen_name}).`,
            }, 400);
          }
        }
      } catch (e) {
        return json({ error: `OAuth1 verify failed: ${(e as Error).message?.slice(0, 200)}` }, 400);
      }
    }
  }
  let sessionOwner: string | null = null;
  let sessionAlive = false;
  if (sessionParsed) {
    try {
      const { probeSession } = await import("@/lib/xpost");
      const p = await probeSession(storedSession);
      if (p.ok && p.username) {
        sessionAlive = true;
        sessionOwner = p.username.toLowerCase();
        if (h && sessionOwner !== h) {
          return json({
            error: `❌ These cookies belong to @${p.username}, NOT @${h}. Grab the blob while logged into the account you're connecting.`,
          }, 400);
        }
      }
    } catch { /* stale cookies — still allow storage so refresh can happen later */ }
  }

  const finalHandle = h || oauthOwner || sessionOwner || "";
  if (!finalHandle) {
    return json({
      error: "Couldn't detect the handle. Grab a FRESH blob while logged into that X account (cookies must be live for verification).",
    }, 400);
  }

  const secret = oauth1Parsed || sessionAlive ? "ok" : "missing";
  if (secret === "missing") {
    return json({
      error: "Couldn't verify any live identity. Grab a fresh blob while logged into X as that account (the extension captures everything in one click).",
    }, 400);
  }

  const oauth1Stored = oauth1Parsed == null ? "" : (typeof oauth1Parsed === "string" ? oauth1Parsed : JSON.stringify(oauth1Parsed));

  // Same handle already connected? → refresh in place (status + settings preserved)
  const existing = (
    await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.handle, finalHandle)))
      .limit(1)
  )[0];
  if (existing) {
    await db
      .update(accounts)
      .set({
        sessionJson: storedSession,
        oauth1Json: oauth1Stored || existing.oauth1Json,
        adsAccountId: adsAccountId ? String(adsAccountId) : existing.adsAccountId,
        defaultUrl: expandedUrl ? String(expandedUrl) : defaultUrl ? String(defaultUrl) : existing.defaultUrl,
        defaultTitle: defaultTitle ? String(defaultTitle) : existing.defaultTitle,
        defaultCaption: defaultCaption ? String(defaultCaption) : existing.defaultCaption,
        userId: assignUserId ? String(assignUserId) : existing.userId,
      })
      .where(eq(accounts.id, existing.id));
    return json({
      account: { ...existing, sessionJson: undefined, oauth1Json: undefined, hasSession: !!storedSession, hasOauth1: !!oauth1Stored },
      refreshed: true,
      note: `@${finalHandle} refreshed — verified as @${oauthOwner ?? sessionOwner ?? finalHandle}, status unchanged (${existing.status}).`,
    });
  }

  const row = {
    id: uid(),
    userId: assignUserId ? String(assignUserId) : user.id,
    handle: finalHandle,
    sessionJson: storedSession,
    oauth1Json: oauth1Stored,
    adsAccountId: adsAccountId ? String(adsAccountId) : "",
    defaultUrl: expandedUrl ? String(expandedUrl) : defaultUrl ? String(defaultUrl) : "",
    defaultTitle: defaultTitle ? String(defaultTitle) : finalHandle,
    defaultCaption: defaultCaption ? String(defaultCaption) : null,
    status: "approved" as const, // admin-added accounts are ready immediately
    enabled: 1 as const,
    createdAt: Date.now(),
  };
  await db.insert(accounts).values(row);
  return json({
    account: { ...row, sessionJson: undefined, oauth1Json: undefined, hasSession: !!storedSession, hasOauth1: !!oauth1Stored },
    note: `✅ @${finalHandle} added — verified as @${oauthOwner ?? sessionOwner ?? finalHandle}, ready to post.`,
  });
}
