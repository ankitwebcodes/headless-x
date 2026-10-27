import { resolveDmOperation } from "./dm-operations.ts";
import {resolveDmPost} from "./dm-posts.ts";
import { conversationActivity,cooldownEnds,isRequestChat,inboxActivity } from "./dm-policy.ts";
import { cookieHeader, csrfFromSession, boundedInt, classifyXResponse, incomingMessages, canTryDmFallback,
  newestDmFirst,type DmRepostProof,type DmIncomingMessage, type DmOutcome, type DmScanScope } from "./dm-core.ts";
export { cookieHeader, csrfFromSession } from "./dm-core.ts";
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BASE = "https://x.com/i/api/1.1/dm";
const PARAMS = "filter_low_quality=true&include_quality=all&include_groups=true&include_inbox_timelines=true&supports_reactions=true&supports_edit=true";
export type DmDiagnostic = { label: string; url: string; status: number; ok: boolean; error?: string; bodyPreview?: string };
export type DmUser = { id: string; handle: string; name: string };
export type DmChat = {
  id: string; kind: "1:1" | "group"; handle: string | null; name: string; status: string;
  active: boolean; inactive: boolean; unread: number; unseen: boolean;
  lastSenderId: string | null; fromMe: boolean; lastText: string; lastAt: number | null;
  lastEntryId?: string; tweetIds?: string[]; encrypted?: boolean; participants: DmUser[];
  lastSentAt?: number | null; lastReadEntryId?: string | null; unreadKnown?: boolean; isRequest?: boolean;
  sortAt?: number | null; sortEventId?: string;
};
export type DmStats = { total: number; active: number; inactive: number; groups: number; unseen: number; unreadTotal: number };
export type DmScanPages = {
  walked: number; trusted: string; untrusted: string; truncated: boolean;
  cursors: { trusted: string | null; untrusted: string | null };
  scope?: DmScanScope; stoppedEarly?: string;
};
export type DmScanResult = {
  ok: boolean; error?: string; self?: { id: string; username: string }; stats: DmStats;
  chats: DmChat[]; diagnostics: DmDiagnostic[]; via?: string; pages?: DmScanPages;
  retryAt?: number; kind?: DmOutcome["kind"]; scannedAt?: number;
};
export function statsOf(chats: DmChat[]): DmStats {
  return { total: chats.length, active: chats.filter(c => c.active).length, inactive: chats.filter(c => c.inactive).length,
    groups: chats.filter(c => c.kind === "group").length, unseen: chats.filter(c => c.unseen).length,
    unreadTotal: chats.reduce((n,c) => n + c.unread, 0) };
}
function headers(session: unknown, extra: Record<string,string> = {}) {
  return { cookie: cookieHeader(session), authorization: `Bearer ${BEARER}`, "x-csrf-token": csrfFromSession(session),
    "x-twitter-active-user": "yes", "x-twitter-auth-type": "OAuth2Session", "x-twitter-client-language": "en",
    "user-agent": UA, origin: "https://x.com", referer: "https://x.com/messages", "content-type": "application/json", ...extra };
}
export type DmSendResult = DmOutcome & { diagnostics: DmDiagnostic[]; repostProof?: DmRepostProof };
async function request(session: unknown, url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ result: DmOutcome; body: any; diagnostic: DmDiagnostic }> {
  const mutation = (init.method ?? "GET") !== "GET";
  try {
    const response = await fetch(url, { ...init, headers: { ...headers(session), ...init.headers }, cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), redirect: "error" });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = null; }
    const failure = classifyXResponse(response.status, body, response.headers);
    // A server error after a write can mean the write succeeded. Never blindly retry it.
    const result: DmOutcome = failure ? { ...failure, kind: mutation && response.status >= 500 ? "uncertain" : failure.kind } : { ok: true, status: response.status };
    if (result.ok && body == null) Object.assign(result, { ok: false, kind: mutation ? "uncertain" : "transient", error: "X returned a non-JSON response." });
    return { result, body, diagnostic: { label: mutation ? "X mutation" : "X read", url: url.split("?")[0], status: response.status, ok: result.ok, error: result.error,
      ...(!result.ok && !body ? { bodyPreview: text.slice(0,240) } : {}) } };
  } catch (e) {
    const error = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError" ? "X request timed out." : "X network request failed.";
    return { result: { ok: false, kind: mutation ? "uncertain" : "transient", error }, body: null,
      diagnostic: { label: "X request", url: url.split("?")[0], status: 0, ok: false, error } };
  }
}
const operationId = resolveDmOperation;
export async function verifyDmSession(session: unknown): Promise<{ ok: boolean; id?: string; username?: string; reason?: string }> {
  if (!cookieHeader(session) || !csrfFromSession(session)) return { ok: false, reason: "Missing auth_token / ct0." };
  const { result, body } = await request(session, "https://x.com/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false");
  if (result.ok && body?.id_str) return { ok: true, id: String(body.id_str), username: String(body.screen_name ?? "") };
  if (result.kind === "rate_limit" || result.kind === "auth" || result.kind === "restriction") return { ok: false, reason: result.error };
  const qid = await operationId("Viewer", session) || "TpQxQtWMTMnIAMPlMGMqNw";
  const viewer = await request(session, `https://x.com/i/api/graphql/${qid}/Viewer?variables=${encodeURIComponent(JSON.stringify({ withCommunitiesMemberships: false }))}`);
  const user = viewer.body?.data?.viewer?.user_results?.result;
  return viewer.result.ok && user?.rest_id ? { ok: true, id: String(user.rest_id), username: String(user.legacy?.screen_name ?? user.core?.screen_name ?? "") }
    : { ok: false, reason: viewer.result.error ?? "Could not verify the X account identity." };
}
function chatsFromPage(root: any, selfId: string): DmChat[] {
  const users = root?.users ?? {};
  const messages = incomingMessages(root);
  const latest = new Map<string,DmIncomingMessage>();
  for (const message of messages) if (!latest.has(message.conversationId)) latest.set(message.conversationId, message);
  return Object.entries(root?.conversations ?? {}).map(([id,raw]) => {
    const c = raw as any;
    const pIds: string[] = (c.participants ?? []).map((p: any) => String(p.user_id ?? p.userId ?? "")).filter(Boolean);
    const participants: DmUser[] = pIds.filter(p => p !== selfId).map(p => ({ id: p, handle: String(users[p]?.screen_name ?? ""), name: String(users[p]?.name ?? "") }));
    const last = latest.get(id);
    const activity = conversationActivity(c,messages.filter(m => m.conversationId === id),selfId);
    const isRequest = c.low_quality === true || c.trusted === false || c.not_trusted === true;
    const lastAt = last?.createdAt ?? (Number(c.sort_timestamp) || null);
    const group = pIds.length > 2 || c.type === "GROUP_DM";
    return { id, kind: group ? "group" as const : "1:1" as const, handle: participants[0]?.handle || null,
      name: group ? String(c.name || `Group (${pIds.length})`) : participants[0]?.name || participants[0]?.handle || "unknown",
      status: isRequest ? "REQUEST" : c.read_only ? "READ_ONLY" : "TRUSTED",
      ...inboxActivity(lastAt),isRequest, ...activity,
      unseen: !!last && last.senderId !== selfId, lastSenderId: last?.senderId ?? null,
      fromMe: last?.senderId === selfId, lastText: last?.text ?? "", lastAt,sortAt:Number(c.sort_timestamp)||lastAt,sortEventId:String(c.sort_event_id??c.max_entry_id??last?.entryId??"0"),
      lastEntryId: last?.entryId, tweetIds: last?.tweetIds ?? [], encrypted: last?.encrypted ?? !!c.is_encrypted, participants };
  });
}
export function inboxOnlyScan(scan: DmScanResult): DmScanResult {
  const chats = scan.chats.filter(c => !isRequestChat(c)).map(c => ({ ...c,isRequest: false,...inboxActivity(c.lastAt) })).sort(newestDmFirst);
  return { ...scan,chats,stats: statsOf(chats),...(scan.pages ? { pages: { ...scan.pages,untrusted: "AT_END",cursors: { ...scan.pages.cursors,untrusted: null },truncated: scan.pages.trusted !== "AT_END" } } : {}) };
}
export type DmScanOptions = {
  self?: { id: string; username: string }; previous?: DmScanResult;
  resume?: { trusted?: string | null; untrusted?: string | null }; passcode?: string;
  scope?: DmScanScope;
  maxPages?: number; maxChats?: number; budgetMs?: number; pageDelayMs?: number;
  onPage?: (result: DmScanResult) => Promise<void>;
};
export async function scanInbox(session: unknown, opts: DmScanOptions = {}): Promise<DmScanResult> {
  const started = Date.now();
  const budget = boundedInt(opts.budgetMs, 50000, 3000, 55000);
  const signal = AbortSignal.timeout(budget);
  const maxPages = boundedInt(opts.maxPages, 80, 1, 500);
  const maxChats = boundedInt(opts.maxChats, 20000, 1, 20000);
  // Never go below 250ms per page: that is the pacing X tolerates before code 88.
  const delay = boundedInt(opts.pageDelayMs, 250, 250, 5000);
  const self = opts.self;
  // "unread" stops walking once the unread window is exhausted, so an account with
  // 1000+ chats still returns a full unread report in seconds instead of minutes.
  const scope: DmScanScope = opts.scope === "unread" ? "unread" : "all";
  let stoppedEarly: string | undefined;
  let quietPages = 0;
  const chats = new Map((opts.previous ? inboxOnlyScan(opts.previous).chats : []).map(c => [c.id,c]));
  const diagnostics: DmDiagnostic[] = [];
  const cursors = { trusted: null as string | null, untrusted: null as string | null };
  const statuses = { trusted: "AT_END", untrusted: "AT_END" };
  let walked = 0;
  let failure: DmOutcome | undefined;
  const result = (): DmScanResult => {
    const list = [...chats.values()].sort(newestDmFirst);
    return { ok: !!self, self, chats: list, stats: statsOf(list), via: "rest", scannedAt: Date.now(),
      diagnostics: diagnostics.slice(-12), error: failure?.error, retryAt: failure?.retryAt, kind: failure?.kind,
      pages: { walked: (opts.previous?.pages?.walked ?? 0) + walked, ...statuses,
        truncated: statuses.trusted !== "AT_END" || statuses.untrusted !== "AT_END", cursors: { ...cursors }, scope, stoppedEarly } };
  };
  if (!self) return { ...result(), ok: false, error: "Verified account identity is required. Reconnect the cookies." };
  // Returns how many brand-new unread chats this page contributed, so the unread
  // scan can stop once the recency window stops producing any.
  const absorb = (root: any) => {
    let freshUnread = 0;
    for (const chat of chatsFromPage(root, self.id)) {
      if (isRequestChat(chat)) { chats.delete(chat.id); continue; }
      const old = chats.get(chat.id);
      if (!old || newestDmFirst(chat,old)<=0) {
        if (!old && (chat.unread ?? 0) > 0) freshUnread++;
        chats.set(chat.id, { ...chat,lastSentAt: Math.max(chat.lastSentAt ?? 0,old?.lastSentAt ?? 0) || null });
      }
    }
    return freshUnread;
  };
  if (opts.previous?.pages || opts.resume) {
    for (const kind of ["trusted"] as const) {
      cursors[kind] = opts.previous?.pages?.cursors[kind] ?? opts.resume?.[kind] ?? null;
      statuses[kind] = cursors[kind] ? "HAS_MORE" : "AT_END";
    }
  } else {
    const page = await request(session, `${BASE}/inbox_initial_state.json?${PARAMS}`, {}, signal);
    diagnostics.push(page.diagnostic);
    if (!page.result.ok) return { ...result(), ok: false, error: page.result.error, kind: page.result.kind, retryAt: page.result.retryAt };
    const root = page.body?.inbox_initial_state;
    if (!root?.conversations || !root?.inbox_timelines) return { ...result(), ok: false, error: "Unrecognized X inbox response; no scan state was advanced." };
    const found = absorb(root);
    if (scope === "unread" && found === 0) quietPages++;
    for (const kind of ["trusted"] as const) {
      const timeline = root.inbox_timelines[kind];
      cursors[kind] = timeline?.status === "HAS_MORE" && timeline?.min_entry_id ? String(timeline.min_entry_id) : null;
      statuses[kind] = timeline?.status === "HAS_MORE" ? (cursors[kind] ? "HAS_MORE" : "ERROR") : "AT_END";
    }
    if (opts.onPage) await opts.onPage(result());
  }
  // Requests are never paginated, including when resuming an older scan.
  while (walked < maxPages && Date.now() - started < budget - 1500 && chats.size < maxChats && !failure && !stoppedEarly) {
    let progressed = false;
    for (const kind of ["trusted"] as const) {
      const cursor = cursors[kind];
      if (!cursor || statuses[kind] !== "HAS_MORE" || walked >= maxPages || signal.aborted) continue;
      if (Date.now() - started + delay + 1500 >= budget) break;
      await new Promise(r => setTimeout(r, delay));
      const page = await request(session, `${BASE}/inbox_timeline/${kind}.json?${PARAMS}&max_id=${encodeURIComponent(cursor)}`, {}, signal);
      diagnostics.push(page.diagnostic);
      if (!page.result.ok) { failure = page.result; statuses[kind] = "ERROR"; break; }
      const root = page.body?.inbox_timeline;
      if (!root || !Array.isArray(root.entries) || typeof root.status !== "string") {
        failure = { ok: false, kind: "transient", error: "Unrecognized inbox page; cursor preserved." }; statuses[kind] = "ERROR"; break;
      }
      const freshUnread = absorb(root); walked++; progressed = true;
      if (scope === "unread") {
        quietPages = freshUnread > 0 ? 0 : quietPages + 1;
        if (quietPages >= 8) { stoppedEarly = "unread-window"; break; }
      }
      const next = root.min_entry_id ? String(root.min_entry_id) : null;
      if (root.status !== "HAS_MORE") { cursors[kind] = null; statuses[kind] = "AT_END"; }
      else if (!next || next === cursor || /^\d+$/.test(next)&&/^\d+$/.test(cursor)&&BigInt(next)>=BigInt(cursor)) { statuses[kind] = "ERROR"; failure = { ok: false, kind: "transient", error: "Inbox cursor did not move toward older chats; resume later." }; }
      else { cursors[kind] = next; }
      if (opts.onPage) await opts.onPage(result());
      if (failure) break;
    }
    if (!progressed) break;
  }
  const final = result();
  if (opts.onPage) await opts.onPage(final);
  return final;
}
export type DmReadOptions = { cooldownMinutes?: number; knownLastSentAt?: number | null; mode?: string };
export type DmReadResult = DmOutcome & { message?: DmIncomingMessage; diagnostics: DmDiagnostic[];
  lastSentAt?: number | null; cooldownUntil?: number; eligible?: boolean; skipReason?: string };
