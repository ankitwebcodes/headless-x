import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractTweetIds, incomingMessages, classifyXResponse, indexOperationPairs, tweetIdFromUrl, boundedInt } from "../lib/dm-core.ts";
import { progressFromItem, progressForChat, progressStats } from "../lib/dm-progress.ts";
await mkdir(join(process.cwd(),"backups"),{ recursive: true });
const stateDir = await mkdtemp(join(process.cwd(),"backups","dm-test-"));
process.env.DM_STATE_DIR = stateDir;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.DM_ENCRYPTION_KEY = "test-only-secret";
process.env.DM_QID_CREATERETWEET = "test-retweet-operation";
process.env.DM_QID_TWEETRESULTBYRESTID = "test-read-operation";
process.env.DM_QID_DELETERETWEET = "test-delete-operation";
const { saveSession, listSessions, getSession, readDmDoc, updateDmDoc, acquireAccount, releaseAccount } = await import("../lib/dm-store.ts");
const { scanInbox, sendDm } = await import("../lib/xdm.ts");
const { createDmRun: createDmRunActual, processDmRun, runSummary, controlDmRun, resolveDmItem, getDmProgress } = await import("../lib/dm-run.ts");
const createDmRun = (owner: string,body: Record<string,any>) => createDmRunActual(owner,{ cooldownMinutes: 0,speed: 1,...body });
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(stateDir,{ recursive: true,force: true }); });
const json = (body: unknown,status = 200,headers: Record<string,string> = {}) => new Response(JSON.stringify(body),{ status,headers: { "content-type": "application/json",...headers } });
const proof=(tweetId:string)=>({tweetId,retweeted:true,checkedAt:Date.now(),action:"created" as const,mutationAt:Date.now(),mutationId:`mutation-${tweetId}`,retweetId:`mutation-${tweetId}`});
// Existing transport fixtures now include an independent viewer-state read.
function withRepostReadback(fake:typeof fetch):typeof fetch {
 const states=new Map<string,boolean>(),mutations=new Map<string,string>(),targets=new Map<string,string>();
 return (async(url:any,init:any)=>{
  const path=String(url);
  if(path.includes('/TweetResultByRestId?')){
   const id=JSON.parse(new URL(path).searchParams.get('variables')!).tweetId;
   if(targets.has(`${init?.headers?.cookie??""}:${id}`))return json({data:{tweetResult:{result:{rest_id:id,legacy:{retweeted_status_id_str:targets.get(`${init?.headers?.cookie??""}:${id}`),created_at:new Date().toISOString()}}}}});
   const mid=mutations.get(`${init?.headers?.cookie??""}:${id}`);
   const legacy:any={retweeted:states.get(`${init?.headers?.cookie??""}:${id}`)??false};if(mid)legacy.current_user_retweet={id_str:mid};
   return json({data:{tweetResult:{result:{rest_id:id,legacy}}}});
  }
  const response=await fake(url,init);
  if(path.includes('/CreateRetweet')&&init?.method==='POST'){
   const body=await response.clone().json().catch(()=>null),id=JSON.parse(init.body).variables.tweet_id,mid=body?.data?.create_retweet?.retweet_results?.result?.rest_id;
   if(mid||body?.errors?.some((e:any)=>e.code===327)){states.set(`${init?.headers?.cookie??""}:${id}`,true);if(mid){mutations.set(`${init?.headers?.cookie??""}:${id}`,mid);targets.set(`${init?.headers?.cookie??""}:${mid}`,id);}}
  }
  if(path.includes('/DeleteRetweet')&&init?.method==='POST'){
   const id=JSON.parse(init.body).variables.source_tweet_id;states.set(`${init?.headers?.cookie??""}:${id}`,false);mutations.delete(`${init?.headers?.cookie??""}:${id}`);
  }
  return response;
 }) as typeof fetch;
}
const message = (text = "https://x.com/person/status/123456789",sender = "222",id = "900") => ({ message: {
  id,conversation_id: "111-222",time: "1793000000000",message_data: { sender_id: sender,text,
    attachment: { tweet: { id_str: "123456789" } } } } });
const chat = { id: "111-222",kind: "1:1" as const,handle: "person",name: "Person",status: "TRUSTED",active: true,inactive: false,
  unread: 1,unseen: true,lastSenderId: "222",fromMe: false,lastText: "post",lastAt: 1793000000000,participants: [] };
async function setup(owner: string) {
  const account = await saveSession(owner,{ id: "account",label: "Test",xUserId: "111",handle: "self",sessionJson: { auth_token: "test-cookie",ct0: "test-csrf" } });
  await updateDmDoc(owner,"scan:account",() => ({ ok: true,chats: [chat],stats: { total: 1,active: 1,inactive: 0,groups: 0,unseen: 1,unreadTotal: 1 },diagnostics: [] }),x => x);
  return account;
}
test("post extraction handles text, expanded entities and tweet cards without treating media/user IDs as posts", () => {
  assert.deepEqual(extractTweetIds({ text: "https://x.com/a/status/111",entities: { urls: [{ expanded_url: "https://twitter.com/b/status/222?x=1" }] },attachment: { tweet: { id_str: "333" } },media: { id_str: "444" },sender_id: "555" }),["111","222","333"]);
  assert.equal(tweetIdFromUrl("https://x.com.evil.test/a/status/111"),null);
  assert.equal(tweetIdFromUrl("https://x.com/i/web/status/111"),"111");
  assert.deepEqual(extractTweetIds({ text: "https://example.com/a" }),[]);
  assert.equal(incomingMessages({ entries: [message()] })[0].entryId,"900");
});
test("query discovery preserves operation mapping regardless of operation-name length", () => {
  assert.deepEqual(indexOperationPairs('queryId:"12345678",operationName:"useSendMessageMutation" operationName:"Viewer",queryId:"abcdefghijk"'),{ useSendMessageMutation: "12345678",Viewer: "abcdefghijk" });
  assert.equal(boundedInt("invalid",2,1,3),2);
});
test("429 and code 88 include a reset deadline; restriction and auth remain distinct", () => {
  const now = 100000;
  assert.equal(classifyXResponse(200,{ errors: [{ code: 88,message: "Rate limit exceeded" }] },new Headers(),now)?.kind,"rate_limit");
  assert.equal(classifyXResponse(429,{},new Headers({ "retry-after": "120" }),now)?.retryAt,220000);
  assert.equal(classifyXResponse(403,{ errors: [{ code: 226,message: "Automated" }] },new Headers())?.kind,"restriction");
  assert.equal(classifyXResponse(401,{},new Headers())?.kind,"auth");
});
test("12-account cap is atomic, owners isolated, cookies encrypted, refresh deduplicated", async () => {
  const results = await Promise.allSettled(Array.from({ length: 13 },(_,n) => saveSession("limit",{ id: `a${n}`,label: "A",xUserId: String(n),handle: `h${n}`,sessionJson: { auth_token: "secret-cookie-never-on-disk",ct0: "csrf" } })));
  assert.equal(results.filter(r => r.status === "fulfilled").length,12);
  assert.equal((await listSessions("limit")).length,12);
  assert.equal(await getSession("another-owner","a0"),null);
  const refresh = await saveSession("limit",{ id: "duplicate",label: "Updated",xUserId: "0",handle: "h0",sessionJson: { auth_token: "replacement" } });
  assert.equal(refresh.id,"a0");
  assert.equal((await listSessions("limit")).length,12);
  const disk = (await Promise.all((await readdir(stateDir)).map(f => readFile(join(stateDir,f),"utf8")))).join("");
  assert.equal(disk.includes("secret-cookie-never-on-disk"),false);
  await assert.rejects(saveSession("limit",{ id: "a0",label: "Bad",xUserId: "different",handle: "bad",sessionJson: {} }),/different X account/);
});
test("account lease blocks concurrent scans/runs and persists cooldown", async () => {
  const lease = await acquireAccount("lease","a");
  await assert.rejects(acquireAccount("lease","a"),/already/);
  await releaseAccount("lease","a",lease.token,Date.now() + 60000);
  await assert.rejects(acquireAccount("lease","a"),/cooling/);
});
test("scan checkpoints both buckets; a completed bucket stays complete on resume", async () => {
  const urls: string[] = [];
  globalThis.fetch=withRepostReadback(async (url: any) => {
    urls.push(String(url));
    if (String(url).includes("initial_state")) return json({ inbox_initial_state: { conversations: { "111-222": { participants: [{ user_id: "111" },{ user_id: "222" }],trusted: true } },entries: [message()],users: { "222": { screen_name: "person",name: "Person" } },inbox_timelines: { trusted: { status: "HAS_MORE",min_entry_id: "10" },untrusted: { status: "AT_END" } } } });
    return json({ inbox_timeline: { status: "AT_END",entries: [],conversations: {},users: {} } });
  });
  const checkpoints: any[] = [];
  const first = await scanInbox({}, { self: { id: "111",username: "self" },maxPages: 1,pageDelayMs: 200,onPage: async p => { checkpoints.push(p); } });
  assert.equal(first.pages?.truncated,false);
  assert.equal(first.chats[0].tweetIds?.[0],"123456789");
  assert.ok(checkpoints.length >= 2);
  const before = urls.length;
  const resumed = await scanInbox({}, { self: { id: "111",username: "self" },previous: first });
  assert.equal(urls.length,before);
  assert.equal(resumed.stats.total,1);
  globalThis.fetch = originalFetch;
});
test("scan rate limit retains cursor and partial chats for another pass", async () => {
  globalThis.fetch=withRepostReadback(async (url: any) => String(url).includes("initial_state")
    ? json({ inbox_initial_state: { conversations: { "111-222": { participants: [] } },entries: [message()],inbox_timelines: { trusted: { status: "HAS_MORE",min_entry_id: "10" } } } })
    : json({ errors: [{ code: 88,message: "Rate limit" }] },429));
  const result = await scanInbox({}, { self: { id: "111",username: "self" },pageDelayMs: 200 });
  assert.equal(result.kind,"rate_limit");
  assert.equal(result.pages?.cursors.trusted,"10");
  assert.equal(result.stats.total,1);
  globalThis.fetch = originalFetch;
});
test("run confirms repost before reply and deduplicates the incoming entry across runs", async () => {
  await setup("flow");
  const calls: string[] = [];
  globalThis.fetch=withRepostReadback(async (url: any,init: any) => {
    const path = String(url); calls.push(path);
    if (/x.com\/(?:messages|home)$/.test(path)) return new Response("");
    if (path.includes("/conversation/") && !path.includes("new2.json")) return json({ conversation_timeline: { entries: [message()] } });
    if (path.includes("CreateRetweet")) return json({ data: { create_retweet: { retweet_results: { result: { rest_id: "777" } } } } });
    if (path.includes("new2.json")) { assert.equal(JSON.parse(init.body).text,"Thanks person"); return json({ entries: [{ message: { id: "901" } }] }); }
    throw new Error(`Unexpected mock URL: ${path}`);
  });
  const created = await createDmRun("flow",{ id: "account",message: "Thanks {name}",delayMs: 1000 });
  const finished = await processDmRun("flow",created.id,16000);
  assert.equal(runSummary(finished).sent,1);
  const saved = await getDmProgress("flow","account",finished);
  assert.equal(saved[chat.id].completed,true);
  assert.equal(saved[chat.id].repostComplete,true);
  assert.equal(saved[chat.id].replySent,true);
  assert.deepEqual(await getDmProgress("another-owner","account"),{});
  assert.ok(calls.findIndex(u => u.includes("CreateRetweet")) < calls.findIndex(u => u.includes("new2.json")));
  const again = await createDmRun("flow",{ id: "account",message: "Thanks again" });
  const second = await processDmRun("flow",again.id,16000);
  assert.equal(second.items[0].status,"skipped");
  assert.equal(calls.filter(u => u.includes("new2.json")).length,1);
  assert.equal((await getDmProgress("flow","account",second))[chat.id].completed,true);
  globalThis.fetch = originalFetch;
});
test("failed repost blocks sending and remains retryable on rate limit", async () => {
  await setup("repost-fail");
  let sent = 0;
  globalThis.fetch=withRepostReadback(async (url: any) => {
    const path = String(url);
    if (path.includes("/conversation/") && !path.includes("new2.json")) return json({ conversation_timeline: { entries: [message()] } });
    if (path.includes("CreateRetweet")) return json({ errors: [{ code: 88,message: "Rate limited" }] },429);
    if (path.includes("new2.json")) sent++;
    return new Response("");
  });
  const run = await createDmRun("repost-fail",{ id: "account",message: "Thanks" });
  const result = await processDmRun("repost-fail",run.id,16000);
  assert.equal(sent,0);
  assert.equal(result.items[0].status,"retry_wait");
  assert.equal(result.status,"waiting");
  globalThis.fetch = originalFetch;
});
test("send timeout is uncertain, does not fall through to another transport, and cannot auto-retry", async () => {
  let writes = 0;
  globalThis.fetch=withRepostReadback(async (_url: any,init: any) => { if (init?.method === "POST") writes++; throw new Error("network dropped"); });
  const result = await sendDm({},"111-222","Hello",null,undefined,"stable-request-id");
  assert.equal(result.kind,"uncertain");
  assert.equal(writes,1);
  await setup("interrupted");
  const run = await createDmRun("interrupted",{ id: "account",message: "Hello" });
  await updateDmDoc("interrupted",`run:${run.id}`,() => run,r => ({ ...r,items: [{ ...r.items[0],status: "sending" as const }] }));
  const processed = await processDmRun("interrupted",run.id,16000);
  assert.equal(processed.items[0].status,"uncertain");
  const retried = await controlDmRun("interrupted",run.id,"retry");
  assert.equal(retried.items[0].status,"uncertain");
  globalThis.fetch = originalFetch;
});
test("dry run never reposts/sends; outbound latest and generic links skip", async () => {
  for (const [owner,entries,dryRun] of [["dry",[message()],true],["outbound",[message("sent","111")],false],["link",[{ message: { id: "888",conversation_id: "111-222",time: "1793000000000",message_data: { sender_id: "222",text: "https://example.com" } } }],false]] as const) {
    await setup(owner);
    let mutations = 0;
    globalThis.fetch=withRepostReadback(async (_url: any,init: any) => { if (init?.method === "POST") mutations++; return json({ conversation_timeline: { entries } }); });
    const run = await createDmRun(owner,{ id: "account",message: "Hello",dryRun });
    const result = await processDmRun(owner,run.id,16000);
    assert.equal(mutations,0);
    assert.equal(result.items[0].status,dryRun ? "sent" : "skipped");
  }
  globalThis.fetch = originalFetch;
});


