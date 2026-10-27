import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT doc_key, payload->>'status' AS status, payload->>'nextAt' AS next_at,
  payload->'attention' AS attention,
  (SELECT count(*) FROM jsonb_array_elements(payload->'items') i WHERE i->>'status' = 'failed') AS failed,
  (SELECT count(*) FROM jsonb_array_elements(payload->'items') i WHERE i->>'status' = 'uncertain') AS uncertain,
  (SELECT count(*) FROM jsonb_array_elements(payload->'items') i WHERE i->>'status' = 'retry_wait') AS retry_wait,
  (SELECT string_agg(DISTINCT i->>'kind', ',') FROM jsonb_array_elements(payload->'items') i WHERE i->>'status' IN ('failed','uncertain')) AS bad_kinds
  FROM dm_documents WHERE doc_key LIKE 'run:%' AND payload->>'status' IN ('needs_attention','running','waiting')`;
const now = Date.now();
for (const r of rows) {
  const a = r.attention ?? {};
  const soft = !["restriction", "auth", "unsupported"].includes(a.kind ?? "");
  const deadline = Number(a.recoverAt ?? 0);
  const selectable = (Number(r.next_at ?? 0) <= now) && (deadline > 0 && deadline <= now || deadline === 0 && soft && Number(a.retries ?? 0) < 3)
    || (["running", "waiting"].includes(r.status) && Number(r.next_at ?? 0) <= now);
  console.log(`${r.doc_key}  status=${r.status} nextAt=${r.next_at} kind=${a.kind ?? "-"} code=${a.code ?? "-"} retries=${a.retries ?? 0} recoverAt=${deadline || "-"}`);
  console.log(`   failed=${r.failed} uncertain=${r.uncertain} retry_wait=${r.retry_wait} badKinds=${r.bad_kinds ?? "-"}  soft=${soft}  WORKER_WILL_PICK_UP=${!!selectable}`);
}
process.exit(0);
