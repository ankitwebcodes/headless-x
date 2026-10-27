import fs from "fs";
let env = "";
for (const f of [".env.local", ".env.prod", ".env"]) {
  try { env = fs.readFileSync(f, "utf8"); if (env) break; } catch {}
}
const m = env.match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
if (!m) { console.log("NO DB URL"); process.exit(1); }
process.env.DATABASE_URL = m[1].trim();
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

console.log("=== recent jobs ===");
const jobs = await sql`SELECT id, status, media_id, url, tweet_url, caption, error, created_at FROM jobs ORDER BY created_at DESC LIMIT 12`;
for (const r of jobs) {
  console.log(JSON.stringify({
    at: new Date(Number(r.created_at)).toISOString().slice(11,19),
    status: r.status, mediaId: r.media_id, url: r.url,
    tweet: r.tweet_url, err: (r.error||"").slice(0,100), cap: (r.caption||"").slice(0,30)
  }));
}

console.log("\n=== cards table ===");
try {
  const cards = await sql`SELECT media_key, link, card_uri, created_at FROM cards ORDER BY created_at DESC LIMIT 20`;
  for (const r of cards) {
    console.log(JSON.stringify({ at: new Date(Number(r.created_at)).toISOString().slice(11,19), mediaKey: r.media_key, link: r.link, card: r.card_uri }));
  }
  console.log("total cards:", (await sql`SELECT count(*)::int c FROM cards`)[0].c);
} catch (e) { console.log("cards err:", e.message); }

console.log("\n=== ads_media table ===");
try {
  const am = await sql`SELECT media_key, ads_account_id, ads_media_id, created_at FROM ads_media ORDER BY created_at DESC LIMIT 20`;
  for (const r of am) console.log(JSON.stringify({ mediaKey: r.media_key, acct: r.ads_account_id, mediaId: r.ads_media_id }));
  console.log("total ads_media:", (await sql`SELECT count(*)::int c FROM ads_media`)[0].c);
} catch (e) { console.log("ads_media err:", e.message); }

console.log("\n=== recent media rows ===");
const med = await sql`SELECT id, url, media_key, account_id, created_at FROM media ORDER BY created_at DESC LIMIT 12`;
for (const r of med) {
  console.log(JSON.stringify({ at: new Date(Number(r.created_at)).toISOString().slice(11,19), id: r.id, mediaKey: r.media_key, acct: r.account_id, url: (r.url||"").slice(-45) }));
}
process.exit(0);
