// Read-only check of the new scan report against the real stored scan in the DB.
// Prints, per connected account: the scan scope, the walk state, and the report totals.
// Run:  node --experimental-strip-types scripts/verify-report.mjs
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { neon } = await import("@neondatabase/serverless");
const { listSessions, readDmDoc } = await import("../lib/dm-store.ts");
const { inboxOnlyScan } = await import("../lib/xdm.ts");
const { buildDmReport, reportCsv, reportTotalsLine } = await import("../lib/dm-report.ts");

const sql = neon(process.env.DATABASE_URL);
const owners = await sql`SELECT owner_id, COUNT(*) AS docs FROM dm_documents WHERE doc_key LIKE 'scan:%' GROUP BY owner_id`;
if (!owners.length) { console.log("no stored scans found"); process.exit(1); }
const owner = owners[0].owner_id;
console.log(`owner ${owner} · ${owners[0].docs} stored scans\n`);
const accounts = await listSessions(owner);
let totalChats = 0, withPost = 0, incoming = 0, inactive = 0, unread = 0;
for (const account of accounts) {
  const scan = await readDmDoc(owner, `scan:${account.id}`);
  if (!scan) { console.log(`@${account.handle.padEnd(20)} no scan stored yet`); continue; }
  const normalised = inboxOnlyScan(scan);
  const report = buildDmReport(normalised, { accountId: account.id, handle: account.handle });
  console.log(`@${account.handle}`);
  console.log(`  walk      scope=${scan.pages?.scope ?? "all"} pages=${scan.pages?.walked} stoppedEarly=${scan.pages?.stoppedEarly ?? "-"} truncated=${scan.pages?.truncated}`);
  console.log(`  totals    ${reportTotalsLine(report)}`);
  console.log(`  unmapped  requestsExcluded=${scan.stats.total - normalised.chats.length} groups=${report.totals.groups} unreadChats=${report.totals.unreadChats}`);
  const sample = report.rows.find(r => r.incoming && r.postId) ?? report.rows[0];
  if (sample) console.log(`  sample    user_id=${sample.userId} post_id=${sample.postId ?? "none"} state=${sample.state} @${sample.handle}`);
  totalChats += report.totals.chats; withPost += report.totals.withPost;
  incoming += report.totals.incoming; inactive += report.totals.inactive; unread += report.totals.unreadMessages;
  reportCsv(report);
}
console.log(`\nALL ACCOUNTS: ${accounts.length} · ${totalChats} chats · ${incoming} incoming · ${inactive} inactive · ${unread} unread messages · ${withPost} with a post id`);
process.exit(0);
