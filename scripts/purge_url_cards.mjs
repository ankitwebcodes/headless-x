import fs from "fs";
let env = "";
for (const f of [".env.local", ".env.prod", ".env"]) {
  try { env = fs.readFileSync(f, "utf8"); if (env) break; } catch {}
}
const m = env.match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
process.env.DATABASE_URL = m[1].trim();
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

// Purge URL-keyed cache rows: they are the poisoned entries that served a
// stale video's card for every post reusing the same product link.
const before = (await sql`SELECT count(*)::int c FROM cards WHERE media_key LIKE 'url:%'`)[0].c;
const beforeAm = (await sql`SELECT count(*)::int c FROM ads_media WHERE media_key LIKE 'url:%'`)[0].c;
await sql`DELETE FROM cards WHERE media_key LIKE 'url:%'`;
await sql`DELETE FROM ads_media WHERE media_key LIKE 'url:%'`;
const after = (await sql`SELECT count(*)::int c FROM cards WHERE media_key LIKE 'url:%'`)[0].c;
const afterAm = (await sql`SELECT count(*)::int c FROM ads_media WHERE media_key LIKE 'url:%'`)[0].c;
console.log(`cards url: rows ${before} -> ${after}`);
console.log(`ads_media url: rows ${beforeAm} -> ${afterAm}`);
const rem = await sql`SELECT media_key, link, card_uri FROM cards ORDER BY created_at DESC LIMIT 5`;
console.log("remaining recent cards:", JSON.stringify(rem, null, 0));
process.exit(0);