test("1000+ conversations drain across saved passes without restarting the completed bucket", async () => {
  let timelineCalls = 0;
  const makeConversations = (start: number,count: number) => Object.fromEntries(Array.from({ length: count },(_,n) => [`111-${start+n}`,{ participants: [],trusted: true,sort_timestamp: start+n }]));
  globalThis.fetch=withRepostReadback(async (url: any) => {
    const path = String(url);
    if (path.includes("initial_state")) return json({ inbox_initial_state: { conversations: makeConversations(0,21),entries: [],inbox_timelines: { trusted: { status: "HAS_MORE",min_entry_id: "3" },untrusted: { status: "AT_END" } } } });
    assert.ok(path.includes("trusted.json"));
    timelineCalls++;
    const cursor = Number(new URL(path).searchParams.get("max_id"));
    return json({ inbox_timeline: { conversations: makeConversations(21+(3-cursor)*350,350),entries: [],status: cursor === 1 ? "AT_END" : "HAS_MORE",min_entry_id: String(cursor-1) } });
  });
  let snapshot = await scanInbox({}, { self: { id: "111",username: "self" },maxPages: 1,pageDelayMs: 200 });
  assert.equal(snapshot.stats.total,371);
  snapshot = await scanInbox({}, { self: { id: "111",username: "self" },previous: snapshot,maxPages: 1,pageDelayMs: 200 });
  assert.equal(snapshot.stats.total,721);
  snapshot = await scanInbox({}, { self: { id: "111",username: "self" },previous: snapshot,maxPages: 1,pageDelayMs: 200 });
  assert.equal(snapshot.stats.total,1071);
  assert.equal(snapshot.pages?.truncated,false);
  assert.equal(timelineCalls,3);
  globalThis.fetch = originalFetch;
});
test("confirmed repost survives a rejected send, then the reply resumes without reposting again", async () => {
  await setup("resume-send");
  let reposts = 0,sends = 0;
  globalThis.fetch=withRepostReadback(async (url: any) => {
    const path = String(url);
    if (path.includes("/conversation/") && !path.includes("new2.json")) return json({ conversation_timeline: { entries: [message()] } });
    if (path.includes("CreateRetweet")) { reposts++; return json({ data: { create_retweet: { retweet_results: { result: { rest_id: "777" } } } } }); }
    if (path.includes("new2.json")) { sends++; return sends === 1 ? json({ errors: [{ code: 89,message: "Session expired" }] },401) : json({ entries: [{ message: { id: "902" } }] }); }
    return new Response("");
  });
  const run = await createDmRun("resume-send",{ id: "account",message: "Hello" });
  const first = await processDmRun("resume-send",run.id,16000);
  assert.equal(first.items[0].status,"failed");
  assert.deepEqual(first.items[0].reposted,["123456789"]);
  const partial = (await getDmProgress("resume-send","account",first))[chat.id];
  assert.equal(partial.repostComplete,true);
  assert.equal(partial.replySent,false);
  assert.equal(partial.completed,false);
  assert.equal(partial.failedStep,"send");
  await controlDmRun("resume-send",run.id,"retry");
  // A persisted wave delay also applies across manual resume.
  await updateDmDoc("resume-send",`run:${run.id}`,() => run,r => ({ ...r,nextAt: 0 }));
  const resumed = await processDmRun("resume-send",run.id,16000);
  assert.equal(resumed.items[0].status,"sent");
  assert.equal(reposts,1);
  assert.equal(sends,2);
  globalThis.fetch = originalFetch;
});
test("missing send acknowledgement is uncertain; code 88 never triggers form fallback", async () => {
  let sends = 0;
  globalThis.fetch=withRepostReadback(async (_url: any,init: any) => { if (init?.method === "POST") sends++; return json({}); });
  const unacknowledged = await sendDm({},"111-222","Hello");
  assert.equal(unacknowledged.kind,"uncertain");
  assert.equal(sends,1);
  sends = 0;
  globalThis.fetch=withRepostReadback(async (_url: any,init: any) => { if (init?.method === "POST") sends++; return json({ errors: [{ code: 88,message: "Rate limit exceeded" }] }); });
  const limited = await sendDm({},"111-222","Hello");
  assert.equal(limited.kind,"rate_limit");
  assert.equal(sends,1);
  globalThis.fetch = originalFetch;
});
test("paused runs issue no requests; encrypted messages never repost or send", async () => {
  await setup("paused");
  const run = await createDmRun("paused",{ id: "account",message: "Hello" });
  await controlDmRun("paused",run.id,"pause");
  let calls = 0;
  globalThis.fetch=withRepostReadback(async () => { calls++; return json({}); });
  assert.equal((await processDmRun("paused",run.id,16000)).status,"paused");
  assert.equal(calls,0);
  await setup("encrypted");
  let writes = 0;
  const encrypted = message();
  (encrypted.message.message_data as any).encrypted = true;
  globalThis.fetch=withRepostReadback(async (_url: any,init: any) => { if (init?.method === "POST") writes++; return json({ conversation_timeline: { entries: [encrypted] } }); });
  const locked = await createDmRun("encrypted",{ id: "account",message: "Hello" });
  const result = await processDmRun("encrypted",locked.id,16000);
  assert.equal(result.items[0].kind,"unsupported");
  assert.equal(writes,0);
  globalThis.fetch = originalFetch;
});

test("progress counts only confirmed work and resets a completed marker for a newer incoming message", () => {
  const incoming = { conversationId: chat.id,entryId: "900",senderId: "222",createdAt: 1,text: "post",tweetIds: ["123"],encrypted: false };
  const base = { id: chat.id,name: chat.name,handle: chat.handle,status: "sent" as const,reposted: ["123"],repostProofs:{"123":proof("123")},requestId: "r",incoming,sentId: "901",attempts: 1 };
  const done = progressFromItem(base,"run");
  assert.equal(done.completed,true);
  assert.equal(progressStats([chat],{ [chat.id]: done }).completed,1);
  assert.equal(progressForChat({ ...chat,lastEntryId: "902" },done),undefined);
  assert.equal(progressStats([{ ...chat,lastEntryId: "902" }],{ [chat.id]: done }).pending,1);
  const dry = progressFromItem({ ...base,dry: true,sentId: undefined,reposted: [] },"dry");
  assert.equal(dry.completed,false);
  assert.equal(dry.replySent,false);
  assert.equal(progressStats([chat],{ [chat.id]: dry }).completed,0);
  const partial = progressFromItem({ ...base,status: "failed",sentId: undefined,failedStep: "send" },"partial");
  const stats = progressStats([chat],{ [chat.id]: partial });
  assert.equal(stats.reposted,1);
  assert.equal(stats.sent,0);
  assert.equal(stats.failed,1);
});

test("operator-confirmed replies persist their completion marker independently of the latest run", async () => {
  await setup("resolved");
  const created = await createDmRun("resolved",{ id: "account",message: "Hello" });
  const incoming = { conversationId: chat.id,entryId: "900",senderId: "222",createdAt: 1,text: "post",tweetIds: ["123"],encrypted: false };
  await updateDmDoc("resolved",`run:${created.id}`,() => created,r => ({ ...r,status: "needs_attention" as const,
    items: [{ ...r.items[0],status: "uncertain" as const,reposted: ["123"],repostProofs:{"123":proof("123")},incoming,text: "Hello",updatedAt: 1 }] }));
  await resolveDmItem("resolved",created.id,chat.id,"sent");
  const progress = await getDmProgress("resolved","account");
  assert.equal(progress[chat.id].completed,true);
  assert.equal(progress[chat.id].replySent,true);
});

test("explicit JSON rejection falls through to form with the same request ID", async () => {
  const requests: Array<{ requestId: string; encoding: string }> = [];
  globalThis.fetch=withRepostReadback(async (_url: any,init: any) => {
    if (init?.method !== "POST") return new Response("");
    const form = init.headers['content-type'] === 'application/x-www-form-urlencoded';
    const body = form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
    requests.push({ requestId: body.request_id ?? body.variables?.requestId,encoding: form ? "form" : "json" });
    return form ? json({ entries: [{ message: { id: "confirmed" } }] }) : json({ errors: [{ message: "Bad request body encoding" }] },400);
  });
  const result = await sendDm({},"111-222","Hello",null,undefined,"stable-intent");
  assert.equal(result.ok,true);
  assert.equal(result.id,"confirmed");
  assert.deepEqual(requests,[{ requestId: "stable-intent",encoding: "json" },{ requestId: "stable-intent",encoding: "form" }]);
  globalThis.fetch = originalFetch;
});


