import { randomUUID } from "node:crypto";
import { getUser, json, cors } from "@/lib/reqAuth";
import { createDmIngestKey, dmIngestOwner } from "@/lib/dm-auth";
import { listSessions, saveSession, getSession, legacySessions,readDmDoc, updateDmDoc, updateSessionSettings } from "@/lib/dm-store";
import {removeDmAccount} from "@/lib/dm-run";
import { normalizeDmCookies } from "@/lib/dm-core";
import { verifyDmSession } from "@/lib/xdm";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function canAdoptLegacy(owner: string) {
  if (process.env.DM_INGEST_OWNER_ID) return process.env.DM_INGEST_OWNER_ID === owner;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return false;
  const { neon } = await import("@neondatabase/serverless");
  const admins = await neon(url)`SELECT id FROM users WHERE role='admin' LIMIT 2`;
  return admins.length === 1 && admins[0].id === owner;
}
async function claimLegacy(owner: string) {
  await updateDmDoc<{ owner: string }>("system", "legacy-owner", () => ({ owner }), old => {
    if (old.owner !== owner) throw new Error("Legacy sessions have already been assigned to another administrator.");
    return old;
  });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers: cors() }); }
export async function GET(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false, error: "Unauthorized" },401);
  try {
    let rows = await listSessions(user.id);
    const legacy = user.role === "admin" ? await legacySessions() : [];
    const adoption=rows.length?null:await readDmDoc<{manualRemoval:boolean}>(user.id,"legacy-adoption");
    // Preserve the existing single-admin/single-account installation on upgrade.
    // Multiple-admin installations retain the explicit import action.
    if (!rows.length && !adoption?.manualRemoval && legacy.length === 1 && user.role === "admin" && await canAdoptLegacy(user.id)) {
      await claimLegacy(user.id);
      const old = legacy[0];
      const probe = await verifyDmSession(old.sessionJson);
      if (probe.ok && probe.id) {
        await saveSession(user.id,{ ...old,id: old.id || `x_${probe.id}`,xUserId: probe.id,handle: probe.username ?? "" });
        rows = await listSessions(user.id);
      }
    }
    return json({ ok: true, maxAccounts: 12, workerEnabled: !!process.env.DM_WORKER_KEY,
      canImportLegacy: legacy.length > 0,
      sessions: rows.map(({ sessionJson: _s, passcode, ...row }) => ({ ...row, hasPasscode: !!passcode, chatCapability: "legacy_only" })) });
  } catch (e) { return json({ ok: false, error: (e as Error).message },500); }
}
export async function POST(req: Request) {
  const owner = await dmIngestOwner(req);
  if (!owner) return json({ ok: false, error: "Unauthorized. Pair the extension from this login's DM panel." },401,cors());
  const body = await req.json().catch(() => ({}));
  try {
    if(body.passcode!==undefined&&String(body.passcode).trim()!==""&&!/^\d{4}$/.test(String(body.passcode).trim()))
      return json({ok:false,error:"X Chat passcode must be exactly 4 digits."},400,cors());
    const user = await getUser(req);
    if (body.action === "pair") {
      if (!user) return json({ ok: false, error: "Panel login required" },403);
      return json({ ok: true, key: createDmIngestKey(user.id) });
    }
    if (body.action === "importLegacy") {
      if (user?.role !== "admin") return json({ ok: false, error: "Administrator required" },403);
      await claimLegacy(owner);
      const imported: string[] = [];
      const errors: string[] = [];
      const started = Date.now();
      for (const old of await legacySessions()) {
        if (Date.now() - started > 30000) break;
        const probe = await verifyDmSession(old.sessionJson);
        if (!probe.ok || !probe.id) { errors.push(`${old.label}: ${probe.reason}`); continue; }
        const saved = await saveSession(owner, { ...old, id: old.id || randomUUID(), xUserId: probe.id, handle: probe.username ?? "" });
        imported.push(saved.id);
      }
      return json({ ok: true, imported, errors });
    }
    if (body.action === "settings") {
      if (!user) return json({ ok: false, error: "Panel login required" },403);
      const old = await getSession(owner,String(body.id));
      if (!old) return json({ ok: false, error: "Account not found" },404);
      const saved = await updateSessionSettings(owner,old.id,body.label === undefined ? undefined : String(body.label).slice(0,100),
        body.passcode === undefined ? undefined : String(body.passcode).trim());
      return json({ ok: true, id: old.id, hasPasscode: !!saved?.passcode });
    }
    const cookies = normalizeDmCookies(body.cookies ?? body.sessionJson ?? body.session);
    if (!["auth_token","ct0"].every(name => cookies.some(c => c.name === name && c.value)))
      return json({ ok: false, error: "Missing auth_token / ct0." },400,cors());
    const probe = await verifyDmSession(cookies);
    if (!probe.ok || !probe.id) return json({ ok: false, error: probe.reason || "X identity verification failed." },400,cors());
    // Old extension versions default to id=automation. Identify those saves by
    // verified X user, so connecting a second account cannot replace the first.
    const existing = body.id && body.id !== "automation" ? await getSession(owner,String(body.id)) : null;
    const requested = existing?.id ?? `x_${probe.id}`;
    const saved = await saveSession(owner, { id: requested, label: String(body.label || `@${probe.username}`).slice(0,100),
      sessionJson: cookies, passcode: body.passcode === undefined ? undefined : String(body.passcode).trim(),
      xUserId: probe.id, handle: probe.username ?? "" });
    return json({ ok: true, id: saved.id, label: saved.label, live: true, username: saved.handle, userId: saved.xUserId,
      cookieCount: cookies.length, hasPasscode: !!saved.passcode, updatedAt: saved.updatedAt },200,cors());
  } catch (e) { return json({ ok: false, error: (e as Error).message },400,cors()); }
}
export async function DELETE(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false, error: "Unauthorized" },401);
  const params=new URL(req.url).searchParams,id=params.get("id");
  if (!id) return json({ ok: false, error: "Account ID required" },400);
  if(params.get("confirm")!=="1")return json({ok:false,error:"Confirm account removal first."},400);
  if(!await getSession(user.id,id))return json({ok:false,error:"Account not found"},404);
  try{await removeDmAccount(user.id,id);return json({ok:true,id})}
  catch(e){const error=(e as Error).message;return json({ok:false,error,retryable:/already scanning or running/.test(error)},409)}
}
