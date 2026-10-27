import { getUser, json } from "@/lib/reqAuth";
import { getSession, readDmDoc, updateDmDoc, acquireAccount, releaseAccount } from "@/lib/dm-store";
import { scanInbox,inboxOnlyScan, type DmScanResult } from "@/lib/xdm";
import { buildDmReport, type DmReportScope } from "@/lib/dm-report";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const scopeOf = (value: unknown): DmReportScope => value === "unread" ? "unread" : "all";
export async function GET(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false, error: "Unauthorized" },401);
  const params = new URL(req.url).searchParams;
  const id = params.get("id") ?? "";
  const account = await getSession(user.id,id);
  if (!account) return json({ ok: false, error: "Account not found" },404);
  const scan = await readDmDoc<DmScanResult>(user.id,`scan:${id}`);
  const result = scan ? inboxOnlyScan(scan) : null;
  const requested = params.get("scope");
  const report = buildDmReport(result, { accountId: id, handle: account.handle,
    scope: requested ? scopeOf(requested) : undefined });
  return json({ ok: true, scan: result, report,
    reportTotals: report?.totals ?? null });
}
export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false, error: "Unauthorized" },401);
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  let token = "", retryAt = 0;
  try {
    const account = await getSession(user.id,id);
    if (!account) return json({ ok: false, error: "Account not found" },404);
    const scope = scopeOf(body.scope);
    const lease = await acquireAccount(user.id,id); token = lease.token;
    const previous = body.fresh ? undefined : await readDmDoc<DmScanResult>(user.id,`scan:${id}`) ?? undefined;
    const result = await scanInbox(account.sessionJson, {
      self: { id: account.xUserId, username: account.handle }, previous, scope,
      maxPages: body.maxPages, maxChats: body.maxChats, budgetMs: body.budgetMs, pageDelayMs: body.pageDelayMs,
      onPage: async progress => { await updateDmDoc(user.id,`scan:${id}`,() => progress,() => progress); },
    });
    retryAt = result.retryAt ?? 0;
    const scan = inboxOnlyScan(result);
    const report = buildDmReport(scan, { accountId: id, handle: account.handle, scope });
    return json({ ...scan, sessionId: id, label: account.label, reportTotals: report?.totals ?? null });
  } catch (e) { return json({ ok: false, error: (e as Error).message },409); }
  finally { if (token) await releaseAccount(user.id,id,token,retryAt); }
}
