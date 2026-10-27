import { db, initDb } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getUser, json } from "@/lib/reqAuth";

// Admin manages an account: approve | reject | enable | disable | test | delete | update
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await initDb();
  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (user.role !== "admin") return json({ error: "Admin only" }, 403);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body?.action as string;

  const acct = (
    await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
  )[0];
  if (!acct) return json({ error: "Account not found" }, 404);

  if (action === "delete") {
    await db.delete(accounts).where(eq(accounts.id, id));
    return json({ ok: true, deleted: true });
  }

  if (action === "approve") {
    await db.update(accounts).set({ status: "approved" }).where(eq(accounts.id, id));
    return json({ ok: true, status: "approved" });
  }
  if (action === "reject") {
    await db.update(accounts).set({ status: "rejected" }).where(eq(accounts.id, id));
    return json({ ok: true, status: "rejected" });
  }
  if (action === "enable") {
    await db.update(accounts).set({ enabled: 1 }).where(eq(accounts.id, id));
    return json({ ok: true, enabled: 1 });
  }
  if (action === "disable") {
    await db.update(accounts).set({ enabled: 0 }).where(eq(accounts.id, id));
    return json({ ok: true, enabled: 0 });
  }

  if (action === "test") {
    // live-check the stored session + OAuth1 without touching the row
    const result: Record<string, unknown> = { ok: true };
    try {
      const { probeSession, verifyOAuth1 } = await import("@/lib/xpost");
      const sessProbe = acct.sessionJson
        ? await probeSession(acct.sessionJson).catch(() => ({ ok: false as const, reason: "probe error" }))
        : { ok: false as const, reason: "no cookies stored" };
      result.session = sessProbe;
      let oauthProbe: { ok: boolean; screen?: string; reason?: string } = { ok: false, reason: "no oauth1 stored" };
      try {
        const creds = acct.oauth1Json ? JSON.parse(acct.oauth1Json) : null;
        if (creds?.consumer_key && creds?.access_token) {
          const who = await verifyOAuth1({
            consumer_key: String(creds.consumer_key),
            consumer_secret: String(creds.consumer_secret ?? ""),
            access_token: String(creds.access_token),
            access_token_secret: String(creds.access_token_secret ?? ""),
          });
          oauthProbe = who ? { ok: true, screen: who.screen_name } : { ok: false, reason: "rejected by X" };
        }
      } catch {
        oauthProbe = { ok: false, reason: "bad oauth1 json" };
      }
      result.oauth1 = oauthProbe;
    } catch (e) {
      result.error = (e as Error).message;
    }
    return json(result);
  }

  if (action === "assign") {
    const target = String(body?.userId || "").trim();
    if (!target) return json({ error: "userId required (empty string = unassign to admin)" }, 400);
    await db.update(accounts).set({ userId: target }).where(eq(accounts.id, id));
    return json({ ok: true, assignedTo: target });
  }

  if (action === "update") {
    const patch: Record<string, unknown> = {};
    if (body.defaultUrl !== undefined) patch.defaultUrl = String(body.defaultUrl);
    if (body.defaultTitle !== undefined) patch.defaultTitle = String(body.defaultTitle);
    if (body.defaultCaption !== undefined) patch.defaultCaption = body.defaultCaption ? String(body.defaultCaption) : null;
    if (body.adsAccountId !== undefined) patch.adsAccountId = String(body.adsAccountId);

    // ── session + OAuth1 refresh ──
    // Admin pastes a fresh X Grabber blob (or raw cookies / raw OAuth1) to
    // refresh the stored credentials for an existing account without
    // re-connecting from scratch.
    if (body.blob !== undefined) {
      const { parseXGrabBlob } = await import("@/lib/parseBlob");
      const xb = parseXGrabBlob(body.blob);
      if (xb.error) return json({ error: xb.error }, 400);
      if (xb.cookies) patch.sessionJson = typeof xb.cookies === "string" ? xb.cookies : JSON.stringify(xb.cookies);
      if (xb.oauth1) patch.oauth1Json = typeof xb.oauth1 === "string" ? xb.oauth1 : JSON.stringify(xb.oauth1);
    }
    if (body.sessionJson !== undefined && body.sessionJson !== null && String(body.sessionJson).trim()) {
      patch.sessionJson = String(body.sessionJson);
    }
    if (body.oauth1Json !== undefined && body.oauth1Json !== null && String(body.oauth1Json).trim()) {
      // tolerate raw key=secret pairs or JSON
      const { normalizeOauth } = await import("@/lib/parseBlob");
      const oa = normalizeOauth(body.oauth1Json);
      if (oa.error) return json({ error: `oauth1Json ❌ ${oa.error}` }, 400);
      patch.oauth1Json = typeof oa.value === "string" ? oa.value : JSON.stringify(oa.value);
    }

    if (Object.keys(patch).length) {
      await db.update(accounts).set(patch).where(eq(accounts.id, id));
    }
    return json({ ok: true, updated: Object.keys(patch) });
  }

  return json({ error: "action must be approve | reject | enable | disable | test | update | delete" }, 400);
}