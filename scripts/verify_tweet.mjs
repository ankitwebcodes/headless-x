// Verify card via TweetDetail — bundles scanned from home + profile page.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const TID = process.argv[2];
if (!TID) { console.log("usage: node verify_tweet.mjs <tweetId>"); process.exit(1); }

const envf = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const db = neon((envf.match(/DATABASE_URL\s*=\s*"([^"]+)"/) || envf.match(/DATABASE_URL\s*=\s*(\S+)/))[1]);
const xp = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const GUEST = (xp.match(/GUEST_BEARER =\s*\n?\s*"([^"]+)"/) || [])[1];
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const g = (await db`select session_json from accounts where id = 'ab625df9-786f-4c68-b4f3-f9b505a72614'`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");

// collect bundle URLs from home + profile page
const urls = new Set();
for (const page of ["https://x.com/home", "https://x.com/GuysExhibition"]) {
  try {
    const html = await (await fetch(page, { headers: { cookie, "user-agent": WEB_UA } })).text();
    for (const u of html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []) urls.add(u);
  } catch {}
}
console.log("bundles:", urls.size);
let qid = null;
for (const u of urls) {
  try {
    const js = await (await fetch(u)).text();
    if (!js.includes("TweetDetail")) continue;
    const m = js.match(/queryId:"([A-Za-z0-9_-]{10,30})",operationName:"TweetDetail"/) ||
      js.match(/operationName:"TweetDetail",queryId:"([A-Za-z0-9_-]{10,30})"/);
    if (m) { qid = m[1]; break; }
  } catch {}
}
console.log("TweetDetail qid:", qid);
if (!qid) process.exit(1);

const r = await fetch(`https://x.com/i/api/graphql/${qid}/TweetDetail`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${GUEST}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session",
    "content-type": "application/json", cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: `https://x.com/GuysExhibition/status/${TID}`,
  },
  body: JSON.stringify({
    variables: { focalTweetId: TID, with_rux_injections: false, rankingMode: "Relevance", count: 20, includePromotedContent: true, withBirdwatchNotes: true, withVoice: true },
    features: {
      rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      articles_preview_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true,
      rweb_video_timestamps_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
      view_counts_everywhere_api_enabled: true, profile_label_improvements_pcf_label_in_post_enabled: false,
    },
    fieldToggles: { withArticleRichContentState: true, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false },
  }),
});
const t = await r.text();
console.log("HTTP", r.status);
let found = null;
const scan = (o) => {
  if (!o || typeof o !== "object" || found) return;
  if (o?.rest_id === TID && (o.card || o.legacy || o.core)) { found = o; return; }
  for (const v of Object.values(o)) { if (!found) scan(v); }
};
try { scan(JSON.parse(t)); } catch { console.log("PARSE FAIL:", t.slice(0, 300)); }
if (!found) { console.log("tweet object not found in response"); console.log(t.slice(0, 400)); process.exit(1); }
console.log("CARD_JSON:", JSON.stringify(found.card).slice(0, 700));
console.log("FULL_TEXT:", String(found.legacy?.full_text ?? "").slice(0, 160));
console.log("LEGACY_MEDIA:", (found.legacy?.extended_entities?.media ?? []).length);
console.log("LEGACY_URLS:", JSON.stringify(found.legacy?.entities?.urls ?? []).slice(0, 200));