test("discovery prioritizes the real main bundle and concurrent lookups share its result", async () => {
  const { resolveDmOperation,dmAssetUrls } = await import("../lib/dm-operations.ts");
  const previous = process.env.DM_QID_CREATERETWEET;
  delete process.env.DM_QID_CREATERETWEET;
  const urls: string[] = [];
  const html = '<script src="https://abs.twimg.com/responsive-web/client-web/vendor.large.js"></script><script src="https://abs.twimg.com/responsive-web/client-web/i18n/en.large.js"></script><script src="https://abs.twimg.com/responsive-web/client-web/main.current.js"></script>';
  assert.deepEqual(dmAssetUrls(html,"https://x.com/home"),["https://abs.twimg.com/responsive-web/client-web/main.current.js"]);
  globalThis.fetch=withRepostReadback(async (url: any) => {
    urls.push(String(url));
    return String(url).includes("main.current.js") ? new Response('queryId:"current-repost-qid",operationName:"CreateRetweet"') : new Response(html);
  });
  try {
    const [first,second] = await Promise.all([resolveDmOperation("CreateRetweet",{},true),resolveDmOperation("CreateRetweet",{},true)]);
    assert.equal(first,"current-repost-qid"); assert.equal(first,second);
    assert.equal(urls.filter(u => u.includes("main.current.js")).length,1);
    assert.equal(urls.some(u => /vendor|i18n|messages/.test(u)),false);
  } finally { process.env.DM_QID_CREATERETWEET = previous; globalThis.fetch = originalFetch; }
});
test("a rejected repost blocks the reply and never falls through to the retired REST route", async () => {
  await setup("no-transport");
  await updateDmDoc<any>("no-transport","scan:account",() => ({}),scan => ({ ...scan,chats: [chat,{ ...chat,id: "111-555" }] }));
  const urls: string[] = [];
  globalThis.fetch=withRepostReadback(async (url: any) => {
    const path = String(url); urls.push(path);
    if (path.includes("/conversation/")) return json({ conversation_timeline: { entries: [message()] } });
    if (path.includes("new2.json")) return json({ entries: [{ message: { id: "reply-after-rejection" } }] });
    return json({},404);
  });
  const run = await createDmRun("no-transport",{ id: "account",message: "Hello",concurrency: 1 });
  const result = await processDmRun("no-transport",run.id,16000,1);
  assert.equal(result.status,"waiting");
  // Part 2: the post could not be reposted, so the reply must NOT go out.
  assert.equal(result.items[0].status,"retry_wait");
  assert.equal(result.items[0].sentId,undefined);
  assert.deepEqual(result.items[0].reposted,[]);
  assert.deepEqual(result.items[0].repostSkipped ?? [],[]);
  assert.equal(result.items[1].status,"queued");
  assert.equal(urls.some(u => u.includes("statuses/retweet")),false);
  assert.equal(urls.some(u => u.includes("new2.json")),false);
  globalThis.fetch = originalFetch;
});
test("explicit include-replied policy processes the last incoming post rather than the account's outgoing link", async () => {
  await setup("include-replied");
  const ids: string[] = [];
  globalThis.fetch=withRepostReadback(async (url: any,init: any) => {
    const path = String(url);
    if (path.includes("/conversation/") && !path.includes("new2.json")) return json({ conversation_timeline: { entries: [message("https://x.com/self/status/999","111","901"),message()] } });
    if (path.includes("CreateRetweet")) { ids.push(JSON.parse(init.body).variables.tweet_id); return json({ data: { create_retweet: { retweet_results: { result: { rest_id: "retweet" } } } } }); }
    if (path.includes("new2.json")) return json({ entries: [{ message: { id: "reply" } }] });
    return new Response("");
  });
  const run = await createDmRun("include-replied",{ id: "account",message: "Hello",includeReplied: true });
  const result = await processDmRun("include-replied",run.id,16000,1);
  assert.equal(result.items[0].status,"sent");
  assert.equal(result.items[0].incoming?.senderId,"222");
  assert.deepEqual(ids,["123456789"]);
  globalThis.fetch = originalFetch;
});


test("repost uses the live client variables but never treats already-reposted as a fresh mutation", async () => {
  const { repostTweet } = await import("../lib/xdm.ts");
  let calls = 0;
  globalThis.fetch=withRepostReadback(async (url: any,init: any) => {
    calls++;
    assert.ok(String(url).endsWith('/CreateRetweet'));
    const body = JSON.parse(init.body);
    assert.deepEqual(body.variables,{ tweet_id: '123456789' });
    assert.deepEqual(body.features,{});
    assert.equal('dark_request' in body.variables,false);
    return json({ errors: [{ code: 327,message: 'Authorization: You have already retweeted this Tweet. (327)' }] });
  });
  const result = await repostTweet({},'123456789');
  assert.equal(result.ok,false);
  assert.equal(result.kind,'permanent');
  assert.equal(calls,1);
  globalThis.fetch = originalFetch;
});
test("DM send uses new2 with a flat conversation payload and a confirmed message ID", async () => {
  let calls = 0;
  globalThis.fetch=withRepostReadback(async (url: any,init: any) => {
    calls++;
    assert.equal(String(url),'https://x.com/i/api/1.1/dm/new2.json');
    assert.deepEqual(JSON.parse(init.body),{ text: 'done',conversation_id: '111-222',request_id: 'intent',cards_platform: 'Web-12',
      dm_users: false,recipient_ids: false,include_cards: 1,include_quote_count: true,reply_to_dm_id: 'incoming' });
    return json({ entries: [{ message: { id: 'confirmed-new-message' } }] });
  });
  const result = await sendDm({},'111-222','done','incoming',undefined,'intent');
  assert.equal(result.ok,true);assert.equal(result.id,'confirmed-new-message');assert.equal(calls,1);
  globalThis.fetch = originalFetch;
});

test("unread uses read receipts and preserves snowflake precision; mode filters are distinct", async () => {
  const { conversationActivity,modeMatches,cooldownEnds,normalizeDmPreferences } = await import("../lib/dm-policy.ts");
  const messages=[{conversationId:chat.id,entryId:'2114824302445126009',senderId:'222',createdAt:1,text:'post',tweetIds:[],encrypted:false}];
  assert.equal(conversationActivity({last_read_event_id:'2114824302445126008'},messages,'111').unread,1);
  assert.equal(conversationActivity({last_read_event_id:'2114824302445126009'},messages,'111').unread,0);
  assert.equal(conversationActivity({},messages,'111').unreadKnown,false);
  assert.equal(conversationActivity({unread_count:null,last_read_event_id:'2114824302445126008'},messages,'111').unread,1);
  assert.equal(conversationActivity({unread_count:''},messages,'111').unreadKnown,false);
  assert.equal(modeMatches({...chat,unread:0},'unread'),false);
  assert.equal(modeMatches({...chat,inactive:true,isRequest:false},'inactive'),true);
  assert.equal(modeMatches({...chat,unread:0,inactive:true,isRequest:false},'all'),true);
  assert.equal(modeMatches({...chat,inactive:true},'all'),false);
  assert.equal(cooldownEnds(1000,60,3601000),0);
  assert.equal(cooldownEnds(1000,60,3600999),3601000);
  assert.equal(cooldownEnds(1000,0,1001),0);
  assert.equal(normalizeDmPreferences({}).cooldownMinutes,120);
});
test("recent manual outgoing message blocks repost and reply even when a newer incoming message exists", async () => {
  await setup('manual-cooldown');
  const recent=message('My manual reply','111','901');recent.message.time=String(Date.now()-30*60000);
  const newer=message(undefined,'222','902');newer.message.time=String(Date.now()-5*60000);
  let writes=0;
  globalThis.fetch=withRepostReadback(async (_url:any,init:any)=>{if(init?.method==='POST')writes++;return json({conversation_timeline:{entries:[newer,recent],status:'AT_END'}})});
  const run=await createDmRunActual('manual-cooldown',{id:'account',message:'Hello'});
  assert.equal(run.cooldownMinutes,120);
  const result=await processDmRun('manual-cooldown',run.id,16000);
  assert.equal(result.items[0].status,'cooldown');assert.equal(writes,0);
  assert.ok((result.items[0].cooldownUntil??0)>Date.now());
  assert.equal(runSummary(result).cooldown,1);
  globalThis.fetch=originalFetch;
});
test("explicitly selecting a chat cannot bypass a saved outgoing-message cooldown", async () => {
  await setup('selected-cooldown');
  await updateDmDoc<any>('selected-cooldown','scan:account',()=>({}),scan=>({...scan,chats:[{...chat,lastSentAt:Date.now()-10000}]}));
  let calls=0;globalThis.fetch=withRepostReadback(async()=>{calls++;throw new Error('No X request should be necessary for a known cooldown')});
  const run=await createDmRun('selected-cooldown',{id:'account',message:'Hello',cooldownMinutes:60,conversationIds:[chat.id]});
  const result=await processDmRun('selected-cooldown',run.id,16000);
  assert.equal(result.items[0].status,'cooldown');assert.equal(calls,0);
  globalThis.fetch=originalFetch;
});
test("a manual reply arriving after repost is detected before the automated DM", async () => {
  await setup('reply-during-run');
  let reposted=false,sends=0;
  const outgoing=message('Manual reply during run','111','903');outgoing.message.time=String(Date.now());
  globalThis.fetch=withRepostReadback(async(url:any)=>{
    const path=String(url);
    if(path.includes('/conversation/'))return json({conversation_timeline:{entries:reposted?[outgoing,message()]:[message()],status:'AT_END'}});
    if(path.includes('CreateRetweet')){reposted=true;return json({data:{create_retweet:{retweet_results:{result:{rest_id:'repost'}}}}})}
    if(path.includes('new2.json')){sends++;return json({entries:[{message:{id:'unexpected'}}]})}
    return json({});
  });
  const run=await createDmRun('reply-during-run',{id:'account',message:'Hello',cooldownMinutes:120});
  const result=await processDmRun('reply-during-run',run.id,16000);
  assert.equal(reposted,true);assert.equal(sends,0);assert.equal(result.items[0].status,'cooldown');
  assert.equal(result.items[0].reposted.length,1);
  globalThis.fetch=originalFetch;
});
test("unread mode rechecks live read state before any write", async () => {
  await setup('read-since-scan');
  let writes=0;
  globalThis.fetch=withRepostReadback(async(_url:any,init:any)=>{if(init?.method==='POST')writes++;return json({conversation_timeline:{entries:[message()],conversations:{[chat.id]:{last_read_event_id:'900'}},status:'AT_END'}})});
  const run=await createDmRun('read-since-scan',{id:'account',mode:'unread',message:'Hello'});
  const result=await processDmRun('read-since-scan',run.id,16000);
  assert.equal(result.items[0].status,'skipped');assert.match(result.items[0].error??'',/already been read/);assert.equal(writes,0);
  globalThis.fetch=originalFetch;
});
test("history pagination finds an outgoing reply beyond the first page of recent incoming messages", async () => {
  await setup('cooldown-history');let reads=0,writes=0;
  const incoming=message();incoming.message.time=String(Date.now()-10000);
  const outgoing=message('Manual reply','111','800');outgoing.message.time=String(Date.now()-600000);
  globalThis.fetch=withRepostReadback(async(url:any,init:any)=>{if(init?.method==='POST')writes++;reads++;
    if(String(url).includes('max_id=850'))return json({conversation_timeline:{entries:[outgoing],status:'AT_END'}});
    return json({conversation_timeline:{entries:[incoming],status:'HAS_MORE',min_entry_id:'850'}});
  });
  const run=await createDmRun('cooldown-history',{id:'account',message:'Hello',cooldownMinutes:120});
  const result=await processDmRun('cooldown-history',run.id,16000);
  assert.equal(result.items[0].status,'cooldown');assert.equal(reads,2);assert.equal(writes,0);
  globalThis.fetch=originalFetch;
});
test("expired cooldown permits the workflow and successful delivery records the next cooldown", async () => {
  await setup('cooldown-expired');
  const old=message('Older reply','111','899');old.message.time=String(Date.now()-121*60000);
  const fresh=message();fresh.message.time=String(Date.now()-1000);
  let writes=0;
  globalThis.fetch=withRepostReadback(async(url:any,init:any)=>{
    const path=String(url);if(init?.method==='POST')writes++;
    if(path.includes('/conversation/'))return json({conversation_timeline:{entries:[fresh,old],status:'AT_END'}});
    if(path.includes('CreateRetweet'))return json({data:{create_retweet:{retweet_results:{result:{rest_id:'repost-'+JSON.parse(init.body).variables.tweet_id}}}}});
    return json({entries:[{message:{id:'reply'}}]});
  });
  const run=await createDmRun('cooldown-expired',{id:'account',message:'Hello',cooldownMinutes:120});
  const result=await processDmRun('cooldown-expired',run.id,16000);
  assert.equal(result.items[0].status,'sent');assert.equal(writes,2);
  const saved=(await getDmProgress('cooldown-expired','account',result))[chat.id];
  assert.ok((saved.lastSentAt??0)>Date.now()-60000);assert.equal(saved.completed,true);
  globalThis.fetch=originalFetch;
});

