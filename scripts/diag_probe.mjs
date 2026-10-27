// Diagnostic: real probeSession equivalent (Viewer endpoint) for every account.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const env = {};
for (const f of ["../.env.prod", "../.env.local"]) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), "utf8").split("\n")) {
      const mt = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (mt) env[mt[1]] = mt[2].replace(/^"|"$/g, "");
    }
    break;
  } catch { /* next */ }
}

const XPOST = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const guest = (XPOST.match(/GUEST_BEARER\s*=\s*\n?\s*"([^"]+)"/) || [])[1];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FEATS = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_rendering_enabled: true,
  articles_preview_enabled: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: false,
};
const VIEWER_QIDS = ["TpQxQtWMTMnIAMPlMGMqNw"];

const db = neon(env.DATABASE_URL);
const rows = await db`select handle, session_json from accounts order by handle`;
const pick = (jar, n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");
const t0 = Date.now();

for (const r of rows) {
  const raw = typeof r.session_json === "string" ? JSON.parse(r.session_json || "{}") : (r.session_json || {});
  const jar = raw.cookies ?? raw;
  const auth = pick(jar, "auth_token");
  const ct0 = pick(jar, "ct0");
  if (!auth || !ct0) { console.log(`${r.handle.padEnd(18)} NO-COOKIES`); continue; }
  const vars = encodeURIComponent(JSON.stringify({ withCommunitiesMemberships: true, withSuperFollowsUserFields: true, withUserResults: true, withVoice: true }));
  const feats = encodeURIComponent(JSON.stringify(FEATS));
  const t = Date.now();
  let out = "?";
  for (const qid of VIEWER_QIDS) {
    try {
      const res = await fetch(`https://x.com/i/api/graphql/${qid}/Viewer?variables=${vars}&features=${feats}`, {
        headers: {
          authorization: `Bearer ${guest}`,
          "x-csrf-token": ct0,
          "x-twitter-active-user": "yes",
          cookie: `auth_token=${auth}; ct0=${ct0}`,
          "user-agent": UA,
          origin: "https://x.com",
          referer: "https://x.com/home",
        },
      });
      if (res.status === 200) {
        const j = await res.json();
        const u = j?.data?.viewer?.user_results?.result;
        const sn = u?.core?.screen_name;
        out = sn ? `OK @${sn}` : "no-username";
      } else {
        out = `http ${res.status}`;
      }
    } catch (e) { out = "ERR " + String(e.message).slice(0, 50); }
    if (out.startsWith("OK")) break;
  }
  console.log(`${r.handle.padEnd(18)} ${out.padEnd(22)} ${Date.now() - t}ms`);
}
console.log(`total ${Date.now() - t0}ms`);
