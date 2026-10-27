import {acquireAccount,releaseAccount,listSessions,listDmRecords,deleteDmRecords,type DmRecord} from "./dm-store.ts";
import {controlDmRun} from "./dm-run.ts";

const unresolved=(payload:any)=>["sending","reposting","uncertain"].includes(payload?.status)||payload?.kind==="uncertain"
  || Array.isArray(payload?.items)&&payload.items.some((item:any)=>["sending","reposting","uncertain"].includes(item.status)||item.kind==="uncertain");
export function planDmHistory(records:DmRecord[],accountIds:string[],before:number) {
  const ids=new Set(accountIds),selected:DmRecord[]=[],protectedRecords:DmRecord[]=[];
  for(const row of records) {
    const belongs=accountIds.some(id=>row.key===`scan:${id}`||row.key.startsWith(`chat:${id}:`)||row.key.startsWith(`entry:${id}:`))
      || row.key.startsWith("run:")&&ids.has(row.payload?.accountId);
    if(!belongs||row.updatedAt>=before)continue;
    if(unresolved(row.payload))protectedRecords.push(row);else selected.push(row);
  }
  const runs=new Set(selected.filter(r=>r.key.startsWith("run:")).map(r=>r.payload.id));
  for(const row of records)if(accountIds.some(id=>row.key===`latest:${id}`)&&runs.has(row.payload?.id))selected.push(row);
  return {selected,protectedRecords};
}
export async function manageDmHistory(owner:string,input:{id?:string;allAccounts?:boolean;before:number;confirm?:boolean}) {
  const before=Number(input.before);
  if(!Number.isFinite(before)||before<946684800000||before>Date.now())throw new Error("Choose a valid cutoff at or before today.");
  const sessions=await listSessions(owner);
  const accounts=input.allAccounts?sessions:sessions.filter(a=>a.id===input.id);
  if(!accounts.length)throw new Error("Account not found");
  const ids=accounts.map(a=>a.id).sort(),leases:Array<{id:string;token:string}>=[];
  try{
    if(input.confirm)for(const id of ids){const lease=await acquireAccount(owner,id);leases.push({id,token:lease.token})}
    const records=await listDmRecords(owner);
    const active=records.filter(r=>r.key.startsWith("run:")&&ids.includes(r.payload?.accountId)&&["running","waiting","paused"].includes(r.payload?.status));
    const plan=planDmHistory(records,ids,before);
    if(input.confirm&&active.length)throw new Error("Stop started or paused runs on the selected accounts before clearing history.");
    const removed=input.confirm?await deleteDmRecords(owner,plan.selected):0;
    return {before,accountIds:ids,accounts:accounts.length,eligible:plan.selected.length,protected:plan.protectedRecords.length,
      blocked:active.length>0,removed,counts:{scans:plan.selected.filter(r=>r.key.startsWith("scan:")).length,
      chats:plan.selected.filter(r=>r.key.startsWith("chat:")).length,entries:plan.selected.filter(r=>r.key.startsWith("entry:")).length,
      runs:plan.selected.filter(r=>r.key.startsWith("run:")).length}};
  }finally{await Promise.allSettled(leases.map(l=>releaseAccount(owner,l.id,l.token)))}
}

// Operator "Clear data" — the backend equivalent of the extension's reset button.
// Wipes processed-chat markers, repost proofs/counters, the processed-message ledger
// and run history for the chosen accounts so those chats become eligible again.
// The saved reply/settings always stay; the last inbox scan stays unless asked.
const accountOf=(key:string,prefix:string)=>key.slice(prefix.length).split(":")[0];
export function planDmFullClear(records:DmRecord[],accountIds:string[],includeScans:boolean) {
  const ids=new Set(accountIds),selected:DmRecord[]=[];
  for(const row of records) {
    const k=row.key;
    if(k.startsWith("run:")){if(ids.has(String(row.payload?.accountId??"")))selected.push(row);continue}
    if(k.startsWith("latest:")){if(ids.has(k.slice(7)))selected.push(row);continue}
    if(k.startsWith("chat:")){if(ids.has(accountOf(k,"chat:")))selected.push(row);continue}
    if(k.startsWith("entry:")){if(ids.has(accountOf(k,"entry:")))selected.push(row);continue}
    if(k.startsWith("lease:")){if(ids.has(k.slice(6)))selected.push(row);continue}
    if(includeScans&&k.startsWith("scan:")&&ids.has(k.slice(5)))selected.push(row);
  }
  return selected;
}
export async function clearDmData(owner:string,input:{id?:string;allAccounts?:boolean;includeScans?:boolean;confirm?:boolean}) {
  const sessions=await listSessions(owner);
  const accounts=input.allAccounts?sessions:sessions.filter(a=>a.id===input.id);
  if(!accounts.length)throw new Error("Account not found");
  const ids=accounts.map(a=>a.id).sort(),leases:Array<{id:string;token:string}>=[];
  const includeScans=input.includeScans!==false;
  const countsOf=(rows:DmRecord[])=>({runs:rows.filter(r=>r.key.startsWith("run:")).length,chats:rows.filter(r=>r.key.startsWith("chat:")).length,
    entries:rows.filter(r=>r.key.startsWith("entry:")).length,scans:rows.filter(r=>r.key.startsWith("scan:")).length});
  try{
    // Hold every affected lease so the worker cannot write while we wipe.
    if(input.confirm)for(const id of ids){const lease=await acquireAccount(owner,id,{ignoreCooldown:true});leases.push({id,token:lease.token})}
    const before=await listDmRecords(owner);
    const active=before.filter(r=>r.key.startsWith("run:")&&ids.includes(r.payload?.accountId)
      &&["running","waiting","paused","needs_attention"].includes(r.payload?.status));
    // Stop in-flight work first, then re-read so we delete the post-cancel versions.
    if(input.confirm)for(const r of active)await controlDmRun(owner,String(r.payload.id),"cancel");
    const records=input.confirm?await listDmRecords(owner):before;
    const selected=planDmFullClear(records,ids,includeScans);
    const removed=input.confirm?await deleteDmRecords(owner,selected):0;
    return {mode:"full" as const,accountIds:ids,accounts:accounts.length,eligible:selected.length,removed,stopped:active.length,
      includeScans,counts:countsOf(selected)};
  }finally{await Promise.allSettled(leases.map(l=>releaseAccount(owner,l.id,l.token)))}
}
