import { getUser } from "@/lib/reqAuth";
import { getSession, readDmDoc } from "@/lib/dm-store";
import { inboxOnlyScan, type DmScanResult } from "@/lib/xdm";
import { buildDmReport, reportCsv, reportTotalsLine, type DmReportScope } from "@/lib/dm-report";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The scan report. Built from the stored scan state in one pass — no extra X calls —
 * so "Scan" -> "report ready" is instant once the inbox walk finishes.
 *
 *   GET /api/dm/report?id=<account>&scope=unread|all&limit=200
 *   GET /api/dm/report?id=<account>&scope=unread&format=csv   (download)
 */
export async function GET(req: Request) {
  const user = await getUser(req);
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const id = params.get("id") ?? "";
  const account = await getSession(user.id, id);
  if (!account) return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
  const scan = await readDmDoc<DmScanResult>(user.id, `scan:${id}`);
  if (!scan) return Response.json({ ok: false, error: "Scan the inbox first — there is no report yet." }, { status: 409 });
  const requested = params.get("scope");
  const scope: DmReportScope | undefined = requested === "unread" ? "unread" : requested === "all" ? "all" : undefined;
  const report = buildDmReport(inboxOnlyScan(scan), { accountId: id, handle: account.handle, scope });
  if (!report) return Response.json({ ok: false, error: "Could not build the report." }, { status: 409 });
  const format = (params.get("format") ?? "json").toLowerCase();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  if (format === "csv" || format === "txt") {
    const body = format === "txt" ? `${reportTotalsLine(report)}\r\n` : reportCsv(report);
    return new Response(body, { headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="dm-report-${account.handle}-${scope ?? report.totals.scope}-${stamp}.${format}"`,
      "cache-control": "no-store" } });
  }
  const limit = Math.max(1, Math.min(5000, Number(params.get("limit") ?? 200) || 200));
  const rows = report.rows.slice(0, limit);
  return Response.json({ ok: true, ...report, rows, limited: report.rows.length > rows.length,
    incoming: rows.filter(r => r.incoming), inactive: rows.filter(r => r.inactive),
    counts: { incoming: report.totals.incoming, inactive: report.totals.inactive },
    headline: reportTotalsLine(report) });
}