test("an incomplete cooldown history fails safely without reposting or replying", async () => {
  await setup('cooldown-unverified');let reads=0,writes=0;
  const incoming=message();incoming.message.time=String(Date.now()-10000);
  globalThis.fetch=withRepostReadback(async(_url:any,init:any)=>{
    if(init?.method==='POST')writes++;
    reads++;
    return json({conversation_timeline:{entries:[incoming],status:'HAS_MORE',min_entry_id:String(850-reads)}});
  });
  const run=await createDmRun('cooldown-unverified',{id:'account',message:'Hello',cooldownMinutes:120});
  const result=await processDmRun('cooldown-unverified',run.id,16000);
  assert.equal(reads,8);assert.equal(writes,0);assert.equal(result.items[0].status,'retry_wait');
  assert.match(result.items[0].error??'',/Could not verify the full cooldown window/);
  globalThis.fetch=originalFetch;
});

test("inactive mode excludes active chats and rechecks recent activity in regular inbox chats", async () => {
  await setup('inactive-mode');
  await updateDmDoc<any>('inactive-mode','scan:account',()=>({}),scan=>({...scan,chats:[{...chat,lastAt:Date.now()},{...chat,id:'111-333',lastAt:Date.now()-2*86400000,active:false,inactive:true,isRequest:false}]}));
  let writes=0;
  const incoming=message();incoming.message.conversation_id='111-333';incoming.message.time=String(Date.now());
  globalThis.fetch=withRepostReadback(async(_url:any,init:any)=>{
    if(init?.method==='POST')writes++;
    return json({conversation_timeline:{entries:[incoming],conversations:{'111-333':{trusted:true}},status:'AT_END'}});
  });
  const run=await createDmRun('inactive-mode',{id:'account',mode:'inactive',message:'Hello'});
  assert.deepEqual(run.items.map(i=>i.id),['111-333']);
  const result=await processDmRun('inactive-mode',run.id,16000);
  assert.equal(result.items[0].status,'skipped');assert.match(result.items[0].error??'',/last 24 hours/);assert.equal(writes,0);
  globalThis.fetch=originalFetch;
});

test("a later incoming message clears old completion while keeping conversation cooldown", async () => {
  const {mergeDmProgress}=await import('../lib/dm-progress.ts');
  const {chatCooldownUntil}=await import('../lib/dm-policy.ts');
  const now=Date.now();
  const old=progressFromItem({id:chat.id,name:'Person',handle:'person',status:'sent',incoming:incomingMessages({entries:[message()]})[0],repostProofs:{'123456789':proof('123456789')},reposted:['123456789'],requestId:'r',sentId:'reply',attempts:1,lastSentAt:now-60000,updatedAt:now-60000},'old-run');
  const recent=progressFromItem({id:chat.id,name:'Person',handle:'person',status:'cooldown',reposted:[],requestId:'r2',attempts:1,lastSentAt:now-30000,updatedAt:now},'new-run');
  const merged=mergeDmProgress(old,recent);
  assert.equal(merged.completed,true);assert.equal(merged.lastSentAt,now-30000);
  const newer={...chat,lastEntryId:'901',unseen:true,lastSentAt:null};
  assert.equal(progressForChat(newer,merged),undefined);
  assert.equal(chatCooldownUntil(newer,merged,120,now),now-30000+120*60000);
  assert.equal(progressStats([newer],{[chat.id]:merged},120,now).cooldown,1);
});

test("scanning excludes requests in initial, continued and cached pages without walking the request timeline", async () => {
  const {inboxOnlyScan}=await import('../lib/xdm.ts');const urls:string[]=[];
  globalThis.fetch=withRepostReadback(async(url:any)=>{
    const path=String(url);urls.push(path);
    if(path.includes('initial_state'))return json({inbox_initial_state:{conversations:{[chat.id]:{trusted:true},'111-333':{trusted:false},'111-444':{trusted:true,low_quality:true}},entries:[],inbox_timelines:{trusted:{status:'HAS_MORE',min_entry_id:'50'},untrusted:{status:'HAS_MORE',min_entry_id:'60'}}}});
    return json({inbox_timeline:{conversations:{'111-555':{trusted:false}},entries:[],status:'AT_END'}});
  });
  const scan=await scanInbox({},{self:{id:'111',username:'self'},pageDelayMs:200});
  assert.deepEqual(scan.chats.map(c=>c.id),[chat.id]);assert.equal(urls.length,2);assert.equal(urls.some(u=>u.includes('/untrusted.json')),false);
  assert.equal(scan.pages?.cursors.untrusted,null);assert.equal(scan.pages?.truncated,false);
  const legacy={...scan,chats:[chat,{...chat,id:'111-333',status:'REQUEST',inactive:true}],pages:{...scan.pages!,cursors:{trusted:null,untrusted:'60'}}};
  assert.equal(inboxOnlyScan(legacy).chats.length,1);
  const resumed=await scanInbox({},{self:{id:'111',username:'self'},previous:legacy});
  assert.equal(urls.length,2);assert.equal(resumed.chats.length,1);assert.equal(resumed.pages?.cursors.untrusted,null);
  globalThis.fetch=originalFetch;
});

test("old selected requests and live requests cannot receive reposts or DMs in any mode", async () => {
  await setup('exclude-requests');
  await updateDmDoc<any>('exclude-requests','scan:account',()=>({}),s=>({...s,chats:[chat,{...chat,id:'111-333',inactive:true,status:'REQUEST'}]}));
  await assert.rejects(createDmRun('exclude-requests',{id:'account',message:'Hi',mode:'unread',conversationIds:['111-333']}),/Message requests are excluded/);
  let writes=0;
  globalThis.fetch=withRepostReadback(async(_url:any,init:any)=>{if(init?.method==='POST')writes++;return json({conversation_timeline:{conversations:{[chat.id]:{trusted:false,last_read_event_id:'899'}},entries:[message()],status:'AT_END'}})});
  const run=await createDmRun('exclude-requests',{id:'account',message:'Hi',mode:'unread',conversationIds:[chat.id,'111-333']});
  assert.deepEqual(run.items.map(i=>i.id),[chat.id]);
  const result=await processDmRun('exclude-requests',run.id,16000);
  assert.equal(result.items[0].status,'skipped');assert.match(result.items[0].error??'',/requests are excluded/);assert.equal(writes,0);
  globalThis.fetch=originalFetch;
});

test("standard speed is the default while 2x doubles a wave from two to four chats", async () => {
  const {normalizeDmPreferences,defaultDmPreferences,runConcurrency}=await import('../lib/dm-policy.ts');
  assert.equal(normalizeDmPreferences({}).speed,1);assert.equal(defaultDmPreferences.speed,1);
  assert.equal(normalizeDmPreferences({speed:2}).speed,2);
  assert.equal(runConcurrency(2,1),2);assert.equal(runConcurrency(2,2),4);assert.equal(runConcurrency(3,2),6);
  for(const speed of [1,2] as const){
    const owner=`speed-${speed}`;await setup(owner);
    const chats=Array.from({length:4},(_,i)=>({...chat,id:`111-${220+i}`}));
    await updateDmDoc<any>(owner,'scan:account',()=>({}),s=>({...s,chats}));
    globalThis.fetch=withRepostReadback(async(url:any,init:any)=>{
      const path=String(url);
      if(path.includes('/conversation/')){const incoming=message();incoming.message.conversation_id=path.match(/conversation\/([^/]+)\.json/)![1];incoming.message.id=incoming.message.conversation_id.split('-')[1];incoming.message.message_data.text=`https://x.com/a/status/${incoming.message.id}`;incoming.message.message_data.attachment.tweet.id_str=incoming.message.id;return json({conversation_timeline:{entries:[incoming],status:'AT_END'}})}
      await new Promise(r=>setTimeout(r,20));
      if(path.includes('CreateRetweet'))return json({data:{create_retweet:{retweet_results:{result:{rest_id:'repost-'+JSON.parse(init.body).variables.tweet_id}}}}});
      return json({entries:[{message:{id:JSON.parse(init.body).conversation_id}}]});
    });
    const run=await createDmRun(owner,{id:'account',message:'Hello',speed,concurrency:2,delayMs:60000});
    const result=await processDmRun(owner,run.id,16000);
    assert.equal(runSummary(result).sent,2*speed);
  }
  globalThis.fetch=originalFetch;
});

test("all ready accounts start independently, keep distinct settings, and dispatch concurrently", async () => {
  const {startDmFleet,getDmFleet}=await import('../lib/dm-fleet.ts');
  const owner='fleet';await setup(owner);
  await saveSession(owner,{id:'second',label:'Second',xUserId:'112',handle:'second',sessionJson:{auth_token:'second-cookie',ct0:'csrf'}});
  await updateDmDoc(owner,'scan:second',()=>({ok:true,chats:[{...chat,id:'112-222'}]}),x=>x);
  await updateDmDoc(owner,'settings:account',()=>({message:'First reply',cooldownMinutes:0}),x=>x);
  await updateDmDoc(owner,'settings:second',()=>({message:'Second reply',cooldownMinutes:0}),x=>x);
  const started=await startDmFleet(owner);assert.equal(started.filter(r=>r.started).length,2);
  assert.equal((await startDmFleet(owner)).some(r=>r.started),false);
  const fleet=await getDmFleet(owner);assert.equal(fleet.length,2);
  assert.equal((await getDmFleet('not-fleet-owner')).length,0);
  assert.equal((await getDmFleet('limit')).length,12);
  const sent:Record<string,string>={};let inFlight=0,peak=0;
  globalThis.fetch=withRepostReadback(async(url:any,init:any)=>{
    const path=String(url);inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,15));inFlight--;
    if(path.includes('/conversation/')){const incoming=message();incoming.message.conversation_id=path.match(/conversation\/([^/]+)\.json/)![1];return json({conversation_timeline:{entries:[incoming],status:'AT_END'}})}
    if(path.includes('CreateRetweet'))return json({data:{create_retweet:{retweet_results:{result:{rest_id:'repost-'+JSON.parse(init.body).variables.tweet_id}}}}});
    const body=JSON.parse(init.body);sent[body.conversation_id]=body.text;
    assert.equal(String(init.headers.cookie).includes('second-cookie'),body.conversation_id==='112-222');
    return json({entries:[{message:{id:'reply'}}]});
  });
  await Promise.all(fleet.map(a=>processDmRun(owner,a.run!.id,16000)));
  assert.ok(peak>=2);assert.deepEqual(sent,{'111-222':'First reply','112-222':'Second reply'});
  assert.equal((await getDmFleet(owner)).every(a=>a.run?.status==='finished'),true);
  globalThis.fetch=originalFetch;
});

