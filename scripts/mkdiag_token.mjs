import fs from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
const rows = await sql`select id, email, name, role from users order by created_at asc limit 5`;
console.log(rows);

const u = rows[0];
const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET ?? "xpanel-dev-secret-change-me");
const tok = await new SignJWT({ id: u.id, email: u.email, name: u.name, role: u.role })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("7d")
  .sign(SECRET);
fs.writeFileSync(path.join(root, "scripts", ".diag_token"), tok);
console.log("token written, len", tok.length, "role", u.role);
