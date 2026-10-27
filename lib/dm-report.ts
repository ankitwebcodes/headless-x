import type { DmChat, DmScanResult } from "./xdm.ts";
import type { DmScanScope } from "./dm-core.ts";
import { newestDmFirst } from "./dm-core.ts";
import { inboxActivity, isRequestChat } from "./dm-policy.ts";

export type DmReportScope = DmScanScope;
export type DmReportRow = {
  conversationId: string; userId: string; handle: string; name: string; kind: "1:1" | "group";
  postId: string | null; postIds: string[]; postUrl: string | null;
  lastText: string; lastAt: number | null; unread: number; unreadKnown: boolean;
  incoming: boolean; inactive: boolean; state: "incoming" | "inactive" | "read";
};
export type DmReportTotals = {
  scope: DmReportScope; chats: number; incoming: number; inactive: number;
  unreadChats: number; unreadMessages: number; withPost: number; withoutPost: number;
  groups: number; scanned: number;
};
export type DmReport = {
  accountId: string; handle: string; scannedAt: number; partial: boolean;
  totals: DmReportTotals; rows: DmReportRow[];
};
const numericId = (id: unknown) => /^\d+$/.test(String(id ?? "")) ? String(id) : null;

// One pass over the scan state builds the whole report: every conversation with the
// other person's user id plus the post id we would repost. No extra X calls needed.
export function buildDmReport(scan: DmScanResult | null | undefined, opts: { accountId: string; handle: string; scope?: DmReportScope; now?: number }): DmReport | null {
  if (!scan) return null;
  const now = opts.now ?? Date.now();
  const stored: DmReportScope = scan.pages?.scope === "unread" ? "unread" : "all";
  const scope: DmReportScope = opts.scope === "unread" ? "unread" : opts.scope === "all" ? "all" : stored;
  const chats = scan.chats.filter(c => !isRequestChat(c))
    .map(c => ({ ...c, ...inboxActivity(c.lastAt ?? null, now) }))
    .filter(c => scope === "all" || (c.unread ?? 0) > 0)
    .sort(newestDmFirst);
  const rows: DmReportRow[] = chats.map(chat => {
    const other = (chat.participants ?? [])[0];
    const postIds = (chat.tweetIds ?? []).map(numericId).filter((id): id is string => !!id);
    const incoming = !!chat.unseen, inactive = !!chat.inactive;
    return { conversationId: chat.id, userId: numericId(other?.id) ?? String(other?.id ?? ""),
      handle: chat.handle ?? other?.handle ?? "", name: chat.name ?? "", kind: chat.kind,
      postId: postIds[0] ?? null, postIds,
      postUrl: postIds[0] ? `https://x.com/i/web/status/${postIds[0]}` : null,
      lastText: (chat.lastText ?? "").replace(/\s+/g, " ").slice(0, 240), lastAt: chat.lastAt ?? null,
      unread: chat.unread ?? 0, unreadKnown: !!chat.unreadKnown,
      incoming, inactive, state: incoming ? "incoming" as const : inactive ? "inactive" as const : "read" as const };
  });
  const incoming = rows.filter(r => r.incoming);
  const inactive = rows.filter(r => r.inactive);
  return { accountId: opts.accountId, handle: opts.handle, scannedAt: scan.scannedAt ?? now,
    partial: !!(scan.pages?.truncated || scan.pages?.stoppedEarly),
    totals: { scope, chats: rows.length, incoming: incoming.length, inactive: inactive.length,
      unreadChats: rows.filter(r => r.unread > 0).length, unreadMessages: rows.reduce((n, r) => n + r.unread, 0),
      withPost: rows.filter(r => r.postIds.length > 0).length, withoutPost: rows.filter(r => r.postIds.length === 0).length,
      groups: rows.filter(r => r.kind === "group").length, scanned: scan.stats?.total ?? rows.length },
    rows };
}
export function reportSections(report: DmReport) {
  return { incoming: report.rows.filter(r => r.incoming), inactive: report.rows.filter(r => r.inactive) };
}
const CSV_HEAD = ["section", "conversation_id", "user_id", "handle", "name", "kind", "post_id", "post_url", "unread", "state", "last_message_at", "last_message"];
const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportCsv(report: DmReport) {
  const lines = [CSV_HEAD.join(",")];
  for (const section of ["incoming", "inactive", "other"] as const) {
    const rows = section === "incoming" ? report.rows.filter(r => r.incoming)
      : section === "inactive" ? report.rows.filter(r => r.inactive && !r.incoming)
      : report.rows.filter(r => !r.incoming && !r.inactive);
    for (const row of rows) lines.push([section, row.conversationId, row.userId, row.handle ? `@${row.handle}` : "", row.name, row.kind,
      row.postId ?? "", row.postUrl ?? "", row.unread || "", row.state,
      row.lastAt ? new Date(row.lastAt).toISOString() : "", row.lastText].map(cell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
export function reportTotalsLine(report: DmReport) {
  const t = report.totals;
  return `${t.chats} chats (${report.handle}) · ${t.incoming} incoming · ${t.inactive} inactive · ${t.unreadMessages} unread messages · ${t.withPost} with a post id`;
}