test("clear-before-today previews and deletes only old scoped history, preserving credentials, current data and unresolved writes", async () => {
  const {manageDmHistory}=await import('../lib/dm-history.ts');
  const owner='cleanup';const realNow=Date.now;const before=realNow()-86400000;
  let oldRunId='';
  try{
    Date.now=()=>before-3600000;
    await setup(owner);await setup('cleanup-other-owner');
    await saveSession(owner,{id:'second',label:'Second',xUserId:'112',handle:'second',sessionJson:{auth_token:'keep-cookie',ct0:'csrf'}});
    await updateDmDoc(owner,'scan:second',()=>({ok:true,chats:[]}),x=>x);
    await updateDmDoc(owner,'settings:account',()=>({message:'Keep my reply'}),x=>x);
    const run=await createDmRun(owner,{id:'account',message:'Hello'});oldRunId=run.id;
    await controlDmRun(owner,run.id,'cancel');
    await updateDmDoc(owner,'entry:account:sent',()=>({status:'sent'}),x=>x);
    await updateDmDoc(owner,'entry:account:uncertain',()=>({status:'uncertain'}),x=>x);
    await updateDmDoc(owner,'chat:account:old',()=>({status:'sent'}),x=>x);
    await updateDmDoc(owner,'run:unresolved',()=>({accountId:'account',status:'needs_attention',items:[{status:'uncertain'}]}),x=>x);
  }finally{Date.now=realNow}
  await updateDmDoc(owner,'chat:account:today',()=>({status:'sent'}),x=>x);
  const preview=await manageDmHistory(owner,{id:'account',before});
  assert.equal(preview.counts.scans,1);assert.equal(preview.protected,2);assert.equal(preview.blocked,false);
  assert.ok(await readDmDoc(owner,'scan:account'));
  const cleared=await manageDmHistory(owner,{id:'account',before,confirm:true});assert.equal(cleared.removed,preview.eligible);
  for(const key of ['scan:account','chat:account:old','entry:account:sent',`run:${oldRunId}`,'latest:account'])assert.equal(await readDmDoc(owner,key),null);
  for(const key of ['entry:account:uncertain','chat:account:today','run:unresolved','settings:account','scan:second'])assert.ok(await readDmDoc(owner,key));
  assert.ok(await getSession(owner,'account'));assert.ok(await readDmDoc('cleanup-other-owner','scan:account'));
  const all=await manageDmHistory(owner,{allAccounts:true,before,confirm:true});assert.equal(all.accounts,2);assert.equal(await readDmDoc(owner,'scan:second'),null);
});

test("cleanup refuses started or leased accounts and deletion preserves records changed since preview", async () => {
  const {manageDmHistory}=await import('../lib/dm-history.ts');
  const {listDmRecords,deleteDmRecords}=await import('../lib/dm-store.ts');
  await setup('cleanup-busy');const run=await createDmRun('cleanup-busy',{id:'account',message:'Hello'});
  const before=Date.now();assert.equal((await manageDmHistory('cleanup-busy',{id:'account',before})).blocked,true);
  await assert.rejects(manageDmHistory('cleanup-busy',{id:'account',before,confirm:true}),/Stop started or paused/);
  assert.ok(await readDmDoc('cleanup-busy','scan:account'));
  await controlDmRun('cleanup-busy',run.id,'cancel');
  const lease=await acquireAccount('cleanup-busy','account');
  await assert.rejects(manageDmHistory('cleanup-busy',{id:'account',before,confirm:true}),/already scanning or running/);
  await releaseAccount('cleanup-busy','account',lease.token);
  const old=(await listDmRecords('cleanup-busy')).filter(r=>r.key==='scan:account');
  await updateDmDoc<any>('cleanup-busy','scan:account',()=>({}),s=>({...s,scannedAt:Date.now()}));
  assert.equal(await deleteDmRecords('cleanup-busy',old),0);assert.ok(await readDmDoc('cleanup-busy','scan:account'));
  await assert.rejects(manageDmHistory('different-user',{id:'account',before,confirm:true}),/Account not found/);
});

test("an HTTP success and repost ID cannot mark a repost done or send a DM when X read-back says false", async()=>{
  await setup('false-repost');let writes=0,sends=0,reads=0;
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('TweetResultByRestId')){reads++;return json({data:{tweetResult:{result:{rest_id:'123456789',legacy:{retweeted:false}}}}})}
    if(path.includes('/conversation/'))return json({conversation_timeline:{entries:[message()],status:'AT_END'}});
    writes++;
    if(path.includes('CreateRetweet'))return json({data:{create_retweet:{retweet_results:{result:{rest_id:'ack-without-real-repost'}}}}});
    sends++;return json({entries:[{message:{id:'must-not-send'}}]});
  }) as typeof fetch;
  const run=await createDmRun('false-repost',{id:'account',message:'Hi'});
  const result=await processDmRun('false-repost',run.id,16000);
  assert.equal(result.items[0].status,'uncertain');assert.equal(result.items[0].failedStep,'repost');assert.equal(writes,1);assert.equal(sends,0);assert.equal(reads,7);
  const p=(await getDmProgress('false-repost','account',result))[chat.id];assert.equal(p.completed,false);assert.equal(p.repostComplete,false);assert.equal(runSummary(result).reposted,0);
  globalThis.fetch=originalFetch;
});

test("already-reposted code 327 still requires independent read-back confirmation",async()=>{
  const {repostTweet}=await import('../lib/xdm.ts');let writes=0;
  globalThis.fetch=(async(url:any,init:any)=>{
    if(String(url).includes('TweetResultByRestId'))return json({data:{tweetResult:{result:{rest_id:'123',legacy:{retweeted:false}}}}});
    writes++;assert.equal(init.method,'POST');return json({errors:[{code:327,message:'Already retweeted'}]});
  }) as typeof fetch;
  const result=await repostTweet({},'123');assert.equal(result.ok,false);assert.equal(result.kind,'permanent');assert.equal(writes,1);
  globalThis.fetch=originalFetch;
});

test("read-back must refer to the exact requested post and genuine boolean viewer state",async()=>{
  const {verifyRepost}=await import('../lib/xdm.ts');
  for(const result of [{rest_id:'wrong-post',legacy:{retweeted:true}},{rest_id:'123',legacy:{retweeted:'true'}},{rest_id:'123',legacy:{}}]){
    globalThis.fetch=(async()=>json({data:{tweetResult:{result}}})) as typeof fetch;
    assert.equal((await verifyRepost({},'123')).ok,false);
  }
  globalThis.fetch=originalFetch;
});

test("legacy successful markers are unverified until audited; auditing never resends an existing DM",async()=>{
  const {auditDmReposts}=await import('../lib/dm-run.ts');
  await setup('audit-legacy');const run=await createDmRun('audit-legacy',{id:'account',message:'Hi'});
  const incoming=incomingMessages({entries:[message()]})[0];
  const items=[{...run.items[0],status:'sent' as const,incoming,reposted:['123456789'],sentId:'old-reply',updatedAt:1},
    {...run.items[0],id:'111-333',status:'sent' as const,incoming:{...incoming,conversationId:'111-333',entryId:'901',tweetIds:['987']},reposted:['987'],sentId:'other-old-reply',updatedAt:1}];
  await updateDmDoc('audit-legacy',`run:${run.id}`,()=>run,r=>({...r,status:'finished' as const,items}));
  for(const item of items){const p={...progressFromItem(item,run.id),repostComplete:true,completed:true};await updateDmDoc('audit-legacy',`chat:account:${item.id}`,()=>p,()=>p)}
  const before=await getDmProgress('audit-legacy','account');assert.equal(before[chat.id].replySent,true);assert.equal(before[chat.id].completed,false);assert.equal(before[chat.id].repostComplete,false);
  let writes=0;
  globalThis.fetch=(async(url:any,init:any)=>{
    if(init?.method==='POST')writes++;
    const id=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;
    return json({data:{tweetResult:{result:{rest_id:id,legacy:{retweeted:id==='123456789'}}}}});
  }) as typeof fetch;
  const audited=await auditDmReposts('audit-legacy','account');assert.equal(audited.checked,2);assert.equal(audited.verified,0);assert.equal(audited.remaining,0);assert.equal(writes,0);
  assert.equal(audited.progress[chat.id].completed,false);assert.equal(audited.progress[chat.id].repostProofs?.['123456789'].action,'observed');assert.equal(audited.progress['111-333'].repostComplete,false);assert.equal(audited.progress['111-333'].replySent,true);assert.equal(audited.progress['111-333'].replyId,'other-old-reply');
  globalThis.fetch=originalFetch;
});

test("a single 226 backs the chat off without killing the account; a repeated 226 parks it, and another account completes",async()=>{
  const {startDmFleet}=await import('../lib/dm-fleet.ts');
  const owner='restricted-fleet';await setup(owner);
  await saveSession(owner,{id:'blocked',xUserId:'112',handle:'blocked',label:'Blocked',sessionJson:{auth_token:'blocked-cookie',ct0:'csrf'}});
  await updateDmDoc(owner,'scan:blocked',()=>({ok:true,chats:[{...chat,id:'112-222'}]}),s=>s);
  const healthy=await createDmRun(owner,{id:'account',message:'Healthy'}),blocked=await createDmRun(owner,{id:'blocked',message:'Blocked'});
  const sends:string[]=[];
  globalThis.fetch=withRepostReadback(async(url:any,init:any)=>{
    const path=String(url),restricted=String(init?.headers?.cookie??'').includes('blocked-cookie');
    if(path.includes('/conversation/')){const m=message();m.message.conversation_id=restricted?'112-222':chat.id;return json({conversation_timeline:{entries:[m],status:'AT_END'}})}
    if(path.includes('CreateRetweet'))return restricted?json({errors:[{code:226,message:'This request looks automated. (226)'}]}):json({data:{create_retweet:{retweet_results:{result:{rest_id:'real-repost'}}}}});
    sends.push(JSON.parse(init.body).conversation_id);return json({entries:[{message:{id:'healthy-reply'}}]});
  });
  const [a,first]=await Promise.all([processDmRun(owner,healthy.id,16000),processDmRun(owner,blocked.id,16000)]);
  assert.equal(a.status,'finished');
  // A single 226 is a throttle, not a ban: the account keeps its turn and retries by itself.
  assert.equal(first.status,'waiting');
  assert.equal(first.attention,undefined);
  assert.equal(first.items[0].status,'retry_wait');
  assert.equal(first.items[0].softThrottles,1);
  assert.ok((first.items[0].retryAt??0)>Date.now());
  assert.deepEqual(sends,[chat.id]);
  // A repeated 226 does park the account, but with an automatic recovery deadline attached.
  let b=first;
  for(let i=0;i<2;i++){
    // The account itself is parked for the throttle window, exactly like production; the
    // worker clears this when the deadline passes.
    await updateDmDoc<any>(owner,'lease:blocked',()=>({token:'',until:0,cooldownUntil:0}),old=>({...old,cooldownUntil:0,until:0}));
    await updateDmDoc<any>(owner,`run:${b.id}`,()=>null,r=>({...r,nextAt:0,items:r.items.map((x:any)=>({...x,retryAt:0}))}));
    b=await processDmRun(owner,blocked.id,16000,1);
  }
  assert.equal(b.status,'needs_attention');assert.equal(b.attention?.kind,'restriction');assert.equal(b.attention?.code,226);
  assert.ok((b.attention?.recoverAt??0)>Date.now());
  assert.equal((await startDmFleet(owner)).find(a=>a.accountId==='blocked')?.started,false);
  globalThis.fetch=originalFetch;
});

