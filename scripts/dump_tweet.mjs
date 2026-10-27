// Dump raw UserTweets tweet objects (no secrets printed). Usage: node scripts/dump_tweet.mjs [count]
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
const m = readFileSync(new URL("../.env.prod", import.meta.url), "utf8");
const env = {};
for (const line of m.split("\n")) { const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (mt) env[mt[1]] = mt[2].replace(/^\"|\"$/g, ""); }
const db = neon(env.DATABASE_URL);
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const g = (await db`select session_json from accounts where handle='guysexhibition' limit 1`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");
const guest = (readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8").match(/GUEST_BEARER\s*=\s*\n?\s*"([^"]+)"/) || [])[1];
const uid = decodeURIComponent(pick("twid")).match(/u=(\d+)/)?.[1];
const qid = "7_KBXBpG0zBPRN6UCIV0-w";
const vars = { userId: uid, count: Number(process.argv[2] ?? 20), includePromotedContent: false };
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
  headers: { authorization: `Bearer ${guest}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session", cookie, "user-agent": WEB_UA, "content-type": "application/json", origin: "https://x.com", referer: "https://x.com/GuysExhibition" },
});
const j = await r.json();
const results = [];
const walk = (o) => {
  if (!o || typeof o !== "object") return;
  if (typeof o.rest_id === "string" && /^\d+$/.test(o.rest_id) && o.legacy) results.push(o);
  for (const v of Object.values(o)) walk(v);
};
walk(j);
for (const t of results) {
  console.log("rest_id:", t.rest_id);
  console.log("keys:", Object.keys(t).join(","));
  console.log("full_text:", JSON.stringify(t.legacy?.full_text));
  console.log("entities.urls:", JSON.stringify(t.legacy?.entities?.urls ?? null));
  console.log("card:", t.card ? t.card.name : "NONE");
  console.log("media:", t.legacy?.extended_entities?.media ? (t.legacy.extended_entities.media.map((x) => x.type).join(",") || "empty") : "NONE");
  console.log("---");
}
