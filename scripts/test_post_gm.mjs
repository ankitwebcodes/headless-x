// LIVE TEST: post a cookie-synced (gm_) video for @guysexhibition with the user's
// affiliate link via the EXACT panel flow (CreateTweet GraphQL + media_entities).
// Post → verify → DELETE immediately.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const m = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const DSN = (m.match(/DATABASE_URL\s*=\s*"([^"]+)"/) || m.match(/DATABASE_URL\s*=\s*(\S+)/))[1];
const db = neon(DSN);

const BEARER = readFileSync(new URL("./.bearer_tmp", import.meta.url), "utf8").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FEATURES = {
  hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true, highlights_tweets_tab_ui_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true,
  longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_rendering_enabled: true,
  articles_preview_enabled: true, creator_subscriptions_quote_tweet_preview_enabled: false,
  standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true, profile_label_improvements_pcf_label_in_post_enabled: false,
};

const acct = (await db`select id, handle, session_json from accounts where handle ilike '%guysexhibition%' limit 1`)[0];
const s = typeof acct.session_json === "string" ? JSON.parse(acct.session_json) : acct.session_json;
const jar = s.cookies ?? s;
const pick = (n) => Array.isArray(jar) ? (jar.find((c) => c.name === n)?.value ?? "") : (jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");

async function gql(op, qid, body) {
  const r = await fetch(`https://x.com/i/api/graphql/${qid}/${op}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BEARER}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session",
      "content-type": "application/json", cookie, "user-agent": UA, origin: "https://x.com", referer: "https://x.com/home",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

// dynamic qid extraction (same as lib/xpost.ts)
async function qidFor(name, fallback) {
  try {
    const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": UA } });
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

const LINK = "https://www.ourdreamersai13.com/48X5HCL/NFC9H/?uid=193";
const MEDIA_ID = process.argv[2] || "2104631542895226880"; // gm_ video from @guysexhibition's own media tab
const CAPTION = "Panel test post — safe to ignore";

console.log("== posting as @" + acct.handle + " media_id=" + MEDIA_ID);
const createQid = await qidFor("CreateTweet", "wR5Z_lEibLvkew3tF9w-Sg");
console.log("CreateTweet qid:", createQid);
const r = await gql("CreateTweet", createQid, {
  variables: {
    tweet_text: `${CAPTION}\n\n${LINK}`,
    media: { media_entities: [{ media_id: String(MEDIA_ID) }], possibly_sensitive: false },
    semantic_annotation_ids: [],
  },
  features: FEATURES,
  queryId: createQid,
});
console.log("CreateTweet status:", r.status);
const j = JSON.parse(r.text || "{}");
const tid = j?.data?.create_tweet?.tweet_results?.result?.rest_id;
if (j.errors?.length && !tid) { console.log("ERRORS:", JSON.stringify(j.errors).slice(0, 400)); process.exit(1); }
console.log("TWEET OK:", tid ? `https://x.com/${acct.handle}/status/${tid}` : "no id — " + r.text.slice(0, 300));

// verify media + link attached
if (tid) {
  const self = j?.data?.create_tweet?.tweet_results?.result?.legacy;
  console.log("text:", JSON.stringify(self?.full_text ?? "").slice(0, 120));
  console.log("media entities:", (self?.extended_entities?.media ?? []).length,
    (self?.extended_entities?.media ?? [])[0]?.id_str ?? "none");
  // DELETE immediately
  const delQid = await qidFor("DeleteTweet", "nxpZCY2K-I6QoFHAHeojFQ");
  const d = await gql("DeleteTweet", delQid, { variables: { tweet_id: tid }, queryId: delQid });
  console.log("DELETE:", d.status, d.text.slice(0, 120));
}