export async function readConversation(session: unknown, conversationId: string, selfId: string, signal?: AbortSignal, includeReplied = false, options: DmReadOptions = {}): Promise<DmReadResult> {
  if (!/^[\d-]+$/.test(conversationId)) return { ok: false, kind: "permanent", error: "Invalid conversation ID.", diagnostics: [] };
  const minutes = boundedInt(options.cooldownMinutes,0,0,1440);
  const now = Date.now(),cutoff = now - minutes * 60000;
  let lastSentAt = options.knownLastSentAt ?? null;
  const diagnostics: DmDiagnostic[] = [];
  const initialCooldown = cooldownEnds(lastSentAt,minutes,now);
  if (initialCooldown) return { ok: true,eligible: false,lastSentAt,cooldownUntil: initialCooldown,skipReason: "Conversation cooldown is active.",diagnostics };
  let cursor: string | null = null;
  let firstRoot: any;
  const collected = new Map<string,DmIncomingMessage>();
  let verifiedWindow = minutes === 0;
  for (let page = 0; page < 8; page++) {
    const url = `${BASE}/conversation/${encodeURIComponent(conversationId)}.json?count=50&context=FETCH_DM_CONVERSATION_HISTORY&include_conversation_info=true&include_entities=true&cards_platform=Web-12${cursor ? `&max_id=${encodeURIComponent(cursor)}` : ""}`;
    const response = await request(session,url,{},signal);
    diagnostics.push(response.diagnostic);
    if (!response.result.ok) return { ...response.result,diagnostics,lastSentAt };
    const root = response.body?.conversation_timeline ?? response.body?.dm_conversation ?? response.body;
    if (!firstRoot) firstRoot = root;
    const metadata = root?.conversations?.[conversationId];
    if (metadata?.trusted === false || metadata?.not_trusted === true || metadata?.low_quality === true)
      return { ok: true,eligible: false,lastSentAt,skipReason: "Message requests are excluded from DM automation.",diagnostics };
    const pageMessages = incomingMessages(root).filter(m => m.conversationId === conversationId);
    for (const m of pageMessages) collected.set(m.entryId,m);
    const outgoing = pageMessages.filter(m => m.senderId === selfId);
    if (outgoing.length) { lastSentAt = Math.max(lastSentAt ?? 0,...outgoing.map(m => m.createdAt)); verifiedWindow = true; }
    const until = cooldownEnds(lastSentAt,minutes,now);
    if (until) return { ok: true,eligible: false,lastSentAt,cooldownUntil: until,skipReason: "Conversation cooldown is active.",diagnostics };
    const oldest = Math.min(...pageMessages.map(m => m.createdAt).filter(t => t > 0));
    if (minutes === 0 || oldest <= cutoff || root?.status === "AT_END" || (root?.status !== "HAS_MORE" && pageMessages.length < 50)) verifiedWindow = true;
    if (verifiedWindow) break;
    const next = root?.min_entry_id ? String(root.min_entry_id) : null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  if (!verifiedWindow) return { ok: false,kind: "transient",error: "Could not verify the full cooldown window. No repost or reply was attempted.",diagnostics,lastSentAt };
  const messages = [...collected.values()].sort((a,b) => b.createdAt - a.createdAt || b.entryId.localeCompare(a.entryId));
  const conversation = firstRoot?.conversations?.[conversationId];
  const activity = conversationActivity(conversation,messages,selfId);
  if (options.mode === "unread" && (!activity.unreadKnown || activity.unread <= 0))
    return { ok: true,eligible: false,lastSentAt,skipReason: activity.unreadKnown ? "Chat has already been read." : "X did not provide a reliable read state for this chat.",diagnostics };
  if (options.mode === "inactive" && !inboxActivity(messages[0]?.createdAt,now).inactive)
    return { ok: true,eligible: false,lastSentAt,skipReason: "Chat has activity in the last 24 hours.",diagnostics };
  if(!includeReplied&&messages[0]?.senderId===selfId)return {ok:true,eligible:false,lastSentAt,skipReason:"Latest message is outgoing; no unanswered incoming message.",diagnostics};
  const incoming=messages.filter(m=>m.senderId!==selfId);
  let latest=incoming[0];
  if (!latest) return { ok: true,eligible: false,lastSentAt,skipReason: "No incoming message in the available conversation history.",diagnostics };
  for(const candidate of incoming){
    if(candidate.encrypted)return {ok:false,kind:"unsupported",error:"The latest received conversation content is encrypted; an older post must not be substituted.",diagnostics,lastSentAt};
    const resolved=await resolveDmPost(candidate,signal);
    if(!resolved.ok)return {...resolved,diagnostics,lastSentAt};
    if(resolved.tweetId){latest={...candidate,tweetIds:[resolved.tweetId]};break}
  }
  return { ok: true,eligible: true,message: latest,lastSentAt,diagnostics };
}

function ackId(body: any): string | undefined {
  const root = body?.inbox_initial_state ?? body?.conversation_timeline ?? body;
  const id = root?.entries?.find((e: any) => e.message)?.message?.id ?? root?.entry?.message?.id ?? body?.data?.sendMessage?.message?.id
    ?? body?.data?.useSendMessageMutation?.message?.id ?? body?.data?.dmSendMessage?.message?.id;
  return id ? String(id) : undefined;
}
export async function sendDm(session: unknown, conversationId: string, text: string, replyToEntryId?: string | null,
  _passcode?: string, requestId = crypto.randomUUID(), signal?: AbortSignal): Promise<DmSendResult> {
  const diagnostics: DmDiagnostic[] = [];
  // Only explicit unsupported-operation/encoding responses allow a fallback.
  const attempts: Array<{ url: string; init: RequestInit; via: string }> = [];
  const url = `${BASE}/new2.json`;
  const body = { text, conversation_id: conversationId, request_id: requestId, cards_platform: "Web-12",
    dm_users: false,recipient_ids: false,include_cards: 1,include_quote_count: true,
    ...(replyToEntryId ? { reply_to_dm_id: replyToEntryId } : {}) };
  attempts.push({ url, via: "rest", init: { method: "POST", body: JSON.stringify(body) } });
  attempts.push({ url, via: "rest-form", init: { method: "POST", body: new URLSearchParams(Object.entries(body).map(([k,v]) => [k,String(v)])).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } } });
  for (const attempt of attempts) {
    if (signal?.aborted) return { ok: false, kind: "transient", error: "Batch budget reached before sending.", diagnostics };
    const response = await request(session, attempt.url, attempt.init, signal);
    diagnostics.push({ ...response.diagnostic, label: `send ${attempt.via}` });
    if (response.result.ok) {
      const id = ackId(response.body);
      return id ? { ok: true, id, via: attempt.via, diagnostics }
        : { ok: false, kind: "uncertain", error: "X returned no message acknowledgement. Check the chat before retrying.", diagnostics };
    }
    if (!canTryDmFallback(response.result))
      return { ...response.result, diagnostics };
  }
  return { ok: false, kind: "unsupported", error: "X rejected the available DM transports.", diagnostics };
}
export async function verifyRepost(session:unknown,tweetId:string,signal?:AbortSignal):Promise<DmSendResult> {
  if(!/^\d+$/.test(tweetId))return {ok:false,kind:"permanent",error:"Invalid post ID.",diagnostics:[]};
  const qid=await operationId("TweetResultByRestId",session);
  if(!qid)return {ok:false,kind:"unsupported",error:"X repost verification operation is unavailable. No success can be confirmed.",diagnostics:[]};
  const params=new URLSearchParams({variables:JSON.stringify({tweetId,withCommunity:false,includePromotedContent:false,withVoice:false}),features:"{}"});
  const response=await request(session,`https://x.com/i/api/graphql/${qid}/TweetResultByRestId?${params}`,{},signal);
  const diagnostics=[{...response.diagnostic,label:"Verify account repost state"}];
  if(!response.result.ok)return {...response.result,diagnostics};
  let tweet=response.body?.data?.tweetResult?.result;
  if(tweet?.__typename==="TweetWithVisibilityResults")tweet=tweet.tweet;
  const lookup=response.body?.data?.tweetResult;
  if(tweet&&/TweetUnavailable|TweetTombstone/.test(tweet.__typename??"")||lookup&&Object.keys(lookup).length===0)
    return {ok:false,kind:"permanent",unavailable:true,error:`Post is unavailable for this account${tweet?.reason?`: ${tweet.reason}`:""}.`,diagnostics};
  if(String(tweet?.rest_id??tweet?.legacy?.id_str??"")!==tweetId||typeof tweet?.legacy?.retweeted!=="boolean")
    return {ok:false,kind:"transient",error:"X did not return a reliable repost state for this exact post.",diagnostics};
  return {ok:true,id:tweetId,repostProof:{tweetId,retweeted:tweet.legacy.retweeted,action:"observed",checkedAt:Date.now(),retweetId:tweet.legacy.current_user_retweet?.id_str},diagnostics};
}

