export type DmIncomingMessage = {
  conversationId: string; entryId: string; senderId: string;
  createdAt: number; text: string; tweetIds: string[]; encrypted: boolean;
  postUrls?: string[]; postCard?: boolean;
};
export type DmScanScope = "unread" | "all";
export type DmFailure = "rate_limit" | "auth" | "restriction" | "transient" | "permanent" | "uncertain" | "unsupported" | "post_rejected";
export type DmOutcome = {
  ok: boolean; id?: string; via?: string; error?: string;
  kind?: DmFailure; retryAt?: number; status?: number; xCode?: number;
  unavailable?: boolean; deferred?: boolean;
};
export type DmRepostProof = { tweetId: string; retweeted: boolean; checkedAt: number; retweetId?: string;
  action?: "created" | "refreshed" | "observed"; mutationAt?: number; mutationId?: string };
export function recordedRepostMutation(proof:DmRepostProof|undefined,tweetId:string):proof is DmRepostProof{return !!proof&&proof.tweetId===tweetId&&!!proof.mutationAt&&!!proof.mutationId&&["created","refreshed"].includes(proof.action??"")}
export function freshRepostProof(proof:DmRepostProof|undefined,tweetId:string):proof is DmRepostProof{return recordedRepostMutation(proof,tweetId)&&proof.retweeted&&proof.checkedAt>0&&proof.retweetId===proof.mutationId}
// SUPERBOT parity, made strict: a bare `retweeted: true` is NOT proof of a fresh
// repost. X must report that the retweet it currently shows for this post IS the
// retweet this run just created. A different retweet id (old manual repost, stale
// read, reused id) means the proof is stale and must never count as fresh. Proofs
// recorded before this rule (no retweetId, or retweetId != mutationId) are therefore
// unverified by definition; re-checking code must redo the repost, not carry them.
export function staleRepostProof(proof:DmRepostProof|undefined,tweetId:string):boolean{return !!proof&&proof.tweetId===tweetId&&["created","refreshed"].includes(proof.action??"")&&proof.retweetId!==proof.mutationId}
export function newestDmFirst(a:{sortAt?:number|null;lastAt?:number|null;sortEventId?:string;lastEntryId?:string},b:{sortAt?:number|null;lastAt?:number|null;sortEventId?:string;lastEntryId?:string}) {
  const time=(b.sortAt??b.lastAt??0)-(a.sortAt??a.lastAt??0);
  if(time)return time;
  const left=a.sortEventId??a.lastEntryId??"0",right=b.sortEventId??b.lastEntryId??"0";
  if(/^\d+$/.test(left)&&/^\d+$/.test(right))return BigInt(right)>BigInt(left)?1:BigInt(right)<BigInt(left)?-1:0;
  return 0;
}
export function canTryDmFallback(result: DmOutcome) {
  if (result.ok || result.kind !== "permanent") return false;
  // Explicit HTTP/schema rejections permit another encoding. Rate limits,
  // auth failures, restrictions and ambiguous writes never do.
  return [400,404,405,415].includes(result.status ?? 0) ||
    /unknown argument|not defined by type|cannot query field|persisted.?query.?not.?found/i.test(result.error ?? "");
}
export function boundedInt(v: unknown, fallback: number, min: number, max: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
export function normalizeDmCookies(input: unknown): Array<{ name: string; value: string }> {
  if (typeof input === "string") {
    try { return normalizeDmCookies(JSON.parse(input)); } catch { /* cookie header */ }
    return input.split(";").flatMap(part => {
      const i = part.indexOf("=");
      return i > 0 ? [{ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() }] : [];
    });
  }
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input)) return input.filter(c => typeof c?.name === "string" && typeof c?.value === "string");
  const obj = input as Record<string, unknown>;
  if (obj.cookies) return normalizeDmCookies(obj.cookies);
  return Object.entries(obj).filter(([k,v]) => ["auth_token", "ct0", "twid", "kdt"].includes(k) && typeof v === "string")
    .map(([name,value]) => ({ name, value: String(value) }));
}
export function cookieHeader(input: unknown) {
  return normalizeDmCookies(input).filter(c => /^[\w-]+$/.test(c.name) && !/[\r\n;]/.test(c.value)).map(c => `${c.name}=${c.value}`).join("; ");
}
export function csrfFromSession(input: unknown) { return normalizeDmCookies(input).find(c => c.name === "ct0")?.value ?? ""; }
export function tweetIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) return null;
    return url.pathname.match(/^\/(?:[^/]+\/status(?:es)?|i\/web\/status)\/(\d+)(?:\/|$)/i)?.[1] ?? null;
  } catch { return null; }
}
// Inspect explicit tweet references and URL/card fields. Never interpret arbitrary
// numeric IDs (media IDs, user IDs, card IDs) as post IDs.
export function extractTweetIds(value: unknown): string[] {
  const ids = new Set<string>();
  const walk = (node: unknown, key = "", depth = 0) => {
    if (depth > 14 || node == null) return;
    if (typeof node === "string") {
      if (/^(?:tweet_id|tweet_id_str|tweetId|status_id|status_id_str)$/.test(key) && /^\d+$/.test(node)) ids.add(node);
      for (const url of node.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
        const id = tweetIdFromUrl(url.replace(/[),.!?]+$/, ""));
        if (id) ids.add(id);
      }
    } else if (Array.isArray(node)) node.forEach(n => walk(n, key, depth + 1));
    else if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (/^(?:user|user_results|userResult|quoted_status|quoted_status_result|retweeted_status|retweeted_status_result)$/.test(key)) return;
      if (/^(?:tweet|tweet_results|tweetResult)$/.test(key)) {
        const status = obj.status as Record<string,unknown> | undefined;
        const result = obj.result as Record<string,unknown> | undefined;
        const id = obj.id_str ?? obj.rest_id ?? obj.id ?? status?.id_str ?? result?.rest_id;
        if ((typeof id === "string" && /^\d+$/.test(id)) || (typeof id === "number" && Number.isSafeInteger(id))) { ids.add(String(id)); return; }
      }
      if (typeof obj.key === "string" && /^(?:tweet_id|status_id)$/.test(obj.key)) {
        const binding = (obj.value as any)?.string_value ?? obj.string_value;
        if(typeof binding === "string" && /^\d+$/.test(binding))ids.add(binding);
      }
      for (const [k,v] of Object.entries(obj)) walk(v, k, depth + 1);
    }
  };
  walk(value);
  return [...ids];
}
export function extractDmPostUrls(value:unknown):string[] {
  const urls=new Set<string>();
  const add=(value:unknown)=>{if(typeof value!=="string")return;for(const raw of value.match(/https?:\/\/[^\s<>"']+/g)??[]){const url=raw.replace(/[),.!?\]]+$/g,"");try{const parsed=new URL(url);if(/^(?:t\.co|(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com))$/i.test(parsed.hostname))urls.add(url)}catch{}}};
  const walk=(node:any,key="",depth=0)=>{
    if(depth>12||!node)return;
    if(/^(?:user|user_results|userResult|quoted_status|quoted_status_result|retweeted_status|retweeted_status_result)$/.test(key))return;
    if(typeof node==="string"){add(node);return}
    if(Array.isArray(node)){node.forEach(n=>walk(n,key,depth+1));return}
    if(typeof node!=="object")return;
    if(/^(?:tweet|tweet_results|tweetResult)$/.test(key)){add(node.expanded_url);add(node.url);const id=node.id_str??node.rest_id??node.id??node.status?.id_str??node.result?.rest_id;if(typeof id==="string"&&/^\d+$/.test(id)){urls.add(`https://x.com/i/web/status/${id}`);return}}
    for(const [name,v]of Object.entries(node))walk(v,name,depth+1);
  };walk(value);return [...urls];
}
export function incomingMessages(root: any): DmIncomingMessage[] {
  return (Array.isArray(root?.entries) ? root.entries : []).flatMap((entry: any) => {
    const message = entry?.message;
    if (!message) return [];
    const data = message.message_data ?? message.messageData ?? {};
    const entryId = String(message.id ?? message.id_str ?? entry.entry_id ?? "");
    const conversationId = String(message.conversation_id ?? message.conversationId ?? "");
    const senderId = String(data.sender_id ?? message.sender_id ?? "");
    if (!entryId || !conversationId || !senderId) return [];
    const rawTime = Number(message.time ?? data.time ?? 0);
    return [{ conversationId, entryId, senderId,
      createdAt: rawTime > 0 && rawTime < 1e12 ? rawTime * 1000 : rawTime,
      text: String(data.text ?? ""), tweetIds: extractTweetIds(data).slice(-1),postUrls:extractDmPostUrls(data),postCard:!!data.attachment?.tweet,
      encrypted: !!(data.encrypted_message || data.ciphertext || message.encrypted || data.encrypted) }];
  }).sort((a: DmIncomingMessage,b: DmIncomingMessage) => b.createdAt - a.createdAt || b.entryId.localeCompare(a.entryId));
}
export function classifyXResponse(status: number, body: any, headers: Headers, now = Date.now()): DmOutcome | null {
  const errors = body?.errors ?? (body?.error ? [body.error] : []);
  const list = Array.isArray(errors) ? errors : [errors];
  const code = Number(list[0]?.code ?? body?.code) || undefined;
  if (status >= 200 && status < 300 && !list.length) return null;
  const error = String(list[0]?.message ?? body?.detail ?? body?.title ?? (typeof body?.error === "string" ? body.error : `X HTTP ${status}`));
  let kind: DmFailure = status === 429 || code === 88 ? "rate_limit"
    : status === 401 || code === 32 || code === 89 ? "auth"
    : code === 226 || code === 326 || code === 344 ? "restriction"
    : status >= 500 ? "transient" : "permanent";
  if (/rate.limit|too many requests/i.test(error)) kind = "rate_limit";
  const retry = headers.get("retry-after");
  const reset = Number(headers.get("x-rate-limit-reset")) * 1000;
  const retryAt = kind === "rate_limit" ? Math.max(now + 60_000,
    retry ? (Number.isFinite(Number(retry)) ? now + Number(retry) * 1000 : Date.parse(retry) || 0) : 0,
    Number.isFinite(reset) ? reset : 0) : undefined;
  return { ok: false, kind, status, xCode: code, error, retryAt };
}
export function indexOperationPairs(js: string): Record<string, string> {
  const result: Record<string,string> = {};
  for (const m of js.matchAll(/queryId:["']([A-Za-z0-9_-]{8,64})["'],operationName:["']([A-Za-z0-9_]+)["']/g)) result[m[2]] = m[1];
  for (const m of js.matchAll(/operationName:["']([A-Za-z0-9_]+)["'],queryId:["']([A-Za-z0-9_-]{8,64})["']/g)) result[m[1]] = m[2];
  for (const m of js.matchAll(/\/i\/api\/graphql\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_]+)/g)) result[m[2]] = m[1];
  return result;
}
