import { randomUUID, createHash } from "node:crypto";
import { boundedInt,freshRepostProof,recordedRepostMutation, type DmIncomingMessage, type DmOutcome,type DmRepostProof } from "./dm-core.ts";
import { acquireAccount, getSession,deleteSession, readDmDoc, listDmDocs, releaseAccount, updateDmDoc } from "./dm-store.ts";
import { readConversation, repostTweet,verifyRepost, sendDm,inboxOnlyScan, type DmChat, type DmScanResult, type DmDiagnostic } from "./xdm.ts";
import { progressFromItem,mergeDmProgress,verifiedProgress,type DmChatProgress } from "./dm-progress.ts";
import { modeMatches,cooldownEnds,isRequestChat,runConcurrency } from "./dm-policy.ts";
export type ItemStatus = "queued" | "reading" | "reposting" | "sending" | "sent" | "skipped" | "failed" | "uncertain" | "retry_wait" | "cooldown";
export type RunItem = {
  id: string; name: string; handle: string | null; status: ItemStatus;
  incoming?: DmIncomingMessage; reposted: string[]; requestId: string;
  text?: string; sendStartedAt?: number; sentId?: string; error?: string;
  kind?: DmOutcome["kind"]; attempts: number; retryAt?: number; dry?: boolean;
  step?: "read" | "repost" | "send"; failedStep?: "read" | "repost" | "send";
  diagnostics?: DmDiagnostic[]; updatedAt?: number;
  lastSentAt?: number | null; sentAt?: number; cooldownUntil?: number;
  repostProofs?: Record<string,DmRepostProof>;
  replyAlreadySent?: boolean;
  // Posts X will not let us repost (deleted, protected, not retweetable). The reply
  // still goes out so one dead post cannot stall the whole chat.
  repostSkipped?: string[]; repostSkipReason?: string;
  // Consecutive 226 (automation heuristic) hits for this item.
  softThrottles?: number;
};
export type DmRun = {
  id: string; accountId: string; message: string; dryRun: boolean; delayMs: number; concurrency: number;
  includeReplied?: boolean;
  mode?: string; cooldownMinutes?: number; speed?: 1 | 2;
  // When true a chat whose post cannot be reposted is skipped instead of messaged.
  repostRequired?: boolean;
  status: "running" | "waiting" | "paused" | "finished" | "needs_attention";
  items: RunItem[]; createdAt: number; updatedAt: number; nextAt: number;
  attention?: {kind?:DmOutcome["kind"];code?:number;error:string;at:number;recoverAt?:number;retries?:number};
}
// 226 = automation heuristic (soft, usually clears in a minute). 344 = daily send cap.
// Without recovery an account parks on needs_attention forever and the fleet looks dead.
export function attentionRecoveryMs(kind:string|undefined,code:number|undefined,retries:number) {
  if (kind !== "restriction") return 0;
  const base = code === 344 ? 60*60000 : 15*60000;
  const wait = Math.min(6*3600000, base * 2**Math.max(0,retries-1));
  // Jitter stops every account from retrying at the same instant.
  return wait + Math.floor(Math.random() * Math.min(180000, wait * 0.25));
};
type Ledger = { status: "reposting" | "reposted" | "sending" | "sent" | "uncertain"; reposted: string[]; requestId: string; text: string; sentId?: string; startedAt?: number;repostProofs?:Record<string,DmRepostProof> };
const terminal = (item: RunItem) => ["sent","skipped","failed","uncertain","cooldown"].includes(item.status);
const ledgerKey = (account: string, entry: string) => `entry:${account}:${createHash("sha256").update(entry).digest("hex")}`;
export const runSummary = (run: DmRun) => ({ total: run.items.length, sent: run.items.filter(i => i.status === "sent" && !i.dry).length,
  reposted: run.items.reduce((n,i) => n + (i.incoming?.tweetIds??[]).filter(id=>i.reposted.includes(id)&&freshRepostProof(i.repostProofs?.[id],id)).length,0), skipped: run.items.filter(i => i.status === "skipped").length,
  repostSkipped: run.items.filter(i => (i.repostSkipped?.length ?? 0) > 0).length,
  failed: run.items.filter(i => i.status === "failed").length, uncertain: run.items.filter(i => i.status === "uncertain").length,
  cooldown: run.items.filter(i => i.status === "cooldown").length,pending: run.items.filter(i => !terminal(i)).length });
