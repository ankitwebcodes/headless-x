// Mints a short-lived panel session cookie for local UI verification only.
// Prints: xp_session=<jwt>   (never logged to disk, never sent anywhere else)
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { neon } = await import("@neondatabase/serverless");
const { createSessionToken } = await import("../lib/auth.ts");
const sql = neon(process.env.DATABASE_URL);
// users table lives in the same database as dm_documents
const rows = await sql`SELECT id, email, name, role FROM users ORDER BY created_at LIMIT 1`;
if (!rows.length) { console.error("no user"); process.exit(1); }
const token = await createSessionToken({ id: rows[0].id, email: rows[0].email, name: rows[0].name, role: rows[0].role });
console.log(token);
process.exit(0);
