import fs from "node:fs";
import path from "node:path";

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

const accts = await sql`select id, handle, status, enabled,
  (oauth1_json is not null and oauth1_json <> '') as has_oauth1,
  (ads_account_id is not null and ads_account_id <> '') as has_ads,
  length(session_json) as sess_len, created_at
  from accounts order by created_at asc`;
console.log("=== ACCOUNTS ===");
for (const a of accts) console.log(`${a.handle.padEnd(18)} oauth1=${a.has_oauth1} ads=${a.has_ads} sess=${a.sess_len} ${a.status}/${a.enabled}`);

const media = await sql`select id, name, account_id, media_key, left(url, 70) as url, created_at
  from media order by created_at desc limit 12`;
console.log("\n=== RECENT MEDIA ===");
for (const m of media) console.log(`${String(m.name).slice(0,45).padEnd(46)} acct=${String(m.account_id).slice(0,8)} key=${m.media_key} ${m.url}`);

const jobs = await sql`select j.id, a.handle, j.status, left(j.error,160) as err, j.tweet_url, j.created_at
  from jobs j left join accounts a on a.id = j.account_id order by j.created_at desc limit 15`;
console.log("\n=== RECENT JOBS ===");
for (const j of jobs) console.log(`${new Date(Number(j.created_at)).toISOString()} ${String(j.handle).padEnd(16)} ${j.status.padEnd(8)} ${j.tweet_url ?? ""} ERR=${j.err ?? ""}`);

const cards = await sql`select count(*)::int as n from cards`;
const ads = await sql`select count(*)::int as n from ads_media`;
console.log(`\ncards=${cards[0].n} ads_media=${ads[0].n}`);
