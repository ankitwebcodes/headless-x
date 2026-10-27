import type { DmChat } from "./xdm.ts";
import type { RunItem } from "./dm-run.ts";
import { chatCooldownUntil } from "./dm-policy.ts";
import {freshRepostProof,type DmRepostProof} from "./dm-core.ts";

export type DmChatProgress = {
  id: string; runId: string; entryId?: string; status: RunItem["status"];
  reposted: string[]; targetTweetIds: string[]; replySent: boolean; replyId?: string;
  repostComplete: boolean; completed: boolean; dry: boolean; updatedAt: number;
  error?: string; failedStep?: "read" | "repost" | "send";
  lastSentAt?: number | null; cooldownUntil?: number;
  repostProofs?: Record<string,DmRepostProof>;
};
export function verifiedProgress(progress:DmChatProgress):DmChatProgress {
  const targetTweetIds=Array.isArray(progress.targetTweetIds)?progress.targetTweetIds:[],reposted=Array.isArray(progress.reposted)?progress.reposted:[];
  const repostComplete=!progress.dry&&targetTweetIds.length>0&&targetTweetIds.every(id=>reposted.includes(id)&&freshRepostProof(progress.repostProofs?.[id],id));
  return {...progress,targetTweetIds,reposted,repostComplete,completed:progress.replySent&&repostComplete};
}
export function progressFromItem(item: RunItem, runId: string): DmChatProgress {
  const targetTweetIds = item.incoming?.tweetIds ?? [];
  const repostComplete = targetTweetIds.length > 0 && targetTweetIds.every(id => item.reposted.includes(id)&&freshRepostProof(item.repostProofs?.[id],id));
  const replySent = !item.dry && (item.status === "sent" || !!item.sentId);
  return { id: item.id, runId, entryId: item.incoming?.entryId, status: item.status,
    reposted: item.dry ? [] : item.reposted, targetTweetIds, replySent, replyId: item.sentId,
    repostComplete: !item.dry && repostComplete, completed: replySent && repostComplete,
    dry: !!item.dry, updatedAt: item.updatedAt ?? Date.now(), error: item.error, failedStep: item.failedStep,
    lastSentAt: item.lastSentAt ?? item.sentAt ?? (replySent ? item.sendStartedAt ?? item.updatedAt ?? Date.now() : null),cooldownUntil: item.cooldownUntil,repostProofs:item.repostProofs };
}
export function mergeDmProgress(old: DmChatProgress | undefined, next: DmChatProgress): DmChatProgress {
  old=old?verifiedProgress(old):undefined;next=verifiedProgress(next);
  const lastSentAt = Math.max(old?.lastSentAt ?? (old?.replySent ? old.updatedAt : 0),next.lastSentAt ?? 0) || null;
  if (old?.completed && (!next.entryId || next.entryId === old.entryId || next.dry)) return { ...old,lastSentAt };
  return { ...next,lastSentAt };
}
export function progressForChat(chat: DmChat, progress?: DmChatProgress) {
  // A new incoming entry must never inherit a prior entry's green checkmarks.
  if (chat.unseen && chat.lastEntryId && progress?.entryId && chat.lastEntryId !== progress.entryId) return undefined;
  return progress?verifiedProgress(progress):undefined;
}
export function progressStats(chats: DmChat[], progress: Record<string,DmChatProgress>, minutes = 0, now = Date.now()) {
  const visible = chats.map(c => progressForChat(c,progress[c.id])).filter((p): p is DmChatProgress => !!p);
  const completed = visible.filter(p => p.completed).length;
  const skipped = visible.filter(p => p.status === "skipped" && !p.completed).length;
  const failed = visible.filter(p => p.status === "failed" || p.status === "uncertain").length;
  const dry = visible.filter(p => p.dry).length;
  const cooldown = chats.filter(c => !progressForChat(c,progress[c.id])?.completed && chatCooldownUntil(c,progress[c.id],minutes,now) > 0).length;
  const pending = chats.filter(c => {
    const p = progressForChat(c,progress[c.id]);
    return !p?.completed && !p?.dry && !["skipped","failed","uncertain"].includes(p?.status ?? "") && !chatCooldownUntil(c,progress[c.id],minutes,now);
  }).length;
  return { total: chats.length, completed, reposted: visible.filter(p => p.repostComplete).length,
    sent: visible.filter(p => p.replySent).length, legacyReplies:visible.filter(p=>p.replySent&&!p.repostComplete).length, skipped, failed, dry,cooldown,pending };
}
