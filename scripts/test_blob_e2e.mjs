// E2E for Direct-to-Blob uploads on PROD (x-panel-six.vercel.app):
//   1) rotate a fresh QA admin in Neon -> real login (no minted tokens)
//   2) ping /api/media/upload (must answer { blob: true })
//   3) SIMPLE PUT path: token -> PUT ~1MB straight to blob.vercel-storage.com
//   4) MULTIPART path: 33MB (2 parts, > 32MB SIMPLE_PUT_MAX) — what real device
//      videos use; the old FormData flow died at 4.5MB on serverless
//   5) register both via POST /api/media/register -> media rows created
//   6) cleanup rows. Prints NO secrets.
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../.env.prod", import.meta.url), "utf8");
const env = {};
for (const line of m.split("\n")) {
  const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (mt) env[mt[1]] = mt[2].replace(/^"/g, "").replace(/"$/g, "");
}
const db = neon(env.DATABASE_URL);
const BASE = "https://x-panel-six.vercel.app";
const BLOB_API = "https://blob.vercel-storage.com";
const API_VERSION = "9";
const EMAIL = "qa-e2e-admin@pinelab.org";
const PW = "Qa" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const hash = bcrypt.hashSync(PW, 10);
await db`delete from media where name like 'e2e-blob-test-%'`;
await db`delete from users where email = ${EMAIL}`;
await db`insert into users (id, email, password_hash, name, role, created_at) values ('qa-e2e-admin-0004', ${EMAIL}, ${hash}, 'QA E2E Admin', 'admin', ${Date.now()})`;

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
const sess = (login.headers.get("set-cookie") || "").match(/xp_session=([^;]+)/)?.[1];
console.log("login:", login.status, "| cookie:", sess ? "YES" : "NO");
if (!sess) process.exit(1);
const H = { Cookie: "xp_session=" + sess };

// --- ping ---
const ping = await fetch(BASE + "/api/media/upload", {
  method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}",
});
console.log("ping:", ping.status, JSON.stringify(await ping.json()));
if (!ping.ok) process.exit(1);

// --- token ---
async function token(pathname, multipart) {
  const r = await fetch(BASE + "/api/media/upload", {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: { pathname, callbackUrl: BASE + "/api/media/upload", clientPayload: null, multipart },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.clientToken) throw new Error("token failed " + r.status + " " + JSON.stringify(j));
  return j.clientToken;
}

const hdr = (t, extra) => ({
  Authorization: `Bearer ${t}`,
  "x-api-version": API_VERSION,
  "x-content-type": "video/mp4",
  ...extra,
});

// --- simple put (~1MB) ---
const buf1 = Buffer.alloc(1024 * 1024, 7);
const p1 = `uploads/${Date.now()}-e2e-blob-test-small.mp4`;
const t1 = await token(p1, false);
const put1 = await fetch(`${BLOB_API}/${p1}`, {
  method: "PUT",
  headers: hdr(t1, { "x-content-length": String(buf1.length) }),
  body: buf1,
});
const j1 = await put1.json().catch(() => null);
console.log("simple PUT:", put1.status, j1?.url ? "url OK" : JSON.stringify(j1).slice(0, 200));

// --- multipart (33MB = 32MB + 1MB) ---
const big = Buffer.concat([Buffer.alloc(32 * 1024 * 1024, 3), Buffer.alloc(1024 * 1024, 5)]);
const p2 = `uploads/${Date.now()}-e2e-blob-test-big.mp4`;
const t2 = await token(p2, true);
const mk = await fetch(`${BLOB_API}/mpu?pathname=${encodeURIComponent(p2)}`, {
  method: "POST", headers: hdr(t2, { "x-mpu-action": "create" }),
});
const created = await mk.json().catch(() => null);
console.log("mpu create:", mk.status, created?.uploadId ? "OK" : JSON.stringify(created).slice(0, 200));
const parts = [];
for (let n = 1; n <= 2; n++) {
  const part = big.subarray((n - 1) * 32 * 1024 * 1024, n === 2 ? big.length : n * 32 * 1024 * 1024);
  const pr = await fetch(`${BLOB_API}/mpu?pathname=${encodeURIComponent(p2)}`, {
    method: "POST",
    headers: hdr(t2, {
      "x-mpu-action": "upload", "x-mpu-key": encodeURIComponent(created.key),
      "x-mpu-upload-id": created.uploadId, "x-mpu-part-number": String(n),
      "x-mpu-part-size": String(part.length),
    }),
    body: part,
  });
  const pj = await pr.json().catch(() => null);
  console.log(`  part ${n}:`, pr.status, pj?.etag ? "etag OK" : JSON.stringify(pj).slice(0, 200));
  parts.push({ etag: pj.etag, partNumber: n });
}
const cr = await fetch(`${BLOB_API}/mpu?pathname=${encodeURIComponent(p2)}`, {
  method: "POST",
  headers: hdr(t2, {
    "x-mpu-action": "complete", "x-mpu-key": encodeURIComponent(created.key),
    "x-mpu-upload-id": created.uploadId,
  }),
  body: JSON.stringify({ parts }),
});
const jd = await cr.json().catch(() => null);
console.log("mpu complete:", cr.status, jd?.url ? "url OK" : JSON.stringify(jd).slice(0, 200));

// --- register both ---
for (const [name, url, size] of [["e2e-blob-test-small.mp4", j1?.url, buf1.length], ["e2e-blob-test-big.mp4", jd?.url, big.length]]) {
  if (!url) { console.log("register " + name + ": SKIP (no url)"); continue; }
  const reg = await fetch(BASE + "/api/media/register", {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ name, url, sizeBytes: size, mimeType: "video/mp4" }),
  });
  const rj = await reg.json().catch(() => null);
  console.log("register", name + ":", reg.status, rj?.media ? "media row created" : JSON.stringify(rj).slice(0, 200));
}

// --- cleanup ---
const d = await db`delete from media where name like 'e2e-blob-test-%' returning id`;
console.log("cleanup: deleted", d.length, "media rows");
