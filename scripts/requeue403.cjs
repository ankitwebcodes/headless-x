
const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="(.*)"$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
(async () => {
  const sql = neon(process.env.DATABASE_URL);
  const r = await sql`update jobs set status='queued', error=null, updated_at=${Date.now()} where status='failed' and error like '%403%' returning id`;
  console.log("requeued:", r.length);
})().catch(e => console.log("ERR:", e.message));