test("scan results, saved scans and run targets always follow newest-first order with precise event-ID ties",async()=>{
  const {inboxOnlyScan}=await import('../lib/xdm.ts');
  const incoming=message();incoming.message.time='1793000000000';
  globalThis.fetch=(async()=>json({inbox_initial_state:{conversations:{'111-333':{trusted:true,sort_timestamp:'1793000001000',sort_event_id:'2114824302445126008'},[chat.id]:{trusted:true,sort_timestamp:'1793000003000',sort_event_id:'2114824302445126009'},'111-444':{trusted:true,sort_timestamp:'1793000001000',sort_event_id:'2114824302445126009'}},entries:[incoming],inbox_timelines:{trusted:{status:'AT_END'}}}})) as typeof fetch;
  const scan=await scanInbox({},{self:{id:'111',username:'self'}});
  assert.deepEqual(scan.chats.map(c=>c.id),[chat.id,'111-444','111-333']);
  const shuffled={...scan,chats:[...scan.chats].reverse()};assert.deepEqual(inboxOnlyScan(shuffled).chats.map(c=>c.id),scan.chats.map(c=>c.id));
  await setup('order');await updateDmDoc('order','scan:account',()=>shuffled,()=>shuffled);
  const run=await createDmRun('order',{id:'account',message:'Hi',conversationIds:['111-333',chat.id,'111-444']});
  assert.deepEqual(run.items.map(i=>i.id),scan.chats.map(c=>c.id));
  globalThis.fetch=originalFetch;
});

test("pagination never advances a cursor toward newer conversations",async()=>{
  globalThis.fetch=(async(url:any)=>String(url).includes('initial_state')?json({inbox_initial_state:{conversations:{},entries:[],inbox_timelines:{trusted:{status:'HAS_MORE',min_entry_id:'100'}}}}):json({inbox_timeline:{conversations:{},entries:[],status:'HAS_MORE',min_entry_id:'101'}})) as typeof fetch;
  const scan=await scanInbox({},{self:{id:'111',username:'self'},pageDelayMs:200});assert.match(scan.error??'',/older chats/);assert.equal(scan.pages?.cursors.trusted,'100');
  globalThis.fetch=originalFetch;
});

test("extension card targeting uses the shared outer post, excluding profile and quoted-post metadata",()=>{
  const data={text:'Shared post',attachment:{tweet:{id:'2113333816018210904',expanded_url:'https://x.com/magnus6magnus/status/2113333816018210904',status:{id_str:'2113333816018210904',user:{url:'https://x.com/a/status/999'},quoted_status:{id_str:'888',text:'https://x.com/b/status/888'}}}}};
  assert.deepEqual(extractTweetIds(data),['2113333816018210904']);
  assert.deepEqual(extractTweetIds({card:{binding_values:[{key:'tweet_id',value:{string_value:'2113333816018210904'}}]}}),['2113333816018210904']);
});

test("extension selects the latest received post even when a newer incoming message is plain text",async()=>{
  const {readConversation}=await import('../lib/xdm.ts');
  const post=message('https://x.com/a/status/2113333816018210904','222','900');post.message.message_data.attachment.tweet.id_str='2113333816018210904';
  const plain:any=message('thanks','222','901');delete plain.message.message_data.attachment;plain.message.time=String(Number(post.message.time)+1000);
  const own=message(undefined,'111','902');own.message.time=String(Number(post.message.time)+2000);
  globalThis.fetch=(async()=>json({conversation_timeline:{entries:[own,plain,post],status:'AT_END'}})) as typeof fetch;
  const read=await readConversation({},chat.id,'111',undefined,true);
  assert.equal(read.message?.entryId,'900');assert.deepEqual(read.message?.tweetIds,['2113333816018210904']);
  globalThis.fetch=originalFetch;
});

test("unexpanded t.co post links are resolved without account cookies and are never silently skipped",async()=>{
  const {resolveDmPost}=await import('../lib/dm-posts.ts');let calls=0;
  globalThis.fetch=(async(url:any,init:any)=>{calls++;assert.equal(new URL(String(url)).hostname,'t.co');assert.equal(init.redirect,'manual');assert.equal(init.headers,undefined);return new Response(null,{status:302,headers:{location:'https://x.com/magnus6magnus/status/2113333816018210904'}})}) as typeof fetch;
  const incoming={conversationId:chat.id,entryId:'1',senderId:'222',createdAt:1,text:'https://t.co/resolved-test',tweetIds:[],postUrls:['https://t.co/resolved-test'],encrypted:false};
  const resolved=await resolveDmPost(incoming);assert.equal(resolved.tweetId,'2113333816018210904');assert.equal(calls,1);
  globalThis.fetch=(async()=>new Response('',{status:200})) as typeof fetch;
  const bad=await resolveDmPost({...incoming,postUrls:['https://t.co/unresolved-test']});assert.equal(bad.ok,false);assert.equal(bad.kind,'transient');
  globalThis.fetch=originalFetch;
});

test("already-reposted posts execute extension parity: undo, verify absent, create, verify present",async()=>{
  const {repostTweet}=await import('../lib/xdm.ts');let retweeted=true,currentRetweetId='old-repost-id';const mutations:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('TweetResultByRestId')){const qid=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;if(qid!=='2113333816018210904')return json({data:{tweetResult:{result:{rest_id:qid,legacy:{user_id_str:'111',retweeted_status_id_str:'2113333816018210904',created_at:new Date().toISOString()}}}}});return json({data:{tweetResult:{result:{rest_id:'2113333816018210904',legacy:{retweeted,...(retweeted&&currentRetweetId?{current_user_retweet:{id_str:currentRetweetId}}:{})}}}}});}
    const body=JSON.parse(init.body);assert.deepEqual(body.features,{});
    if(path.includes('DeleteRetweet')){assert.deepEqual(body.variables,{source_tweet_id:'2113333816018210904'});mutations.push('undo');retweeted=false;currentRetweetId='';return json({data:{delete_retweet:{}}})}
    assert.equal(retweeted,false);assert.deepEqual(body.variables,{tweet_id:'2113333816018210904'});mutations.push('create');retweeted=true;currentRetweetId='new-repost-id';return json({data:{create_retweet:{retweet_results:{result:{rest_id:'new-repost-id'}}}}});
  }) as typeof fetch;
  const result=await repostTweet({},'2113333816018210904');assert.equal(result.ok,true);assert.deepEqual(mutations,['undo','create']);assert.equal(result.repostProof?.action,'refreshed');assert.equal(result.repostProof?.mutationId,'new-repost-id');
  globalThis.fetch=originalFetch;
});

test("same-account refreshes of the same post are serialized, preventing undo/create races",async()=>{
  const {repostTweet}=await import('../lib/xdm.ts');let retweeted=true,inFlight=0,peak=0,currentRetweetId='old-123';const actions:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('TweetResultByRestId')){const qid=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;if(qid!=='123')return json({data:{tweetResult:{result:{rest_id:qid,legacy:{retweeted_status_id_str:'123',created_at:new Date().toISOString()}}}}});return json({data:{tweetResult:{result:{rest_id:'123',legacy:{retweeted,...(retweeted&&currentRetweetId?{current_user_retweet:{id_str:currentRetweetId}}:{})}}}}});}
    inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,15));inFlight--;
    if(path.includes('DeleteRetweet')){actions.push('undo');retweeted=false;currentRetweetId='';return json({data:{delete_retweet:{}}})}
    actions.push('create');retweeted=true;currentRetweetId=String(actions.length);return json({data:{create_retweet:{retweet_results:{result:{rest_id:String(actions.length)}}}}});
  }) as typeof fetch;
  const results=await Promise.all([repostTweet({auth_token:'same'},'123'),repostTweet({auth_token:'same'},'123')]);
  assert.equal(results.every(r=>r.ok),true);assert.deepEqual(actions,['undo','create','undo','create']);assert.equal(peak,1);globalThis.fetch=originalFetch;
});

test("an unavailable post never claims a repost, and the reply is blocked",async()=>{
  await setup('unavailable-post');const writes:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(init?.method==='POST')writes.push(path);
    if(path.includes('TweetResultByRestId'))return json({data:{tweetResult:{result:{__typename:'TweetUnavailable',reason:'Deleted'}}}});
    if(path.includes('new2.json'))return json({entries:[{message:{id:'reply-for-deleted-post'}}]});
    return json({conversation_timeline:{entries:[message()],status:'AT_END'}});
  }) as typeof fetch;
  const run=await createDmRun('unavailable-post',{id:'account',message:'Hi'}),result=await processDmRun('unavailable-post',run.id,16000);
  assert.equal(result.items[0].status,'failed');
  assert.equal(result.items[0].sentId,undefined);
  assert.deepEqual(result.items[0].reposted,[]);
  assert.deepEqual(result.items[0].repostSkipped ?? [],[]);
  // No write is wasted trying to repost a post X says does not exist, and no reply is sent.
  assert.equal(writes.some(p=>p.includes('CreateRetweet')),false);
  assert.equal(writes.filter(p=>p.includes('new2.json')).length,0);
  globalThis.fetch=originalFetch;
});

test("legacy reply repair refreshes the post without duplicating its previously sent DM",async()=>{
  const {createHash}=await import('node:crypto');await setup('repair-post');const incoming=incomingMessages({entries:[message()]})[0];
  const key=`entry:account:${createHash('sha256').update(incoming.entryId).digest('hex')}`;
  await updateDmDoc('repair-post',key,()=>({status:'sent',sentId:'existing-reply',reposted:['123456789'],requestId:'old-request',text:'Original reply'}),x=>x);
  let retweeted=true,sends=0,currentRetweetId='old-repair';const actions:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('/conversation/'))return json({conversation_timeline:{entries:[message()],status:'AT_END'}});
    if(path.includes('TweetResultByRestId')){const qid=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;if(qid!=='123456789')return json({data:{tweetResult:{result:{rest_id:qid,legacy:{retweeted_status_id_str:'123456789',created_at:new Date().toISOString()}}}}});return json({data:{tweetResult:{result:{rest_id:'123456789',legacy:{retweeted,...(retweeted&&currentRetweetId?{current_user_retweet:{id_str:currentRetweetId}}:{})}}}}});}
    if(path.includes('DeleteRetweet')){actions.push('undo');retweeted=false;currentRetweetId='';return json({data:{delete_retweet:{}}})}
    if(path.includes('CreateRetweet')){actions.push('create');retweeted=true;currentRetweetId='fresh-repair';return json({data:{create_retweet:{retweet_results:{result:{rest_id:'fresh-repair'}}}}})}
    sends++;return json({entries:[{message:{id:'must-not-send'}}]});
  }) as typeof fetch;
  const run=await createDmRun('repair-post',{id:'account',message:'Do not duplicate'}),result=await processDmRun('repair-post',run.id,40000,1);
  assert.equal(sends,0);assert.deepEqual(actions,['undo','create']);assert.equal(result.items[0].sentId,'existing-reply');assert.equal(result.items[0].status,'sent');assert.equal((await readDmDoc<any>('repair-post',key)).status,'sent');
  assert.equal((await getDmProgress('repair-post','account',result))[chat.id].completed,true);globalThis.fetch=originalFetch;
});

