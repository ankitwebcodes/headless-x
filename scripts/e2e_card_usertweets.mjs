// E2E: real login on prod -> post video+link -> verify CARD via the account's
// own UserTweets timeline -> delete tweet. Prints NO secrets.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

const m = readFileSync(new URL("../.env.prod", import.meta.url), "utf8");
const env = {};
for (const line of m.split("\n")) {
  const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (mt) env[mt[1]] = mt[2].replace(/^\"|\"$/g, "");
}
const db = neon(env.DATABASE_URL);
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---- qa admin ----
const EMAIL = "qa-e2e-admin@pinelab.org";
const PW = "Qa" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
await db`delete from users where email = ${EMAIL}`;
await db`insert into users (id, email, password_hash, name, role, created_at) values ('qa-e2e-admin-0003', ${EMAIL}, ${bcrypt.hashSync(PW, 10)}, 'QA E2E Admin', 'admin', ${Date.now()})`;

// ---- login ----
const login = await fetch("https://x-panel-six.vercel.app/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
const sess = (login.headers.get("set-cookie") || "").match(/xp_session=([^;]+)/)?.[1];
console.log("login:", login.status, "| cookie:", sess ? "YES" : "NO");
if (!sess) process.exit(1);

// ---- post ----
const acct = (await db`select id, handle, user_id from accounts where handle='guysexhibition' limit 1`)[0];
const vid = (await db`select id, media_key from media where account_id = ${acct.id} and media_type='VIDEO' and media_key like 'gm_%' order by created_at desc limit 1`)[0];
const LINK = "https://www.ourdreamersai13.com/48X5HCL/NFC9H/?uid=193";
const res = await fetch("https://x-panel-six.vercel.app/api/posts", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `xp_session=${sess}` },
  body: JSON.stringify({
    accountId: acct.id, mediaId: vid.id,
    caption: "E2E card check — safe to ignore",
    url: LINK, title: "Try free",
  }),
});
const body = await res.json().catch(() => ({}));
console.log("POST:", res.status, "| path:", body.job?.path, "| error:", body.error ?? body.job?.error ?? "none");
const tweetUrl = body.tweetUrl ?? body.job?.tweetUrl;
if (!tweetUrl) process.exit(1);
const tid = tweetUrl.split("/status/")[1];
console.log("tweet:", tweetUrl);

// ---- UserTweets card check (own session) ----
const g = (await db`select session_json from accounts where handle='guysexhibition' limit 1`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");
const guest = (readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8").match(/GUEST_BEARER\s*=\s*\n?\s*"([^"]+)"/) || [])[1];
const twidRaw = decodeURIComponent(pick("twid") ?? "");
const twidNum = twidRaw.match(/u=(\d+)/)?.[1];
const uid = twidNum ?? pick("u");

async function qidFor(name, fallback) {
  const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": WEB_UA } });
  const html = await home.text();
  const urls = Array.from(new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []));
  for (const u of urls) {
    const rr = await fetch(u);
    if (!rr.ok) continue;
    const js = await rr.text();
    const mm = js.match(new RegExp('queryId:"([A-Za-z0-9_-]{10,30})",operationName:"' + name + '"')) ||
               js.match(new RegExp('operationName:"' + name + '",queryId:"([A-Za-z0-9_-]{10,30})"'));
    if (mm) return mm[1];
  }
  return fallback;
}

const qid = await qidFor("UserTweets", "V7H0g9qrOHHvDhD3S2qiww");
const vars = { userId: uid, count: 40, includePromotedContent: false, withQuickPromoteEligibilityTelemetryField: true, withVoice: false };
const feats = {
  responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_action_policy_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true,
  rweb_video_timestamps_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true, view_counts_everywhere_api_enabled: true,
};
const r = await fetch(`https://x.com/i/api/graphql/${qid}/UserTweets?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(feats))}`, {
  method: "GET",
  headers: {
    authorization: `Bearer ${guest}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session",
    cookie, "user-agent": WEB_UA, "content-type": "application/json", origin: "https://x.com", referer: "https://x.com/GuysExhibition",
  },
});
const t = await r.text();
console.log("DEBUG uid:", uid, "| qid:", qid, "| guest:", guest ? "YES" : "NO", "| HTTP:", r.status, "| bytes:", t.length);
let found = null;
let foundPath = null;
let tweetCount = 0;
const scan = (o, p) => {
  if (!o || typeof o !== "object") return;
  if (typeof o?.rest_id === "string" && /^\d+$/.test(o.rest_id) && (o.legacy?.full_text || o.card)) { tweetCount++; if (tweetCount <= 3) console.log("  seen tweet:", o.rest_id, JSON.stringify(o.legacy?.full_text ?? "").slice(0, 60)); }
  if (o?.rest_id === tid && (o.core || o.legacy || o.card)) { if (!found) { found = o; foundPath = p.join("."); } return; }
  for (const [k, v] of Object.entries(o)) scan(v, [...p, k]);
  if (found) return;
};
try { scan(JSON.parse(t), []); } catch { console.log("PARSE FAIL:", t.slice(0, 300)); }
if (!found) {
  console.log("TWEET NOT IN TIMELINE (HTTP " + r.status + ")");
} else {
  console.log("FOUND PATH:", foundPath);
  console.log("FOUND KEYS:", Object.keys(found).join(","));
  const c = found.card ?? null;
  const bind = c?.legacy?.binding_values ?? [];
  const unified = bind.find((b) => b.key === "unified_card")?.value?.string_value;
  const uType = unified ? (JSON.parse(unified)?.type ?? "?") : null;
  const legacyName = c?.name ?? c?.legacy?.name ?? null;
  console.log("CARD:", c ? `PRESENT | rest_id=${c.rest_id ?? "?"} | type=${legacyName ?? uType ?? "?"}` : "NONE");
  console.log("FULL_TEXT:", String(found.legacy?.full_text ?? "").slice(0, 160));
  console.log("LINK_IN_TEXT:", String(found.legacy?.full_text ?? "").includes("ourdreamersai13"));
}

// ---- cleanup ----
const xp = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const delQid = "nxpZCY2K-I6QoFHAHeojFQ";
const d = await fetch(`https://x.com/i/api/graphql/${delQid}/DeleteTweet`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${guest}`, "x-csrf-token": csrf,
    "x-twitter-auth-type": "OAuth2Session", "content-type": "application/json",
    cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home",
  },
  body: JSON.stringify({ variables: { tweet_id: tid }, queryId: delQid }),
});
console.log("DELETE:", d.status);
await db`delete from users where email = ${EMAIL}`;
console.log("qa user cleaned");
