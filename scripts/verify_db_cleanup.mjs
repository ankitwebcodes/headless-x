// Verify prod DB state: cards/ads_media tables exist (initDb DDL ran), then
// find + delete the old broken plain-link "Wataaa" post on @GuysExhibition.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const m = readFileSync(new URL("../.env.prod", import.meta.url), "utf8");
const env = {};
for (const line of m.split("\n")) {
  const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (mt) env[mt[1]] = mt[2].replace(/^"|"$/g, "");
}
const db = neon(env.DATABASE_URL);

const t = await db`select table_name from information_schema.tables where table_name in ('cards','ads_media')`;
console.log("cache tables in prod DB:", t.map((r) => r.table_name).join(", ") || "NONE");
const cnt = await db`select count(*)::int as c from cards`.catch(() => [{ c: -1 }]);
console.log("cards cached:", cnt[0].c);

// ---- find the broken Wataaa post ----
const g = (await db`select session_json from accounts where handle='guysexhibition' limit 1`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => Array.isArray(jar) ? (jar.find((c) => c.name === n)?.value ?? "") : (jar[n] ?? "");
const xp = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const GUEST_BEARER = (xp.match(/GUEST_BEARER =\s*\n?\s*"([^"]+)"/) || [])[1];
const WEB_UA = (xp.match(/WEB_UA = "([^"]+)"/) || [])[1] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const H = {
  authorization: `Bearer ${GUEST_BEARER}`, "x-csrf-token": pick("ct0"),
  "x-twitter-auth-type": "OAuth2Session", "content-type": "application/json",
  cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home",
};
const vQid = await qidFor("Viewer", "TpQxQtWMTMnIAMPlMGMqNw");
const vres = await fetch(`https://x.com/i/api/graphql/${vQid}/Viewer`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    variables: { withCommunitiesMemberships: true, isGolden: true, subscriptionsFeature: {}, showBluebirdWarning: true, highlightLabelsEnabled: false, withVoice: true, withCommunities: true, withSuperbird: true },
    features: { responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, responsive_web_subscriptions_enabled: true, creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, c9s_tweet_anatomy_moderator_badge_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, rweb_tipjar_consumption_enabled: true, longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true, standardized_nudges_misinfo: true, profile_label_improvements_pcf_label_in_post_enabled: true, responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true, longform_notetweets_creation_enabled: true, articles_preview_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true },
    queryId: vQid,
  }),
});
const vj = await vres.text().catch(() => "{}");
const uid = (JSON.parse(vj)?.data?.viewer?.user_results?.result?.rest_id) ?? undefined;
console.log("vcr status:", vj?.length, "| uid ok:", !!uid, "| err:", (() => { try { return JSON.parse(vj)?.errors?.[0]?.message ?? "none"; } catch { return "parse"; } })());
console.log("uid present:", !!uid);

// fetch own tweets
const uTweetsQid = "L5fO4F1EcL6WwbQQIrEk9Q"; // UserTweets fallback; qidFor is better but skip
async function qidFor(name, fallback) {
  try {
    const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": WEB_UA } });
    const html = await home.text();
    const urls = Array.from(new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []));
    for (const u of urls) {
      const res = await fetch(u);
      if (!res.ok) continue;
      const js = await res.text();
      const mm = js.match(new RegExp('queryId:"([A-Za-z0-9_-]{10,30})",operationName:"' + name + '"')) ||
        js.match(new RegExp('operationName:"' + name + '",queryId:"([A-Za-z0-9_-]{10,30})"'));
      if (mm) return mm[1];
    }
  } catch {}
  return fallback;
}
const qid = await qidFor("UserTweets", uTweetsQid);
const r = await fetch(`https://x.com/i/api/graphql/${qid}/UserTweets`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    variables: { userId: uid, count: 40, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: false, withV2Timeline: true },
    features: { rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, c9s_tweet_anatomy_moderator_badge_enabled: true, articles_preview_enabled: true, responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true, longform_notetweets_creation_enabled: false, standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true },
    queryId: qid,
  }),
});
const j = await r.json().catch(() => ({}));
console.log("UserTweets status:", r.status, "| err:", JSON.stringify(j?.errors?.[0]?.message ?? j?.data?.error ?? "none").slice(0, 100));
const tl = j?.data?.user?.result;
const timelines = { timeline_v2: tl?.timeline_v2?.timeline, timeline: tl?.timeline?.timeline };
for (const [k, t] of Object.entries(timelines)) {
  const instr = t?.instructions ?? [];
  console.log(k, "instructions:", instr.map((i) => i.type + "(" + ((i.entries ?? []).length || (i.moduleItems ?? []).length) + ")").join(" "));
}
const entries = (timelines.timeline_v2?.instructions ?? timelines.timeline?.instructions ?? []).flatMap((i) => i.entries ?? []);
const found = [];
for (const e of entries) {
  const res = e?.content?.itemContent?.tweet_results?.result;
  const legacy = res?.legacy;
  if (!legacy) continue;
  const txt = legacy.full_text ?? "";
  if (txt.includes("Wataaa") || txt.includes("ourdreamersai13")) {
    found.push({ id: legacy.id_str, text: txt.slice(0, 90), card: !!res?.card });
  }
}
console.log("target posts found:", found.length, "| total entries:", entries.length);
for (const e of entries.slice(0, 5)) {
  const res = e?.content?.itemContent?.tweet_results?.result;
  console.log("sample:", res?.legacy?.full_text?.slice(0, 60) ?? e?.content?.entryType ?? "(empty)");
}
for (const f of found) console.log(" -", f.id, "| card:", f.card, "|", f.text);

// delete each one found (these are broken-format leftovers)
const delQid = await qidFor("DeleteTweet", "nxpZCY2K-I6QoFHAHeojFQ");
for (const f of found) {
  const d = await fetch(`https://x.com/i/api/graphql/${delQid}/DeleteTweet`, {
    method: "POST", headers: H,
    body: JSON.stringify({ variables: { tweet_id: f.id }, queryId: delQid }),
  });
  console.log("DELETE", f.id, "->", d.status);
}
console.log(found.length === 0 ? "nothing to clean" : "cleanup done");