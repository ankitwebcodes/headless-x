// Probe: post a card_uri tweet, dump card presence in CreateTweet response AND UserTweets, then delete.
// Usage: node scripts/probe_card.mjs
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
const m = readFileSync(new URL("../.env.prod", import.meta.url), "utf8");
const env = {};
for (const line of m.split("\n")) { const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (mt) env[mt[1]] = mt[2].replace(/^\"|\"$/g, ""); }
const db = neon(env.DATABASE_URL);
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const xts = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const guest = (xts.match(/GUEST_BEARER\s*=\s*\n?\s*"([^"]+)"/) || [])[1];
const g = (await db`select session_json from accounts where handle='guysexhibition' limit 1`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");
const uid = decodeURIComponent(pick("twid")).match(/u=(\d+)/)?.[1];

// card_uri from the cached cards table (already live-verified)
const cardRow = (await db`select card_uri, link from cards order by created_at desc limit 1`)[0];
console.log("card_uri:", cardRow?.card_uri, "| link:", cardRow?.link);
if (!cardRow) process.exit(1);

const qid = await (async () => {
  const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": WEB_UA } });
  const html = await home.text();
  const urls = Array.from(new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []));
  for (const u of urls) {
    const rr = await fetch(u);
    if (!rr.ok) continue;
    const js = await rr.text();
    const mm = js.match(/queryId:"([A-Za-z0-9_-]{10,30})",operationName:"CreateTweet"/) ||
               js.match(/operationName:"CreateTweet",queryId:"([A-Za-z0-9_-]{10,30})"/);
    if (mm) return mm[1];
  }
  return null;
})();
console.log("CreateTweet qid:", qid);

const body = {
  variables: {
    tweet_text: "Probe card check — safe to ignore",
    media: { media_entities: [], possibly_sensitive: false },
    card_uri: cardRow.card_uri,
    semantic_annotation_ids: [],
  },
  features: {
    responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_action_policy_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true,
    rweb_video_timestamps_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true, view_counts_everywhere_api_enabled: true,
  },
  queryId: qid,
};
const res = await fetch(`https://x.com/i/api/graphql/${qid}/CreateTweet`, {
  method: "POST",
  headers: { authorization: `Bearer ${guest}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session", "content-type": "application/json", cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home" },
  body: JSON.stringify(body),
});
const rt = await res.text();
let rj = null;
try { rj = JSON.parse(rt); } catch {}
const result = rj?.data?.create_tweet?.tweet_results?.result ?? rj?.data?.createTweet?.tweet_results?.result ?? null;
const tid = result?.rest_id;
console.log("CreateTweet HTTP:", res.status, "| tweet id:", tid);
if (!tid) { console.log("RESPONSE:", rt.slice(0, 600)); process.exit(1); }
console.log("CREATE-RESULT keys:", Object.keys(result).join(","));
console.log("CREATE-RESULT card:", JSON.stringify(result.card ?? null)?.slice(0, 400));
console.log("CREATE-RESULT card_uri:", result.card_uri ?? result.legacy?.card_uri ?? "(none)");
console.log("CREATE-RESULT full_text:", JSON.stringify(result.legacy?.full_text ?? null));

// now UserTweets
const uqid = "7_KBXBpG0zBPRN6UCIV0-w";
const uvars = { userId: uid, count: 20, includePromotedContent: false };
const ufeats = {
  responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_action_policy_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true,
  rweb_video_timestamps_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true, view_counts_everywhere_api_enabled: true,
};
const r2 = await fetch(`https://x.com/i/api/graphql/${uqid}/UserTweets?variables=${encodeURIComponent(JSON.stringify(uvars))}&features=${encodeURIComponent(JSON.stringify(ufeats))}`, {
  method: "GET",
  headers: { authorization: `Bearer ${guest}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session", cookie, "user-agent": WEB_UA, "content-type": "application/json", origin: "https://x.com", referer: "https://x.com/GuysExhibition" },
});
const t2 = await r2.text();
let j2 = null;
try { j2 = JSON.parse(t2); } catch {}
// find ALL occurrences of tid in the tree, print parent chain keys + any card nearby
const paths = [];
const walk = (o, p) => {
  if (!o || typeof o !== "object") return;
  if (typeof o.rest_id === "string" && o.rest_id === tid) paths.push({ p, obj: o });
  for (const [k, v] of Object.entries(o)) walk(v, [...p, k]);
};
walk(j2, []);
console.log("UserTweets HTTP:", r2.status, "| tid occurrences:", paths.length);
for (const { p, obj } of paths) {
  console.log("  path:", p.join("."));
  console.log("  keys:", Object.keys(obj).join(","));
  console.log("  card:", JSON.stringify(obj.card ?? null)?.slice(0, 400));
  console.log("  tweet_results keys:", obj.tweet_results ? Object.keys(obj.tweet_results).join(",") : "-");
  if (obj.tweet_results?.result) {
    console.log("  inner result keys:", Object.keys(obj.tweet_results.result).join(","));
    console.log("  inner card:", JSON.stringify(obj.tweet_results.result.card ?? null)?.slice(0, 400));
    console.log("  inner full_text:", JSON.stringify(obj.tweet_results.result.legacy?.full_text ?? null));
  }
}
if (paths.length === 0) console.log("UserTweets TEXT sample:", t2.slice(0, 300));

// delete
const delQid = "nxpZCY2K-I6QoFHAHeojFQ";
const d = await fetch(`https://x.com/i/api/graphql/${delQid}/DeleteTweet`, {
  method: "POST",
  headers: { authorization: `Bearer ${guest}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session", "content-type": "application/json", cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home" },
  body: JSON.stringify({ variables: { tweet_id: tid }, queryId: delQid }),
});
console.log("DELETE:", d.status);
