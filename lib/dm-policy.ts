import { boundedInt, type DmIncomingMessage, type DmScanScope } from "./dm-core.ts";
import type { DmChat } from "./xdm.ts";

export type DmMode = "all" | "unread" | "inactive";
export type DmPreferences = { mode: DmMode; scanScope: DmScanScope; cooldownMinutes: number; message: string; delayMs: number; concurrency: number; speed: 1 | 2; repostRequired: boolean };
export const defaultDmPreferences: DmPreferences = { mode: "all",scanScope: "all",cooldownMinutes: 120,message: "",delayMs: 6000,concurrency: 2,speed: 1,repostRequired: false };
export function normalizeDmPreferences(input: Partial<DmPreferences>): DmPreferences {
  return { mode: ["all","unread","inactive"].includes(input.mode ?? "") ? input.mode! : "all",
    // "unread" walks only the unread window (fast even on 1000+ chat inboxes);
    // "all" walks the whole inbox.
    scanScope: input.scanScope === "unread" ? "unread" : "all",
    cooldownMinutes: boundedInt(input.cooldownMinutes,120,0,1440),message: String(input.message ?? "").slice(0,10000),
    delayMs: boundedInt(input.delayMs,6000,1000,60000),concurrency: boundedInt(input.concurrency,2,1,3),
    // 2x doubles the chats per wave. It is what trips X's automation heuristic (226),
    // so standard speed is the default and fast is opt-in.
    speed: input.speed === 2 ? 2 : 1,
    repostRequired: input.repostRequired === true };
}
export function isRequestChat(chat: { isRequest?: boolean; status?: string; inactive?: boolean }) {
  return chat.isRequest === true || /REQUEST|UNTRUSTED|LOW_QUALITY/i.test(chat.status ?? "") || chat.isRequest === undefined && chat.inactive === true;
}
export function inboxActivity(lastAt: number | null | undefined, now = Date.now()) {
  const inactive = !!lastAt && lastAt <= now - 24 * 60 * 60000;
  return { inactive,active: !inactive };
}
export function modeMatches(chat: Pick<DmChat,"unread" | "unseen" | "active" | "inactive"> & { isRequest?: boolean; status?: string }, mode: string) {
  if (isRequestChat(chat)) return false;
  if (mode === "unread") return chat.unread > 0;
  if (mode === "inactive") return chat.inactive;
  // Preserve old saved runs, while the panel exposes only the three new modes.
  if (mode === "unseen") return chat.unseen;
  if (mode === "active") return chat.active;
  return mode === "all";
}
export function runConcurrency(base: number, speed: number = 2) { return boundedInt(base,2,1,3) * (speed === 1 ? 1 : 2); }
export function cooldownEnds(lastSentAt: number | null | undefined, minutes: number, now = Date.now()) {
  if (!lastSentAt || minutes <= 0) return 0;
  const until = lastSentAt + minutes * 60000;
  return until > now ? until : 0;
}
export function chatCooldownUntil(chat: { lastSentAt?: number | null }, progress: { lastSentAt?: number | null; replySent?: boolean; updatedAt?: number } | undefined, minutes: number, now = Date.now()) {
  return cooldownEnds(Math.max(chat.lastSentAt ?? 0,progress?.lastSentAt ?? (progress?.replySent ? progress.updatedAt ?? 0 : 0)),minutes,now);
}
export function conversationActivity(raw: any, messages: DmIncomingMessage[], selfId: string) {
  const lastSentAt = Math.max(0,...messages.filter(m => m.senderId === selfId).map(m => m.createdAt)) || null;
  const lastRead = raw?.last_read_event_id ?? raw?.perspectival_conversation_metadata?.last_read_event_id;
  const explicit = raw?.unread_count;
  if ((typeof explicit === "number" || typeof explicit === "string" && explicit.trim() !== "") && Number.isFinite(Number(explicit)))
    return { lastSentAt,unread: Math.max(0,Number(explicit)),unreadKnown: true,lastReadEntryId: lastRead == null ? null : String(lastRead) };
  if (lastRead != null && /^\d+$/.test(String(lastRead))) {
    const readId = BigInt(String(lastRead));
    const unread = messages.filter(m => m.senderId !== selfId && /^\d+$/.test(m.entryId) && BigInt(m.entryId) > readId).length;
    return { lastSentAt,unread,unreadKnown: true,lastReadEntryId: String(lastRead) };
  }
  if (typeof raw?.unread === "boolean") return { lastSentAt,unread: raw.unread ? 1 : 0,unreadKnown: true,lastReadEntryId: null };
  return { lastSentAt,unread: 0,unreadKnown: false,lastReadEntryId: null };
}