test("an existing repost is left intact when the batch has insufficient time to finish its refresh",async()=>{
  const {repostTweet}=await import('../lib/xdm.ts');let writes=0;
  globalThis.fetch=(async(_url:any,init:any)=>{if(init?.method==='POST')writes++;return json({data:{tweetResult:{result:{rest_id:'123',legacy:{retweeted:true}}}}})}) as typeof fetch;
  const r=await repostTweet({},'123',undefined,{remainingMs:()=>10000});assert.equal(r.ok,false);assert.equal(r.kind,'transient');assert.equal(writes,0);globalThis.fetch=originalFetch;
});

test("per-account Chat passcodes are encrypted, survive cookie refresh and can be changed or removed",async()=>{
  const {updateSessionSettings}=await import('../lib/dm-store.ts');const owner='passcodes';
  await saveSession(owner,{id:'a',xUserId:'7001',handle:'first',label:'First',sessionJson:{auth_token:'cookie-a',ct0:'csrf'},passcode:'0123'});
  await saveSession(owner,{id:'b',xUserId:'7002',handle:'second',label:'Second',sessionJson:{auth_token:'cookie-b',ct0:'csrf'},passcode:'4567'});
  await saveSession(owner,{id:'a',xUserId:'7001',handle:'first',label:'First',sessionJson:{auth_token:'refreshed-cookie-a',ct0:'new-csrf'}});
  assert.equal((await getSession(owner,'a'))?.passcode,'0123');assert.equal((await getSession(owner,'b'))?.passcode,'4567');
  await updateSessionSettings(owner,'a',undefined,'9876');assert.equal((await getSession(owner,'a'))?.passcode,'9876');assert.equal((await getSession(owner,'b'))?.passcode,'4567');
  const disk=(await Promise.all((await readdir(stateDir)).map(f=>readFile(join(stateDir,f),'utf8')))).join('');
  assert.equal(disk.includes('"passcode":"9876"'),false);assert.equal(disk.includes('"passcode":"4567"'),false);
  await updateSessionSettings(owner,'a',undefined,'');assert.equal((await getSession(owner,'a'))?.passcode,undefined);assert.equal((await getSession(owner,'b'))?.passcode,'4567');
  assert.equal(await getSession('another-owner','a'),null);
});

test("account removal stops its paused run, removes credentials, and leaves other accounts and owners alone",async()=>{
  const {removeDmAccount}=await import('../lib/dm-run.ts');await setup('remove-account');await setup('remove-other-owner');
  await saveSession('remove-account',{id:'second',xUserId:'112',handle:'second',label:'Second',sessionJson:{auth_token:'second-cookie',ct0:'csrf'}});
  await updateDmDoc('remove-account','scan:second',()=>({ok:true,chats:[{...chat,id:'112-222'}]}),s=>s);
  const first=await createDmRun('remove-account',{id:'account',message:'First'});await controlDmRun('remove-account',first.id,'pause');
  const second=await createDmRun('remove-account',{id:'second',message:'Second'});
  await removeDmAccount('remove-account','account');
  assert.equal(await getSession('remove-account','account'),null);
  assert.equal((await readDmDoc<any>('remove-account','legacy-adoption')).manualRemoval,true);
  const stopped=await readDmDoc<any>('remove-account',`run:${first.id}`);assert.equal(stopped.status,'finished');assert.equal(stopped.items[0].status,'skipped');
  assert.ok(await getSession('remove-account','second'));assert.equal((await readDmDoc<any>('remove-account',`run:${second.id}`)).status,'running');
  assert.ok(await getSession('remove-other-owner','account'));await assert.rejects(removeDmAccount('unrelated-owner','second'),/Account not found/);
});

test("removal waits for an in-flight account lease, then works even during X rate-limit cooldown",async()=>{
  const {removeDmAccount}=await import('../lib/dm-run.ts');await setup('remove-busy');const run=await createDmRun('remove-busy',{id:'account',message:'First'});
  const lease=await acquireAccount('remove-busy','account');
  await assert.rejects(removeDmAccount('remove-busy','account'),/already scanning or running/);
  assert.ok(await getSession('remove-busy','account'));assert.equal((await readDmDoc<any>('remove-busy',`run:${run.id}`)).status,'finished');
  await releaseAccount('remove-busy','account',lease.token,Date.now()+3600000);
  await removeDmAccount('remove-busy','account');assert.equal(await getSession('remove-busy','account'),null);
});

test("X daily write limit stops the affected account as a restriction",()=>{
  const r=classifyXResponse(200,{errors:[{code:344,message:'You have reached your daily limit for sending Tweets and messages.'}]},new Headers());
  assert.equal(r?.kind,'restriction');assert.equal(r?.xCode,344);
});

test("worker health requires a recent live heartbeat rather than a configured key",async()=>{
  const {dmWorkerHeartbeat,dmWorkerStatus}=await import('../lib/dm-worker.ts');
  assert.equal((await dmWorkerStatus()).online,false);
  await dmWorkerHeartbeat('pc');assert.deepEqual(await dmWorkerStatus(),{online:true,kind:'pc'});
  await updateDmDoc<any>('__dm_system__','worker:heartbeat',()=>null,r=>({...r,at:Date.now()-91000}));
  assert.equal((await dmWorkerStatus()).online,false);
  await dmWorkerHeartbeat('pc',false);assert.equal((await dmWorkerStatus()).online,false);
});

test("Stop during a read cannot be overwritten by a late deferred checkpoint",async()=>{
  const owner='cancel-read-race';await setup(owner);const run=await createDmRun(owner,{id:'account',message:'Reply'});let cancelled=false,writes=0;
  globalThis.fetch=(async(url:any,init:any)=>{
    if(String(url).includes('/conversation/')){if(!cancelled){cancelled=true;await controlDmRun(owner,run.id,'cancel')}return json({conversation_timeline:{entries:[message()]}})}
    if(init?.method==='POST')writes++;
    throw new Error('No writes expected after cancellation');
  }) as typeof fetch;
  const stopped=await processDmRun(owner,run.id,16000);
  assert.equal(stopped.status,'finished');assert.equal(stopped.items[0].status,'skipped');assert.equal(stopped.items[0].error,'Cancelled by operator');assert.equal(writes,0);
  globalThis.fetch=originalFetch;
});

test("ten chats drain independently: four rejected reposts block their replies while six repost and reply",async()=>{
  const owner='post-rejection-isolation';await setup(owner);const chats=Array.from({length:10},(_,i)=>({...chat,id:`111-${300+i}`}));
  await updateDmDoc<any>(owner,'scan:account',()=>null,s=>({...s,chats}));const sent:string[]=[];const creates:Record<string,number>={};
  globalThis.fetch=withRepostReadback(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('/conversation/')){const id=path.split('/conversation/')[1].split('.json')[0],i=chats.findIndex(c=>c.id===id);const m=message(`https://x.com/post/status/12345678${i}`,String(300+i),String(9000+i));m.message.conversation_id=id;m.message.message_data.attachment={tweet:{id_str:`12345678${i}`}};return json({conversation_timeline:{entries:[m],status:'AT_END'}})}
    if(path.includes('CreateRetweet')){const id=JSON.parse(init.body).variables.tweet_id;creates[id]=(creates[id]??0)+1;if(Number(id.slice(-1))%3===0)return json({},404);return json({data:{create_retweet:{retweet_results:{result:{rest_id:`new-${id}`}}}}})}
    const body=JSON.parse(init.body);sent.push(body.conversation_id);return json({entries:[{message:{id:`reply-${sent.length}`}}]});
  });
  let run=await createDmRun(owner,{id:'account',message:'Done',concurrency:3,speed:2,delayMs:1000});
  run=await processDmRun(owner,run.id,40000,10);
  // Part 2: rejected posts never claim a repost, and they never get a reply either.
  assert.equal(run.items.filter(i=>i.status==='sent').length,6);
  assert.equal(sent.length,6);
  assert.equal(runSummary(run).repostSkipped,0);
  const rejected=run.items.filter(i=>i.sentId===undefined);
  assert.equal(rejected.length,4);
  for(const item of rejected){assert.equal(item.reposted.length,0);assert.equal(item.sentId,undefined);assert.equal(creates[item.incoming!.tweetIds[0]],2)}
  globalThis.fetch=originalFetch;
});

test("a rejected repost blocks the reply, and a later pass never sends it",async()=>{
  const owner='post-rejection-recovery';await setup(owner);let writes=0,sends=0;
  globalThis.fetch=withRepostReadback(async(url:any)=>{
    const path=String(url);if(path.includes('/conversation/'))return json({conversation_timeline:{entries:[message()],status:'AT_END'}});
    if(path.includes('CreateRetweet')){writes++;return json({},404)}
    sends++;return json({entries:[{message:{id:'one-reply'}}]});
  });
  let run=await createDmRun(owner,{id:'account',message:'Done'});run=await processDmRun(owner,run.id,16000,1);
  assert.equal(run.items[0].status,'retry_wait');assert.equal(run.items[0].sentId,undefined);assert.equal(sends,0);
  assert.deepEqual(run.items[0].repostSkipped ?? [],[]);
  // Re-running the same chat must still not deliver the DM.
  await updateDmDoc<any>(owner,`run:${run.id}`,()=>null,r=>({...r,nextAt:0,items:r.items.map((i:any)=>({...i,retryAt:0}))}));
  run=await processDmRun(owner,run.id,16000,1);
  assert.equal(sends,0);assert.equal(run.items[0].sentId,undefined);
  globalThis.fetch=originalFetch;
});

test("Pause during the last read before repost prevents the mutation",async()=>{
  const owner='pause-recheck';await setup(owner);let reads=0,writes=0;const run=await createDmRun(owner,{id:'account',message:'Do not send'});
  globalThis.fetch=(async(_url:any,init:any)=>{if(init?.method==='POST'){writes++;throw new Error('No mutation expected')}if(++reads===2)await controlDmRun(owner,run.id,'pause');return json({conversation_timeline:{entries:[message()],status:'AT_END'}})}) as typeof fetch;
  assert.equal((await processDmRun(owner,run.id,16000,1)).status,'paused');assert.equal(writes,0);globalThis.fetch=originalFetch;
});