// Second, independent proof that the retweet just created is real — the
// SUPERBOT equivalent of "the button turned green on THIS post", without
// SUPERBOT's timeout bug (it marked done after 60 failed checks; here a
// timeout is uncertain, never done). Two checks, both must agree:
//  1. The original post's viewer state must point at THIS mutation id, not
//     just say retweeted:true (an old manual repost would also say true).
//  2. The retweet object itself, fetched by mutation id, must exist, belong
//     to this account (when the shape exposes an author), point back at the
//     original post (when the shape exposes a target), and not be older than
//     this mutation (when the shape exposes a creation time).
// Any contradiction is a mismatch: uncertain, DM blocked, retryable — never
// a claimed repost.
export async function verifyCreatedRepost(session:unknown,tweetId:string,mutationId:string,mutationAt:number,selfId?:string,signal?:AbortSignal):Promise<DmSendResult>{
 const state=await verifyRepost(session,tweetId,signal);
 if(!state.ok||!state.repostProof)return state;
 if(!state.repostProof.retweeted)return {ok:false,kind:"uncertain",error:"X read-back says the post is not reposted. No repost is claimed.",diagnostics:state.diagnostics,repostProof:state.repostProof};
 if(state.repostProof.retweetId&&state.repostProof.retweetId!==mutationId)return {ok:false,kind:"uncertain",error:`X reports a different retweet (${state.repostProof.retweetId}) than the one just created (${mutationId}). The claimed repost is not the fresh one.`,diagnostics:state.diagnostics,repostProof:state.repostProof};
 const qid=await operationId("TweetResultByRestId",session);
 if(!qid){
  if(state.repostProof.retweetId===mutationId)return {ok:true,id:mutationId,repostProof:{tweetId,retweeted:true,checkedAt:Date.now(),retweetId:mutationId},diagnostics:state.diagnostics};
  return {ok:false,kind:"uncertain",error:"The fresh retweet could not be read back. No repost is claimed.",diagnostics:state.diagnostics};
 }
 const params=new URLSearchParams({variables:JSON.stringify({tweetId:mutationId,withCommunity:false,includePromotedContent:false,withVoice:false}),features:"{}"});
 const response=await request(session,`https://x.com/i/api/graphql/${qid}/TweetResultByRestId?${params}`,{},signal);
 const diagnostics=[...state.diagnostics,{...response.diagnostic,label:"Verify fresh retweet object"}];
 if(!response.result.ok){
  if(state.repostProof.retweetId===mutationId)return {ok:true,id:mutationId,repostProof:{tweetId,retweeted:true,checkedAt:Date.now(),retweetId:mutationId},diagnostics};
  return {ok:false,kind:"uncertain",error:"The fresh retweet object could not be read back. No repost is claimed.",diagnostics};
 }
 let rt=response.body?.data?.tweetResult?.result;
 if(rt?.__typename==="TweetWithVisibilityResults")rt=rt.tweet;
 if(String(rt?.rest_id??rt?.legacy?.id_str??"")!==mutationId)return {ok:false,kind:"uncertain",error:`X returned a different post (${rt?.rest_id??rt?.legacy?.id_str}) when asked for the fresh retweet (${mutationId}). No repost is claimed.`,diagnostics};
 const author=rt?.legacy?.user_id_str??rt?.legacy?.user_id??rt?.core?.user_results?.result?.rest_id;
 if(selfId&&author&&String(author)!==selfId)return {ok:false,kind:"uncertain",error:`The fresh retweet belongs to a different account (${author}), not this account. No repost is claimed.`,diagnostics};
 const target=rt?.legacy?.retweeted_status_id_str??rt?.legacy?.retweeted_status?.id_str??rt?.retweeted_status_result?.result?.rest_id??rt?.legacy?.retweeted_status_result?.result?.rest_id;
 if(target&&String(target)!==tweetId)return {ok:false,kind:"uncertain",error:`The fresh retweet points at a different post (${target}), not ${tweetId}. No repost is claimed.`,diagnostics};
 const createdRaw=rt?.legacy?.created_at,created=createdRaw?Date.parse(String(createdRaw)):NaN;
 if(Number.isFinite(created)&&created<mutationAt-300000)return {ok:false,kind:"uncertain",error:"The retweet X returned is older than this mutation. It is not the fresh repost. No repost is claimed.",diagnostics};
 return {ok:true,id:mutationId,repostProof:{tweetId,retweeted:true,checkedAt:Date.now(),retweetId:mutationId},diagnostics};
}
const repostLocks=new Map<string,Promise<void>>();
export async function repostTweet(session:unknown,tweetId:string,signal?:AbortSignal,options:{remainingMs?:()=>number;selfId?:string}={}):Promise<DmSendResult>{
 const key=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(cookieHeader(session)+"\0"+tweetId)).then(hash=>Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join(""));
 const prior=repostLocks.get(key)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),tail=prior.catch(()=>{}).then(()=>gate);repostLocks.set(key,tail);
 await prior.catch(()=>{});try{return await freshRepost(session,tweetId,signal,options)}finally{release();if(repostLocks.get(key)===tail)repostLocks.delete(key)}
}
async function freshRepost(session:unknown,tweetId:string,signal:AbortSignal|undefined,options:{remainingMs?:()=>number;selfId?:string}):Promise<DmSendResult>{
 if(!/^\d+$/.test(tweetId))return {ok:false,kind:"permanent",error:"Invalid post ID.",diagnostics:[]};
 const before=await verifyRepost(session,tweetId,signal),diagnostics=[...before.diagnostics];
 if(!before.ok)return before;
 const refreshed=before.repostProof?.retweeted===true;
 if(refreshed&&options.remainingMs&&options.remainingMs()<22000)return {ok:false,kind:"transient",deferred:true,error:"A fresh repost needs more batch time. Existing repost left untouched; retrying in the next batch.",diagnostics};
 // Resolve both operations before undoing an existing repost.
 const createId=await operationId("CreateRetweet",session);
 const deleteId=refreshed?await operationId("DeleteRetweet",session):"";
 if(!createId||refreshed&&!deleteId)return {ok:false,kind:"unsupported",error:"Fresh repost transport is unavailable; the existing repost was left untouched.",diagnostics};
 let removedExisting=false;
 const mutate=async(op:string,qid:string,variables:Record<string,string>)=>{
  let last:Awaited<ReturnType<typeof request>>|undefined;
  for(const base of ["https://x.com/i/api/graphql","https://api.x.com/graphql"]){
   if(signal?.aborted)return {result:{ok:false,kind:"transient" as const,error:"Batch budget reached before repost mutation."},body:null,diagnostic:{label:op,url:base,status:0,ok:false}};
   last=await request(session,`${base}/${qid}/${op}`,{method:"POST",body:JSON.stringify({queryId:qid,variables,features:{}})},signal);
   diagnostics.push({...last.diagnostic,label:op==="DeleteRetweet"?"Undo previous repost":"Create fresh repost"});
   if(last.result.ok||last.result.status!==404||last.result.xCode)return last;
  }
  // An empty 404 does not establish an account restriction or a deleted post.
  // Refresh discovery for the next attempt, but do not repeat an external write
  // inside this attempt or block unrelated chats on this account.
  await resolveDmOperation(op,session,true);
  return {...last!,result:{...last!.result,kind:"post_rejected" as const,error:`X rejected ${op} for post ${tweetId} (HTTP 404). The post can't be reposted (deleted, protected or not retweetable); skipping the repost and continuing to the reply.`}};
 };
 if(refreshed){
  const undone=await mutate("DeleteRetweet",deleteId,{source_tweet_id:tweetId});
  if(!undone.result.ok)return {...undone.result,diagnostics};
  let grey=false;
  for(let check=0;check<6;check++){
   if(check)await new Promise(r=>setTimeout(r,500));
   const state=await verifyRepost(session,tweetId,signal);diagnostics.push(...state.diagnostics);
   if(!state.ok)return {ok:false,kind:"uncertain",error:"Undo was acknowledged, but its state could not be verified. Fresh repost and DM are not confirmed.",diagnostics};
   if(state.repostProof?.retweeted===false){grey=true;removedExisting=true;break}
  }
  if(!grey)return {ok:false,kind:"uncertain",error:"The previous repost is still present after undo; no fresh repost can be claimed. DM blocked.",diagnostics};
 }
 const created=await mutate("CreateRetweet",createId,{tweet_id:tweetId});
 if(!created.result.ok){
  const unavailable=[144,179,328].includes(created.result.xCode??0);
  return {...created.result,...(unavailable&&!removedExisting?{unavailable:true}:{}),error:removedExisting?`Previous repost was removed; fresh repost failed: ${created.result.error}`:created.result.error,diagnostics};
 }
 const mutationId=created.body?.data?.create_retweet?.retweet_results?.result?.rest_id;
 if(!mutationId)return {ok:false,kind:"uncertain",error:"Fresh repost acknowledgement is missing. DM blocked.",diagnostics};
 const mutationAt=Date.now();
 const attemptProof:DmRepostProof={tweetId,retweeted:false,checkedAt:Date.now(),action:refreshed?"refreshed":"created",mutationAt,mutationId:String(mutationId)};
 // Poll like SUPERBOT polls for the green button (up to ~3s here, inside the
 // batch budget), but require TWO consecutive independent confirmations and
 // never mark done on timeout — a timeout is uncertain, retryable, DM blocked.
 let confirmed=0;
 for(let check=0;check<6;check++){
  if(check)await new Promise(r=>setTimeout(r,500));
  const verified=await verifyCreatedRepost(session,tweetId,String(mutationId),mutationAt,options.selfId,signal);diagnostics.push(...verified.diagnostics);
  if(verified.ok&&verified.repostProof){
   confirmed++;
   if(confirmed>=2)return {ok:true,id:String(mutationId),via:refreshed?"refreshed-verified":"created-verified",repostProof:{...verified.repostProof,action:refreshed?"refreshed":"created",mutationAt,mutationId:String(mutationId)},diagnostics};
   continue;
  }
  // A mismatch (different retweet id / different target / different account /
  // older retweet) is definitive, not propagation delay: stop, do not poll for
  // a lucky true, and let the next pass undo + recreate from scratch.
  if(/different retweet|different post|different account|older than/.test(verified.error??""))return {ok:false,kind:"uncertain",repostProof:attemptProof,error:verified.error,diagnostics};
  confirmed=0;
 }
 return {ok:false,kind:"uncertain",repostProof:attemptProof,error:"X acknowledged the new repost, but read-back still says not reposted. DM blocked.",diagnostics};
}
export async function probeDm(session: unknown) {
  const verified = await verifyDmSession(session);
  const inbox = await request(session, `${BASE}/inbox_initial_state.json?${PARAMS}`);
  return { ok: verified.ok && inbox.result.ok, self: verified.ok ? { id: verified.id!, username: verified.username! } : undefined,
    diagnostics: [{ label: "Account identity", url: "X viewer", status: verified.ok ? 200 : 401, ok: verified.ok, error: verified.reason }, inbox.diagnostic],
    chatCapability: "legacy_only", chatNote: "Encrypted X Chat requires recovered keys and a separately verified cookie transport." };
}