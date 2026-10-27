import fs from "fs";
let env = "";
for (const f of [".env.local", ".env.prod", ".env"]) {
  try { env = fs.readFileSync(f, "utf8"); if (env) break; } catch {}
}
const m = env.match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
process.env.DATABASE_URL = m[1].trim();
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const url = "https://souszhi.com/2123888";
const rows = await sql`
  SELECT id FROM media
  WHERE media_key IS NULL AND url NOT LIKE '%twimg%'
  ORDER BY created_at DESC LIMIT 4`;

console.log("The user's new videos, all posted with the same product link:\n");
const olds = new Set(), news = new Set();
for (const r of rows) {
  const oldKey = `url:${url}`;
  const newKey = `media:${r.id}`;
  olds.add(oldKey); news.add(newKey);
  console.log(`video ${String(r.id).slice(0, 8)}   OLD cacheKey = ${oldKey}`);
  console.log(`                NEW cacheKey = ${newKey}\n`);
}
console.log(`OLD: ${rows.length} different videos collapsed into ${olds.size} cache key  <-- every video reused video #1's card`);
console.log(`NEW: ${rows.length} different videos map to ${news.size} distinct cache keys  <-- each builds its own correct card`);
process.exit(0);
