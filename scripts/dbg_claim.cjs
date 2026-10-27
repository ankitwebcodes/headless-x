
const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
// parse .env.local manually
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="(.*)"$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
(async () => {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    select j.id, j.account_id, j.media_id, a.handle, a.session_json, a.oauth1_json, m.url
    from jobs j left join accounts a on a.id = j.account_id left join media m on m.id = j.media_id
    where j.status = 'queued' order by j.created_at limit 5`;
  console.log("queued:", rows.length);
  for (const r of rows) {
    console.log(r.id, r.handle, "sess:", r.session_json ? "len"+r.session_json.length : "NULL", "oauth1:", r.oauth1_json ? "len"+r.oauth1_json.length : "NULL", "media:", r.url ? "ok" : "NULL");
    try { JSON.parse(r.session_json); } catch(e) { console.log("  SESSION PARSE FAIL:", e.message); }
    try { JSON.parse(r.oauth1_json); } catch(e) { console.log("  OAUTH1 PARSE FAIL:", e.message); }
  }
})().catch(e => console.log("ERR:", e.message));
