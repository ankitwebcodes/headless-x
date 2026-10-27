import { createHmac, timingSafeEqual } from "node:crypto";
import { getUser } from "@/lib/reqAuth";
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); };
function secret() { return process.env.DM_INGEST_KEY || process.env.AUTH_SECRET || ""; }
export function createDmIngestKey(owner: string) {
  if (!secret()) throw new Error("Set DM_INGEST_KEY or AUTH_SECRET to enable extension pairing.");
  const payload = Buffer.from(JSON.stringify({ owner, expires: Date.now() + 30 * 86400_000 })).toString("base64url");
  return `dm1.${payload}.${createHmac("sha256", secret()).update(payload).digest("base64url")}`;
}
export async function dmIngestOwner(req: Request): Promise<string | null> {
  const user = await getUser(req);
  if (user) return user.id;
  const key = req.headers.get("x-dm-key") ?? "";
  if (!secret()) return null;
  if (key.startsWith("dm1.")) {
    const parts = key.split(".");
    if (parts.length !== 3 || !same(parts[2], createHmac("sha256",secret()).update(parts[1]).digest("base64url"))) return null;
    try { const data = JSON.parse(Buffer.from(parts[1],"base64url").toString()); return data.expires > Date.now() && typeof data.owner === "string" ? data.owner : null; }
    catch { return null; }
  }
  // Existing extension keys remain valid only when their panel owner is known.
  if (process.env.DM_INGEST_KEY && same(key, process.env.DM_INGEST_KEY)) {
    if (process.env.DM_INGEST_OWNER_ID) return process.env.DM_INGEST_OWNER_ID;
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (url) {
      const { neon } = await import("@neondatabase/serverless");
      const rows = await neon(url)`SELECT id FROM users WHERE role='admin' LIMIT 2`;
      if (rows.length === 1) return String(rows[0].id);
    }
  }
  return null;
}
export function validDmWorkerKey(req: Request) {
  const expected = process.env.DM_WORKER_KEY;
  return !!expected && same(req.headers.get("authorization") ?? "", `Bearer ${expected}`);
}