test("a parked run is only revived when a retry could actually fix something",async()=>{
  await setup("revive-soft");
  const run=await createDmRun("revive-soft",{id:"account",message:"Hi"});
  let calls=0;
  globalThis.fetch=(async()=>{calls++;throw new Error("no X call expected")}) as typeof fetch;
  // Ambiguous write + permanent reject: auto-retrying could duplicate a DM, so it parks for the operator.
  await updateDmDoc<any>("revive-soft",`run:${run.id}`,()=>null,()=>({...run,status:"needs_attention",nextAt:0,
    items:[{...run.items[0],status:"uncertain"},{...run.items[0],id:"second",status:"failed",kind:"permanent"}],
    attention:{error:"parked",at:Date.now()}}));
  const held=await processDmRun("revive-soft",run.id,5000);
  assert.equal(held.status,"needs_attention");
  assert.equal(held.attention?.retries,3,"nothing fixable means it waits for the operator");
  assert.equal(held.attention?.recoverAt,undefined);
  assert.equal(calls,0);
  // A transient timeout is fixable: the legacy park (no recoverAt) gets a deadline instead of sitting dead.
  await updateDmDoc<any>("revive-soft",`run:${run.id}`,()=>null,r=>({...r,attention:{kind:"transient",error:"X request timed out.",at:Date.now()},
    items:[{...r.items[0],status:"failed",kind:"transient"}]}));
  const scheduled=await processDmRun("revive-soft",run.id,5000);
  assert.equal(scheduled.status,"needs_attention");
  assert.equal(scheduled.attention?.kind,"transient");
  assert.ok((scheduled.attention?.recoverAt??0)>Date.now(),"a retry deadline is assigned");
  assert.equal(calls,0);
  // An X restriction (226/344) parked by an older build also gets its backoff.
  await updateDmDoc<any>("revive-soft",`run:${run.id}`,()=>null,r=>({...r,attention:{kind:"restriction",code:226,error:"226",at:Date.now()},
    items:[{...r.items[0],status:"failed",kind:"restriction"}]}));
  const restricted=await processDmRun("revive-soft",run.id,5000);
  assert.equal(restricted.status,"needs_attention");
  const wait=(restricted.attention?.recoverAt??0)-Date.now();
  assert.ok(wait>14*60000&&wait<=20*60000,`226 backs off ~15m, got ${Math.round(wait/60000)}m`);
  assert.equal(calls,0);
  // An auth problem needs the operator, not a retry loop.
  await updateDmDoc<any>("revive-soft",`run:${run.id}`,()=>null,r=>({...r,attention:{kind:"auth",error:"Missing auth_token / ct0.",at:Date.now()},
    items:[{...r.items[0],status:"failed",kind:"auth"}]}));
  const auth=await processDmRun("revive-soft",run.id,5000);
  assert.equal(auth.attention?.retries,3);
  assert.equal(auth.attention?.recoverAt,undefined);
  assert.equal(calls,0);
  globalThis.fetch=originalFetch;
});

test("unread scan scope stops at the unread window instead of walking the whole inbox",async()=>{
  const { scanInbox: scan } = await import("../lib/xdm.ts");
  let timelineCalls = 0;
  const page = (unread: number,from: number) => ({ inbox_timeline: {
    status: "HAS_MORE",min_entry_id: String(from),
    conversations: Object.fromEntries(Array.from({ length: 30 },(_,n) => [`111-${from + n}`,{ participants: [{ user_id: "111" },{ user_id: String(500 + from + n) }],trusted: true,
      unread_count: n === 0 ? unread : 0,sort_timestamp: 1793000000000 - (from + n) }])),
    entries: [],users: {} } });
  globalThis.fetch=(async(url: any) => {
    const path = String(url);
    if (path.includes("initial_state")) return json({ inbox_initial_state: { conversations: { "111-222": { participants: [{ user_id: "111" },{ user_id: "222" }],trusted: true,unread_count: 3,sort_timestamp: 1793000000000 } },
      entries: [message()],users: { "222": { screen_name: "person",name: "Person" } },inbox_timelines: { trusted: { status: "HAS_MORE",min_entry_id: "9000" },untrusted: { status: "AT_END" } } } });
    timelineCalls++;
    // Unread chats only appear on the first two pages; after that the window is exhausted.
    return json(page(timelineCalls <= 2 ? 1 : 0,9000 - timelineCalls * 30));
  }) as typeof fetch;
  const scoped = await scan({}, { self: { id: "111",username: "self" },scope: "unread",pageDelayMs: 250 });
  assert.equal(scoped.pages?.scope,"unread");
  assert.equal(scoped.pages?.stoppedEarly,"unread-window");
  assert.ok(timelineCalls <= 11,`expected an early stop, walked ${timelineCalls} pages`);
  // The walk stops early; the scope filter is applied when the report is built, so the
  // scan store stays complete and the same scan can also serve an "all chats" report.
  const { buildDmReport } = await import("../lib/dm-report.ts");
  const scopedReport = buildDmReport(scoped,{ accountId: "account",handle: "self" })!;
  assert.equal(scopedReport.totals.scope,"unread");
  assert.ok(scopedReport.rows.every(r => r.unread > 0),"the unread report only contains unread chats");
  const full = await scan({}, { self: { id: "111",username: "self" },scope: "all" });
  assert.equal(full.pages?.scope,"all");
  assert.equal(full.pages?.stoppedEarly,undefined);
  assert.ok(full.chats.length > scoped.chats.length,"the full scan keeps walking past the unread window");
  globalThis.fetch=originalFetch;
});

test("scan report carries the user id and the post id for repost and DM",async()=>{
  const { buildDmReport,reportCsv } = await import("../lib/dm-report.ts");
  const scan = { ok: true,self: { id: "111",username: "self" },scannedAt: 1793000000000,
    stats: { total: 2,active: 2,inactive: 0,groups: 0,unseen: 1,unreadTotal: 4 },
    diagnostics: [],pages: { walked: 1,trusted: "AT_END",untrusted: "AT_END",truncated: false,cursors: { trusted: null,untrusted: null },scope: "unread" as const },
    chats: [
      { ...chat,unread: 3,unseen: true,tweetIds: ["123456789"],participants: [{ id: "222",handle: "person",name: "Person" }] },
      { ...chat,id: "111-333",handle: "quiet",unread: 1,unseen: false,lastText: "hey",tweetIds: [],participants: [{ id: "333",handle: "quiet",name: "Quiet" }] } ] };
  const report = buildDmReport(scan as any,{ accountId: "account",handle: "self" })!;
  assert.equal(report.totals.scope,"unread");
  assert.equal(report.totals.chats,2);
  assert.equal(report.totals.incoming,1);
  assert.equal(report.totals.unreadMessages,4);
  assert.equal(report.totals.withPost,1);
  assert.equal(report.totals.withoutPost,1);
  const first = report.rows.find(r => r.conversationId === "111-222")!;
  assert.equal(first.userId,"222");
  assert.equal(first.postId,"123456789");
  assert.equal(first.postUrl,"https://x.com/i/web/status/123456789");
  assert.equal(first.state,"incoming");
  const csv = reportCsv(report);
  assert.ok(csv.startsWith("section,conversation_id,user_id,handle,name,kind,post_id,post_url"));
  assert.ok(csv.includes("incoming,111-222,222,@person,Person,1:1,123456789,https://x.com/i/web/status/123456789"));
  // The "all" scope keeps chats that have no unread messages.
  const all = buildDmReport(scan as any,{ accountId: "account",handle: "self",scope: "all" })!;
  assert.equal(all.totals.scope,"all");
  assert.equal(all.rows.length,2);
  assert.equal(buildDmReport(null,{ accountId: "account",handle: "self" }),null);
});

test("a different retweet id than the one just created never counts as a fresh repost",async()=>{
  const {repostTweet}=await import('../lib/xdm.ts');
  const {freshRepostProof}=await import('../lib/dm-core.ts');
  let retweeted=true;
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('TweetResultByRestId')){
      const qid=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;
      if(qid==='123456789')return json({data:{tweetResult:{result:{rest_id:'123456789',legacy:{retweeted,...(retweeted?{current_user_retweet:{id_str:'old-999'}}:{})}}}}});
      return json({data:{tweetResult:{result:{rest_id:qid,legacy:{retweeted_status_id_str:'123456789',created_at:new Date().toISOString()}}}}});
    }
    if(path.includes('DeleteRetweet')){retweeted=false;return json({data:{delete_retweet:{}}})}
    if(path.includes('CreateRetweet'))retweeted=true;return json({data:{create_retweet:{retweet_results:{result:{rest_id:'new-1'}}}}});
    return json({data:{tweetResult:{result:{rest_id:'123456789',legacy:{retweeted:false}}}}});
  }) as typeof fetch;
  const result=await repostTweet({},'123456789');
  assert.equal(result.ok,false);
  assert.equal(result.kind,'uncertain');
  assert.match(result.error??'',/different retweet/);
  assert.equal(freshRepostProof(result.repostProof,'123456789'),false);
  globalThis.fetch=originalFetch;
});

test("a fresh retweet object pointing at another post never counts as a fresh repost",async()=>{
  const {repostTweet}=await import('../lib/xdm.ts');
  let retweeted=true;
  globalThis.fetch=(async(url:any,init:any)=>{
    const path=String(url);
    if(path.includes('TweetResultByRestId')){
      const qid=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;
      if(qid==='123456789')return json({data:{tweetResult:{result:{rest_id:'123456789',legacy:{retweeted,...(retweeted?{current_user_retweet:{id_str:'new-2'}}:{})}}}}});
      return json({data:{tweetResult:{result:{rest_id:'new-2',legacy:{retweeted_status_id_str:'999999999',created_at:new Date().toISOString()}}}}});
    }
    if(path.includes('DeleteRetweet')){retweeted=false;return json({data:{delete_retweet:{}}})}
    if(path.includes('CreateRetweet'))retweeted=true;return json({data:{create_retweet:{retweet_results:{result:{rest_id:'new-2'}}}}});
    return json({data:{tweetResult:{result:{rest_id:'123456789',legacy:{retweeted:false}}}}});
  }) as typeof fetch;
  const result=await repostTweet({},'123456789');
  assert.equal(result.ok,false);
  assert.equal(result.kind,'uncertain');
  assert.match(result.error??'',/different post/);
  globalThis.fetch=originalFetch;
});

test("a stale saved proof is downgraded by audit when X points at a different retweet",async()=>{
  const {auditDmReposts,createDmRun: createAuditRun}=await import('../lib/dm-run.ts');
  await setup('audit-stale');
  const run=await createAuditRun('audit-stale',{id:'account',message:'Hi'});
  const incoming=incomingMessages({entries:[message()]})[0];
  const staleProof={tweetId:'123456789',retweeted:true,checkedAt:Date.now(),action:'created' as const,mutationAt:Date.now(),mutationId:'old-111',retweetId:'old-111'};
  const item={...run.items[0],status:'sent' as const,incoming,reposted:['123456789'],repostProofs:{'123456789':staleProof},sentId:'old-reply',updatedAt:1};
  await updateDmDoc('audit-stale',`run:${run.id}`,()=>run,r=>({...r,status:'finished' as const,items:[item]}));
  await updateDmDoc('audit-stale',`chat:account:${item.id}`,()=>({...progressFromItem(item,run.id)}),()=>({...progressFromItem(item,run.id)}));
  globalThis.fetch=(async(url:any)=>{
    const id=JSON.parse(new URL(String(url)).searchParams.get('variables')!).tweetId;
    return json({data:{tweetResult:{result:{rest_id:id,legacy:{retweeted:true,current_user_retweet:{id_str:'different-222'}}}}}});
  }) as typeof fetch;
  const audited=await auditDmReposts('audit-stale','account',true);
  assert.equal(audited.progress[chat.id].repostComplete,false);
  assert.equal(audited.progress[chat.id].completed,false);
  assert.equal(audited.progress[chat.id].repostProofs?.['123456789'].retweetId,'different-222');
  assert.notEqual(audited.progress[chat.id].repostProofs?.['123456789'].retweetId,audited.progress[chat.id].repostProofs?.['123456789'].mutationId);
  globalThis.fetch=originalFetch;
});

test("fresh proof requires the reported retweet id to equal the mutation id",async()=>{
  const {freshRepostProof}=await import('../lib/dm-core.ts');
  const base={tweetId:'123',retweeted:true,checkedAt:Date.now(),action:'created' as const,mutationAt:Date.now(),mutationId:'new-1'};
  assert.equal(freshRepostProof({...base,retweetId:'new-1'},'123'),true);
  assert.equal(freshRepostProof({...base,retweetId:'old-9'},'123'),false);
  assert.equal(freshRepostProof({...base},'123'),false);
});
