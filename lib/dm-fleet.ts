import { dmRunHeads,listSessions,readDmDoc } from "./dm-store.ts";
import { createDmRun,getDmProgress,runAttention,type DmRun } from "./dm-run.ts";
import { chatCooldownUntil,normalizeDmPreferences,modeMatches } from "./dm-policy.ts";
import { progressForChat } from "./dm-progress.ts";
import {inboxOnlyScan,type DmScanResult} from "./xdm.ts";

export async function getDmFleet(owner: string) {
  const [sessions,runs] = await Promise.all([listSessions(owner),dmRunHeads(owner)]);
  return Promise.all(sessions.map(async a => {
    let run=runs.find(r=>r.accountId===a.id)??null;
    if(run?.status==="needs_attention"&&!run.attention){const stored=await readDmDoc<DmRun>(owner,`run:${run.id}`);if(stored)run={...run,attention:runAttention(stored)}}
    return {accountId:a.id,handle:a.handle,label:a.label,run};
  }));
}
export async function startDmFleet(owner: string) {
  const accounts = await getDmFleet(owner);
  return Promise.all(accounts.map(async a => {
    try {
      if (a.run && ["running","waiting","paused"].includes(a.run.status)) return { accountId: a.accountId,started: false,reason: "Already started or paused" };
      if(a.run?.status==="needs_attention"&&a.run.attention?.kind==="auth")return {accountId:a.accountId,started:false,reason:a.run.attention?.error??"Reconnect this account's cookies"};
      const [settings,scan,progress] = await Promise.all([
        readDmDoc(owner,`settings:${a.accountId}`),readDmDoc<DmScanResult>(owner,`scan:${a.accountId}`),getDmProgress(owner,a.accountId),
      ]);
      const prefs = normalizeDmPreferences(settings ?? {});
      if (!prefs.message.trim()) return { accountId: a.accountId,started: false,reason: "Save a reply for this account first" };
      if (!scan?.ok) return { accountId: a.accountId,started: false,reason: "Scan this account first" };
      const ids = inboxOnlyScan(scan).chats.filter(c => modeMatches(c,prefs.mode) && !progressForChat(c,progress[c.id])?.completed && !chatCooldownUntil(c,progress[c.id],prefs.cooldownMinutes)).map(c => c.id);
      if (!ids.length) return { accountId: a.accountId,started: false,reason: "No ready inbox chats" };
      const run = await createDmRun(owner,{id:a.accountId,...prefs,conversationIds:ids,includeReplied:true,dryRun:false});
      return { accountId: a.accountId,started: true,runId: run.id };
    } catch (e) { return { accountId: a.accountId,started: false,reason: (e as Error).message }; }
  }));
}
