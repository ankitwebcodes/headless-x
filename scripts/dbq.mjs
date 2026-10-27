import fs from "fs";
const env = fs.readFileSync(".env.prod", "utf8");
const m = env.match(/DATABASE_URL="(postgres[^"]+)"/);
process.env.DATABASE_URL = m[1];
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT status, error, tweet_url, caption, url, created_at, claimed_by FROM jobs ORDER BY created_at DESC LIMIT 20`;
for (const r of rows) {
  console.log(JSON.stringify({ status: r.status, url: r.url, tweet: r.tweet_url, claimed: r.claimed_by, at: r.created_at, err: (r.error||"").slice(0,140), caption: (r.caption||"").slice(0,40) }));
}
process.exit(0);