export function runAttention(run:DmRun) {
  if(run.status!=="needs_attention")return undefined;
  if(run.attention)return run.attention;
  const item=run.items.find(i=>i.kind==="restriction")??run.items.find(i=>["auth","unsupported"].includes(i.kind??""))??run.items.find(i=>i.error&&["failed","uncertain"].includes(i.status));
  const code=Number([item?.error,...(item?.diagnostics??[]).map(d=>d.error)].join(" ").match(/\b(226|326|344)\b/)?.[1])||undefined;
  return item?{kind:item.kind,code,error:item.error??"Inspect account results",at:item.updatedAt??run.updatedAt}:undefined;
}
async function saveRun(owner: string, id: string, change: (run: DmRun) => DmRun) {
  return updateDmDoc<DmRun>(owner,`run:${id}`, () => { throw new Error("Run not found"); }, run => ({ ...change(run), updatedAt: Date.now() }));
}
export async function latestRun(owner: string, account: string) {
  const latest = await readDmDoc<{ id: string }>(owner,`latest:${account}`);
  return latest ? readDmDoc<DmRun>(owner,`run:${latest.id}`) : null;
}
export async function getDmProgress(owner: string, account: string, run?: DmRun | null) {
  const stored = await listDmDocs<DmChatProgress>(owner,`chat:${account}:`);
  const progress = Object.fromEntries(stored.map(p => [p.id,verifiedProgress(p)]));
  for (const item of run?.items ?? []) {
    if (item.status === "queued") continue;
    const candidate = progressFromItem(item,run!.id);
    const prev = progress[item.id];
    if (!prev || candidate.updatedAt >= prev.updatedAt) progress[item.id] = mergeDmProgress(prev,candidate);
  }
  return progress;
}
export async function auditDmReposts(owner:string,accountId:string,force=false) {
  const account=await getSession(owner,accountId);if(!account)throw new Error("Account not found");
  const lease=await acquireAccount(owner,accountId);
  const end=Date.now()+35000,signal=AbortSignal.timeout(35000);
  let checked=0,verified=0;const errors:string[]=[];
  try{
    const latest=await latestRun(owner,accountId);
    if(latest&&["running","waiting"].includes(latest.status))throw new Error("Pause or stop this account's run before verifying saved reposts.");
    const progress=await getDmProgress(owner,accountId,latest),cache=new Map<string,Awaited<ReturnType<typeof verifyRepost>>>();
    const candidates=Object.values(progress).filter(p=>!p.dry&&p.targetTweetIds.length&&(force||p.targetTweetIds.some(id=>!p.repostProofs?.[id])));
    for(const p of candidates.slice(0,12)){
      if(Date.now()+10000>end)break;
      const proofs={...p.repostProofs};
      for(const id of p.targetTweetIds){
        if(!force&&proofs[id])continue;
        let result=cache.get(id);if(!result){result=await verifyRepost(account.sessionJson,id,signal);cache.set(id,result)}
        if(!result.ok||!result.repostProof){errors.push(result.error??"Repost verification failed");break}
        proofs[id]={...proofs[id],...result.repostProof,...(recordedRepostMutation(proofs[id],id)?{action:proofs[id].action,mutationAt:proofs[id].mutationAt,mutationId:proofs[id].mutationId}:{action:"observed" as const})};
      }
      const allChecked=p.targetTweetIds.every(id=>!!proofs[id]);
      const reposted=p.targetTweetIds.filter(id=>proofs[id]?.retweeted);
      let candidate=verifiedProgress({...p,reposted,repostProofs:proofs,updatedAt:Date.now()});
      const recover=p.status==="uncertain"&&p.failedStep==="repost"&&allChecked&&!p.replySent;
      if(recover)candidate={...candidate,status:"queued",error:undefined,failedStep:undefined};
      await updateDmDoc(owner,`chat:${accountId}:${p.id}`,()=>candidate,()=>candidate);
      if(p.entryId){const key=ledgerKey(accountId,p.entryId),old=await readDmDoc<Ledger>(owner,key);if(old)await updateDmDoc<Ledger>(owner,key,()=>old,r=>({...r,reposted,repostProofs:proofs,...(recover?{status:"reposted" as const}:{})}))}
      const saved=await readDmDoc<DmRun>(owner,`run:${p.runId}`);
      if(saved?.accountId===accountId)await saveRun(owner,p.runId,r=>({...r,...(recover&&r.status!=="needs_attention"?{status:"paused" as const}:{}),items:r.items.map(i=>i.id===p.id?{...i,reposted,repostProofs:proofs,...(recover?{status:"queued" as const,error:undefined,kind:undefined,failedStep:undefined,attempts:0}:{}),updatedAt:candidate.updatedAt}:i)}));
      checked++;if(candidate.repostComplete)verified++;
      if(errors.length)break;
    }
    const run=await latestRun(owner,accountId),updated=await getDmProgress(owner,accountId,run);
    return {run,summary:run?runSummary(run):null,progress:updated,checked,verified,remaining:Object.values(updated).filter(p=>!p.dry&&p.targetTweetIds.some(id=>!p.repostProofs?.[id])).length,errors};
  }finally{await releaseAccount(owner,accountId,lease.token)}
}
export async function createDmRun(owner: string, body: Record<string, any>): Promise<DmRun> {
  const accountId = String(body.id ?? "");
  if (!await getSession(owner,accountId)) throw new Error("Account not found");
  const message = String(body.message ?? "").trim();
  if (!message || message.length > 10000) throw new Error("Message must contain 1–10,000 characters.");
  const selected = Array.isArray(body.conversationIds) ? new Set(body.conversationIds.map(String)) : null;
  const mode = String(body.mode ?? "all");
  if (!["unread","unseen","active","inactive","all"].includes(mode)) throw new Error("Invalid chat filter");
  const lease = await acquireAccount(owner,accountId);
  try {
    if(!await getSession(owner,accountId))throw new Error("Account was removed. Connect it again before starting a run.");
    const scan = await readDmDoc<DmScanResult>(owner,`scan:${accountId}`);
    if (!scan?.ok) throw new Error("Scan this account's inbox first.");
    const chats = inboxOnlyScan(scan).chats.filter((c: DmChat) => modeMatches(c,mode) && (!selected || selected.has(c.id)));
    if (!chats.length) throw new Error("No inbox chats matched. Message requests are excluded.");
    const old = await latestRun(owner,accountId);
    if (old && ["running","waiting","paused"].includes(old.status)) throw new Error("Resume or stop the existing run before starting another.");
    // A parked (restricted) run must not keep racing the fresh one once its backoff elapses.
    if (old && old.status === "needs_attention") await saveRun(owner,old.id,r => ({ ...r,status:"finished",
      items:r.items.map(i => terminal(i) ? i : { ...i,status:"skipped",error:"Superseded by a newer run." }) }));
    const run: DmRun = { id: randomUUID(), accountId, message, dryRun: !!body.dryRun,
      delayMs: boundedInt(body.delayMs,6000,1000,60000), concurrency: boundedInt(body.concurrency,2,1,3),speed: body.speed === 2 ? 2 : 1,
      status: "running",mode,cooldownMinutes: boundedInt(body.cooldownMinutes,120,0,1440),
      repostRequired: body.repostRequired === true,
      includeReplied: typeof body.includeReplied === "boolean" ? body.includeReplied : mode !== "unseen",createdAt: Date.now(), updatedAt: Date.now(), nextAt: 0,
      items: chats.map(c => ({ id: c.id, name: c.name, handle: c.handle, status: "queued", reposted: [], requestId: randomUUID(), attempts: 0 })) };
    await updateDmDoc(owner,`run:${run.id}`,() => run,() => run);
    await updateDmDoc(owner,`latest:${accountId}`,() => ({ id: run.id }),() => ({ id: run.id }));
    return run;
  } finally { await releaseAccount(owner,accountId,lease.token); }
}
export async function removeDmAccount(owner:string,accountId:string) {
  if(!await getSession(owner,accountId))throw new Error("Account not found");
  // A later GET must not silently recreate a deliberately removed last account.
  await updateDmDoc(owner,"legacy-adoption",()=>({manualRemoval:true}),()=>({manualRemoval:true}));
  const stopRuns=async()=>{
    const runs=await listDmDocs<DmRun>(owner,"run:");
    await Promise.all(runs.filter(r=>r.accountId===accountId&&r.status!=="finished").map(r=>controlDmRun(owner,r.id,"cancel")));
  };
  // Signal existing workers to stop first. Their lease protects any in-flight request.
  await stopRuns();
  const lease=await acquireAccount(owner,accountId,{ignoreCooldown:true});
  try{await stopRuns();await deleteSession(owner,accountId)}
  finally{await releaseAccount(owner,accountId,lease.token)}
}
export async function controlDmRun(owner: string, id: string, action: "pause" | "resume" | "retry" | "cancel", options: { includeReplied?: boolean; cooldownMinutes?: number } = {}) {
  const existing = await readDmDoc<DmRun>(owner,`run:${id}`);
  if (!existing) throw new Error("Run not found");
  const lease = ["resume","retry"].includes(action) ? await acquireAccount(owner,existing.accountId) : null;
  try { return await saveRun(owner,id,run => {
    if (action === "pause") return { ...run, status: "paused" };
    if (action === "cancel") return { ...run, status: "finished", items: run.items.map(i => terminal(i) ? i : { ...i, status: "skipped", error: "Cancelled by operator" }) };
    if (options.cooldownMinutes !== undefined && ["paused","needs_attention","finished"].includes(run.status)) run.cooldownMinutes = boundedInt(options.cooldownMinutes,120,0,1440);
    run.items = run.items.map(i => i.status === "cooldown" && !cooldownEnds(i.lastSentAt,run.cooldownMinutes ?? 120)
      ? { ...i,status: "queued",error: undefined,cooldownUntil: undefined } : i);
    if (options.includeReplied !== undefined && run.status === "paused") {
      if (options.includeReplied && !run.includeReplied) run.items = run.items.map(i => i.status === "skipped" && /^Latest message is (?:outgoing|outbound)/.test(i.error ?? "")
        ? { ...i,status: "queued",attempts: 0,error: undefined } : i);
      run.includeReplied = options.includeReplied;
    }
    if (action === "retry") run.items = run.items.map(i => i.status === "failed" && (i.kind !== "unsupported" || i.failedStep === "repost") ? { ...i, status: "queued", error: undefined, attempts: 0 } : i);
    // Uncertain writes never auto-retry, including after a process restart.
    return { ...run, status: "running",attention:undefined };
  }); } finally { if (lease) await releaseAccount(owner,existing.accountId,lease.token); }
}
// This is an explicit operator decision after inspecting the real chat. It is
// deliberately separate from automatic retries and requires the account lease.
export async function resolveDmItem(owner: string, id: string, conversationId: string, resolution: "sent" | "not_sent") {
  const run = await readDmDoc<DmRun>(owner,`run:${id}`);
  if (!run) throw new Error("Run not found");
  const lease = await acquireAccount(owner,run.accountId);
  try {
    const item = run.items.find(i => i.id === conversationId);
    if (!item || item.status !== "uncertain" || !item.incoming) throw new Error("Only an uncertain incoming-message item can be resolved.");
    const key = ledgerKey(run.accountId,item.incoming.entryId);
    await updateDmDoc<Ledger>(owner,key,() => ({ status: "uncertain",reposted: item.reposted,requestId: item.requestId,text: item.text ?? "" }),old =>
      ({ ...old,status: resolution === "sent" ? "sent" : "reposted" }));
    const resolved = await saveRun(owner,id,r => ({ ...r,status: "paused",items: r.items.map(i => i.id !== conversationId ? i : {
      ...i,status: resolution === "sent" ? "sent" : "queued",error: resolution === "sent" ? "Reply confirmed by operator" : undefined,
      kind: undefined,attempts: 0,retryAt: undefined,updatedAt: Date.now(),
    }) }));
    const progress = progressFromItem(resolved.items.find(i => i.id === conversationId)!,id);
    await updateDmDoc(owner,`chat:${run.accountId}:${conversationId}`,() => progress,() => progress);
    return resolved;
  } finally { await releaseAccount(owner,run.accountId,lease.token); }
}
export async function processDmRun(owner: string, id: string, budgetMs = 40000, maxItems = Number.MAX_SAFE_INTEGER): Promise<DmRun> {
  let run = await readDmDoc<DmRun>(owner,`run:${id}`);
  if (!run) throw new Error("Run not found");
  // A parked run must always carry a retry deadline, otherwise nothing ever picks the
  // account back up and the fleet looks dead. Runs parked by an older build carry none,
  // so a missing deadline is assigned here instead of leaving the account stranded.
  if (run.status === "needs_attention") {
    const kind = run.attention?.kind;
    const code = run.attention?.code ?? 0;
    const attempts = run.attention?.retries ?? 0;
    const deadline = run.attention?.recoverAt ?? 0;
    if (deadline) {
      if (deadline > Date.now()) return run;
      run = await saveRun(owner,id,r => ({ ...r,status:"running",attention:undefined }));
    } else {
      if (attempts >= 3) return run;
      // A genuine cookie/auth problem needs the operator, not a retry loop.
      if (["auth","unsupported"].includes(kind ?? "")) return saveRun(owner,id,r => ({ ...r,attention:{ ...r.attention!, retries: 3 } }));
      // X restrictions get the standard backoff; anything else only retries when there
      // is a failed chat a retry could actually fix (never a permanent reject).
      const restriction = kind === "restriction";
      const fixable = restriction || run.items.some(i => i.status === "failed" && ["transient","rate_limit"].includes(i.kind ?? ""));
      if (!fixable) return saveRun(owner,id,r => ({ ...r,attention:{ ...r.attention!, retries: 3 } }));
      const wait = restriction ? attentionRecoveryMs(kind,code,attempts + 1) : 3*60000 + Math.floor(Math.random()*60000);
      return saveRun(owner,id,r => ({ ...r,attention:{ ...r.attention!, recoverAt: Date.now() + (wait || 60000) } }));
    }
  }
  if (!["running","waiting"].includes(run.status) || run.nextAt > Date.now()) return run;
  const account = await getSession(owner,run.accountId);
  if (!account) return saveRun(owner,id,r => ({ ...r, status: "needs_attention", items: r.items.map(i => terminal(i) ? i : { ...i,status: "failed",error: "Account removed" }) }));
  const cooldownMinutes = boundedInt(run.cooldownMinutes,120,0,1440);
  const scanSnapshot = await readDmDoc<DmScanResult>(owner,`scan:${account.id}`);
  const scanned = new Map((scanSnapshot?.chats ?? []).map(c => [c.id,c]));
  const priorProgress = await getDmProgress(owner,account.id,run);
  const lease = await acquireAccount(owner,account.id);
  const end = Date.now() + boundedInt(budgetMs,40000,3000,45000);
  const signal = AbortSignal.timeout(Math.max(1000,end - Date.now()));
  let cooldown = 0, stopWave = false, attemptedThisCall = 0;
  const changeItem = async (item: RunItem) => {
    item.updatedAt = Date.now();
    const checkpoint = await saveRun(owner,id,r => ({ ...r, items: r.items.map(i => {
      if(i.id !== item.id) return i;
      // A batch finishing after Stop must not revive cancelled queued work.
      // Actual completed or ambiguous writes still need their truthful checkpoint.
      if(r.status === "finished" && i.error === "Cancelled by operator" && ["queued","reading","reposting","sending","retry_wait"].includes(item.status)) return i;
      return item;
    }) }));
    const progress = progressFromItem(checkpoint.items.find(i=>i.id===item.id)!,id);
    // The run checkpoint is authoritative if this secondary UI index needs a retry.
    await updateDmDoc<DmChatProgress>(owner,`chat:${account.id}:${item.id}`,() => progress,old => mergeDmProgress(old,progress)).catch(() => {});
  };
  const stopped = async () => !["running","waiting"].includes((await readDmDoc<DmRun>(owner,`run:${id}`))?.status ?? "");
  const processItem = async (input: RunItem) => {
    const oldProgress = priorProgress[input.id];
    let item: RunItem = { ...input,reposted: [...input.reposted],attempts: input.attempts + 1,error: undefined,retryAt: undefined,failedStep: undefined,kind: undefined,
      lastSentAt: Math.max(input.lastSentAt ?? 0,scanned.get(input.id)?.lastSentAt ?? 0,oldProgress?.lastSentAt ?? (oldProgress?.replySent ? oldProgress.updatedAt : 0)) || null };
    // A post X refuses to retweet (deleted, protected, not retweetable) must not block
    // the reply — the DM is the point of the run. Opt back in with "Require repost".
    const repostCanBeSkipped = (outcome: DmOutcome) => !run!.repostRequired && item.step === "repost" &&
      (outcome.unavailable === true || outcome.kind === "post_rejected" || outcome.kind === "permanent");
    const fail = async (outcome: DmOutcome) => {
      if(outcome.deferred){await changeItem({...item,status:"retry_wait",attempts:Math.max(0,item.attempts-1),retryAt:Date.now()+1000,error:outcome.error,failedStep:item.step});return}
      // 226 is a soft automation throttle, not a ban. Back just this chat off with jitter
      // and pause the wave, instead of parking the whole account on the first hit.
      if (outcome.kind === "restriction" && outcome.xCode === 226) {
        const soft = (item.softThrottles ?? 0) + 1;
        if (soft <= 2) {
          const wait = Math.min(10*60000, 45000 * 2**soft) + Math.floor(Math.random()*20000);
          cooldown = Math.max(cooldown, Date.now() + wait);
          await changeItem({ ...item, softThrottles: soft, status: "retry_wait", error: outcome.error, kind: outcome.kind, failedStep: item.step, retryAt: Date.now() + wait });
          return;
        }
      }
      if(outcome.unavailable){await changeItem({...item,status:"skipped",error:outcome.error??"Post is unavailable. Repost and reply skipped.",kind:outcome.kind,failedStep:item.step});return}
      const retry = (["rate_limit","transient"].includes(outcome.kind ?? "") && item.attempts < 6)
        || (outcome.kind === "post_rejected" && item.attempts < 3);
      const retryAt = outcome.retryAt ?? Date.now() + Math.min(15 * 60000, 5000 * 2 ** item.attempts) + Math.floor(Math.random() * 2000);
      item = { ...item, status: outcome.kind === "uncertain" ? "uncertain" : retry ? "retry_wait" : "failed", error: outcome.error, kind: outcome.kind, failedStep: item.step,
        retryAt: retry ? retryAt : undefined };
      if (["rate_limit","auth","restriction"].includes(outcome.kind ?? "") || (item.step === "repost" && outcome.kind === "unsupported")) {
        stopWave = true;
        if (outcome.kind === "rate_limit") cooldown = Math.max(cooldown,retryAt);
        else await saveRun(owner,id,r => {
          const retries = outcome.kind === "restriction" ? (r.attention?.retries ?? 0) + 1 : (r.attention?.retries ?? 0);
          const wait = attentionRecoveryMs(outcome.kind,outcome.xCode,retries);
          return { ...r,status:"needs_attention",attention:{kind:outcome.kind,code:outcome.xCode,error:outcome.error??"Account needs attention",at:Date.now(),retries,...(wait?{recoverAt:Date.now()+wait}:{})} };
        });
      }
      await changeItem(item);
    };
    const inspect = async () => readConversation(account.sessionJson,item.id,account.xUserId,signal,run!.includeReplied ?? true,
      { cooldownMinutes,knownLastSentAt: item.lastSentAt,mode: run!.mode });
    const blocked = async (read: Awaited<ReturnType<typeof inspect>>) => {
      item.lastSentAt = Math.max(item.lastSentAt ?? 0,read.lastSentAt ?? 0) || null;
      item.diagnostics = [...(item.diagnostics ?? []),...read.diagnostics].slice(-8);
      if (!read.ok) { await fail(read); return true; }
      if (read.eligible === false || !read.message) {
        item.status = read.cooldownUntil ? "cooldown" : "skipped";
        item.cooldownUntil = read.cooldownUntil;
        item.error = read.skipReason ?? "No eligible incoming message.";
        await changeItem(item);return true;
      }
      return false;
    };
    const recheck = async () => {
      const fresh = await inspect();
      if (await blocked(fresh)) return false;
      if (fresh.message!.entryId !== item.incoming?.entryId) {
        await changeItem({ ...item,status: "skipped",error: "The incoming message changed. It will be eligible on the next scan." });
        return false;
      }
      return true;
    };
    try {
      // A crash between a write and its checkpoint is an ambiguous write.
      if (item.status === "sending") {
        const recorded = item.incoming ? await readDmDoc<Ledger>(owner,ledgerKey(account.id,item.incoming.entryId)) : null;
        if (recorded?.status === "sent") { await changeItem({ ...item,status: "sent",sentId: recorded.sentId }); return; }
        await fail({ ok: false,kind: "uncertain",error: "A previous send was interrupted. Inspect the chat before sending again." }); return;
      }
      if (scanned.get(item.id) && isRequestChat(scanned.get(item.id)!)) {
        await changeItem({ ...item,status: "skipped",error: "Message requests are excluded from DM automation." }); return;
      }
      item.status = "reading"; item.step = "read"; await changeItem(item);
      const read = await inspect();
      if (await blocked(read)) return;
      if (item.incoming && item.incoming.entryId !== read.message!.entryId && item.reposted.length) {
        await changeItem({ ...item,status: "skipped",error: "Incoming message changed while work was paused. Start a fresh run." }); return;
      }
      item.incoming = read.message!;
      item.text = run!.message.replace(/\{name\}/g,item.handle ?? item.name);
      if (!item.incoming.tweetIds.length) { await changeItem({ ...item,status: "skipped",error: "No repostable X post found in the incoming message or card." }); return; }
      if (run!.dryRun) { await changeItem({ ...item,status: "sent",dry: true,error: `Would repost ${item.incoming.tweetIds.length} post(s), then reply.` }); return; }
      const key = ledgerKey(account.id,item.incoming.entryId);
      const previous = await readDmDoc<Ledger>(owner,key);
      if(previous?.status==="sent"){
        if(item.incoming.tweetIds.every(id=>freshRepostProof(previous.repostProofs?.[id],id))){await changeItem({...item,status:"skipped",sentId:previous.sentId,reposted:previous.reposted,repostProofs:previous.repostProofs,error:"This incoming post already has a confirmed fresh repost and reply."});return}
        item.replyAlreadySent=true;item.sentId=previous.sentId;
      }
      if (previous && ["sending","uncertain"].includes(previous.status)) { await fail({ ok: false,kind: "uncertain",error: "Previous write needs verification. Automatic duplicate reply blocked." }); return; }
      item.reposted = (previous?.reposted ?? item.reposted).filter(id=>item.incoming!.tweetIds.includes(id));
      item.repostProofs = {...(previous?.repostProofs??item.repostProofs)};
      item.requestId = previous?.requestId ?? item.requestId;
      const record = async (status: Ledger["status"]) => updateDmDoc<Ledger>(owner,key,() => ({ status, reposted: [], requestId: item.requestId, text: item.text! }), old =>
        ({ ...old,status:item.replyAlreadySent?"sent":status,reposted: item.reposted,repostProofs:item.repostProofs,requestId: item.requestId,text: item.text!,sentId: item.sentId??old.sentId,startedAt: item.sendStartedAt??old.startedAt }));
      // Record that the post could not be reposted, then let the run continue to the reply.
      const skipRepost = async (tweetId: string, outcome: DmOutcome) => {
        item.reposted = item.reposted.filter(id => id !== tweetId);
        item.repostSkipped = [...new Set([...(item.repostSkipped ?? []), tweetId])];
        item.repostSkipReason = outcome.error ?? "X did not allow a repost for this post.";
        item.kind = undefined; item.error = undefined; item.retryAt = undefined; item.failedStep = undefined;
        await record("reposted");
        await changeItem(item);
      };
      for (const tweetId of item.incoming.tweetIds) {
        if(item.reposted.includes(tweetId)&&freshRepostProof(item.repostProofs?.[tweetId],tweetId)){
          item.step="repost";
          const read=await verifyRepost(account.sessionJson,tweetId,signal);item.diagnostics=[...(item.diagnostics??[]),...read.diagnostics].slice(-8);
          if(!read.ok||!read.repostProof){if(repostCanBeSkipped(read)){await skipRepost(tweetId,read);continue}await fail(read);return}
          const priorProof:DmRepostProof=item.repostProofs![tweetId];
          // SUPERBOT-strict resume: if X now points at a DIFFERENT retweet than
          // the one this proof claims, the proof is stale — do not trust the
          // bare boolean, do not continue to the DM. Drop it and fall through
          // to a fresh undo + create below, so the post is really reposted.
          if(read.repostProof.retweetId&&read.repostProof.retweetId!==priorProof.mutationId){
            item.reposted=item.reposted.filter(id=>id!==tweetId);delete item.repostProofs![tweetId];
            await record("reposted");await changeItem(item);
          } else {
            item.repostProofs={...item.repostProofs,[tweetId]:{...priorProof,...read.repostProof,action:priorProof.action,mutationAt:priorProof.mutationAt,mutationId:priorProof.mutationId}};
            if(read.repostProof.retweeted){await record("reposted");await changeItem(item);continue}
          }
          item.reposted=item.reposted.filter(id=>id!==tweetId);await record("reposted");await changeItem(item);
        }
        if (stopWave || await stopped() || Date.now() + 13000 > end) { item.status = "retry_wait"; item.retryAt = Date.now() + 1000; await changeItem(item); return; }
        if (!await recheck()) return;
        if(stopWave || await stopped()){item.status="retry_wait";item.retryAt=Date.now()+1000;await changeItem(item);return}
        item.status = "reposting"; item.step = "repost"; await record("reposting"); await changeItem(item);
        const repost = await repostTweet(account.sessionJson,tweetId,signal,{remainingMs:()=>end-Date.now(),selfId:account.xUserId});
        item.diagnostics = [...(item.diagnostics ?? []),...repost.diagnostics].slice(-8);
        if(repost.repostProof)item.repostProofs={...item.repostProofs,[tweetId]:repost.repostProof};
        if (!repost.ok) {
          if (repost.kind === "uncertain") { await record("uncertain"); await fail(repost); return; }
          // X rejected the retweet for good (404/deleted/protected). Post the reply anyway.
          if (repostCanBeSkipped(repost)) { await skipRepost(tweetId,repost); continue; }
          await fail(repost); return;
        }
        if(!freshRepostProof(repost.repostProof,tweetId)){await record("uncertain");await fail({ok:false,kind:"uncertain",error:"A fresh repost mutation was not verified. DM blocked."});return}
        item.reposted = [...new Set([...item.reposted,tweetId])];
        item.repostProofs = {...item.repostProofs,[tweetId]:repost.repostProof};
        await record("reposted"); await changeItem(item);
      }
      if(item.replyAlreadySent){item.status="sent";item.error="Fresh repost confirmed; the previously sent DM was preserved and was not sent again.";await record("sent");await changeItem(item);return}
      if (stopWave || await stopped() || Date.now() + 13000 > end) { item.status = "retry_wait"; item.retryAt = Date.now() + 1000; await changeItem(item); return; }
      if (!await recheck()) return;
      if(stopWave || await stopped()){item.status="retry_wait";item.retryAt=Date.now()+1000;await changeItem(item);return}
      // Small human-like pause between the repost and the reply.
      await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random()*1800)));
      item.status = "sending"; item.step = "send"; item.sendStartedAt = Date.now();
      await record("sending"); await changeItem(item);
      const sent = await sendDm(account.sessionJson,item.id,item.text,item.incoming.entryId,undefined,item.requestId,signal);
      item.diagnostics = [...(item.diagnostics ?? []),...sent.diagnostics].slice(-8);
      if (!sent.ok) {
        // Definitive rejections are safe to retry. Timeouts remain uncertain.
        await record(sent.kind === "uncertain" ? "uncertain" : "reposted");
        await fail(sent); return;
      }
      item.sentId = sent.id; item.status = "sent"; item.sentAt = Date.now(); item.lastSentAt = item.sentAt;
      await record("sent"); await changeItem(item);
    } catch (e) {
      // Preserve the write marker if persistence fails after a network call.
      await fail({ ok: false,kind: ["sending","reposting"].includes(item.status) ? "uncertain" : "transient",error: (e as Error).message });
    }
  };
  try {
    while (Date.now() + 15000 < end && attemptedThisCall < maxItems && !stopWave && !await stopped()) {
      run = (await readDmDoc<DmRun>(owner,`run:${id}`))!;
      if (run.items.every(terminal)) break;
      if (run.nextAt > Date.now()) {
        const wait = run.nextAt - Date.now();
        if (Date.now() + wait + 15000 >= end) break;
        await new Promise(r => setTimeout(r,wait));
        continue;
      }
      const wave = run.items.filter(i => !terminal(i) && (i.retryAt ?? 0) <= Date.now()).slice(0,Math.min(runConcurrency(run.concurrency,run.speed),maxItems - attemptedThisCall));
      if (!wave.length) break;
      attemptedThisCall += wave.length;
      await Promise.all(wave.map(processItem));
      // Jittered gap between waves so the request pattern is not a metronome.
      const gap = run.delayMs + Math.floor(run.delayMs * 0.35 * Math.random());
      await saveRun(owner,id,r => ({ ...r,nextAt: Math.max(Date.now() + gap,cooldown) }));
    }
    return await saveRun(owner,id,r => {
      if (!["running","waiting"].includes(r.status)) return r;
      const pending = r.items.filter(i => !terminal(i));
      const nextRetry = pending.length ? Math.min(...pending.map(i => i.retryAt ?? 0)) : 0;
      if (pending.length) return { ...r,nextAt: Math.max(r.nextAt,cooldown,nextRetry),status:"waiting" };
      const bad = r.items.filter(i => ["failed","uncertain"].includes(i.status));
      if (!bad.length) return { ...r,nextAt: Math.max(r.nextAt,cooldown,nextRetry),status:"finished" };
      // Only a real X restriction or a cookie/auth problem should park an account.
      // Timeouts and one-off 226s are healed automatically (bounded) so a single slow
      // request never leaves the account sitting on "Needs attention" forever.
      const hard = bad.some(i => ["restriction","auth","unsupported"].includes(i.kind ?? ""));
      const retries = r.attention?.retries ?? 0;
      // Auto-heal needs something it can actually retry: only transient/rate-limit
      // failures get requeued, and only a bounded number of times.
      const healable = r.items.filter(i => i.status === "failed" && ["transient","rate_limit"].includes(i.kind ?? "")).length;
      const heal = !hard && healable > 0 && retries < 3;
      const items = heal ? r.items.map(i => i.status === "failed" && ["transient","rate_limit"].includes(i.kind ?? "")
        ? { ...i,status:"retry_wait" as const,attempts:0,retryAt:Date.now() + Math.floor(Math.random() * 45000),
            error:undefined,kind:undefined,failedStep:undefined,updatedAt:Date.now() } : i) : r.items;
      // Every soft park carries a retry deadline while attempts remain, so the worker
      // picks it up again. After 3 attempts it parks for good and needs the operator.
      const softWait = retries < 3 ? (2 * (retries + 1) + Math.random()) * 60000 : 0;
      const recoverAt = heal ? softWait
        : hard ? (attentionRecoveryMs(bad[0].kind,r.attention?.code ?? 0,retries + 1) || undefined)
        : (softWait || undefined);
      return { ...r,items,nextAt: Math.max(r.nextAt,cooldown,nextRetry),status: heal ? "waiting" : "needs_attention",
        attention: { kind: bad[0].kind,code: r.attention?.code,error: bad[0].error ?? "Some chats failed",
          at: Date.now(),retries: retries + 1,...(recoverAt ? { recoverAt } : {}) } };
    });
  } finally { await releaseAccount(owner,account.id,lease.token,cooldown); }
}
