import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { SignJWT } from "jose";

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = loadEnv(".env.local");
const sql = neon(env.DATABASE_URL);

const [admin] = await sql`select id, email, name, role from users where role='admin' limit 1`;
const [media] = await sql`select id, name, media_type, user_id from media where media_type='VIDEO' order by created_at desc limit 1`;
const accts = await sql`select id, handle from accounts where status='approved' and enabled=1 order by handle limit 3`;

const token = await new SignJWT({ id: admin.id, email: admin.email, name: admin.name, role: admin.role })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
  .sign(new TextEncoder().encode(env.AUTH_SECRET ?? "xpanel-dev-secret-change-me"));

const H = { "content-type": "application/json", cookie: `xp_session=${token}` };
const body = (url) => JSON.stringify({
  accountIds: accts.map((a) => a.id),
  mediaId: media.id,
  caption: "guard-verify",
  url,
  dry: true,
});

async function hit(label, url) {
  const r = await fetch("http://localhost:3000/api/posts/bulk", { method: "POST", headers: H, body: body(url) });
  const t = await r.text();
  console.log(`${label}: HTTP ${r.status} ${t.slice(0, 220)}`);
}

console.log("admin:", admin.email, "| video:", media.name, "| accts:", accts.map((a) => a.handle).join(", "));
await hit("EMPTY url  ", "");
await hit("WITH  url  ", "souszhi.com/2123888");
