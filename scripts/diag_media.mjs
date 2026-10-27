import fs from "fs";
let env = "";
for (const f of [".env.local", ".env.prod", ".env"]) {
  try { env = fs.readFileSync(f, "utf8"); if (env) break; } catch {}
}
const m = env.match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
process.env.DATABASE_URL = m[1].trim();
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  SELECT id, url, media_key, account_id, created_at
  FROM media ORDER BY created_at DESC LIMIT 8`;
for (const r of rows) {
  let disk = "n/a";
  try {
    const rel = String(r.url || "").split("/uploads/")[1];
    if (rel) {
      const p = "./public/uploads/" + decodeURIComponent(rel);
      const st = fs.statSync(p);
      disk = `${(st.size / 1024).toFixed(0)}KB`;
    }
  } catch { disk = "MISSING"; }
  const ts = r.created_at ? new Date(r.created_at) : null;
  const when = ts && !isNaN(ts) ? ts.toISOString().slice(5, 16) : "??";
  console.log(
    `${when} | id=${String(r.id).slice(0, 8)} | key=${r.media_key ?? "NULL"} | disk=${disk} | ${String(r.url).slice(-45)}`
  );
}
process.exit(0);
