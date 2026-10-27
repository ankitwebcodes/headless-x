// LIVE TEST: can we sync a cookie-only account's X media library (UserMedia GraphQL)?
// Prints NO secrets — handles, counts, ids only.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const envTxt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const m = envTxt.match(/DATABASE_URL\s*=\s*"([^"]+)"/) || envTxt.match(/DATABASE_URL\s*=\s*'([^']+)'/);
if (!m) { console.error("no DSN"); process.exit(1); }
const sql = neon(m[1]);

const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const OPS = ["Viewer", "UserMedia", "UserTweets"];

const FEATURES = {
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

function loadCookies(sessionJson) {
  let raw = sessionJson ?? [];
  if (typeof raw === "string" && raw.trim()) { try { raw = JSON.parse(raw); } catch { raw = []; } }
  if (Array.isArray(raw)) return raw.map((c) => ({ name: String(c?.name ?? ""), value: String(c?.value ?? "") }));
  if (raw && typeof raw === "object") {
    const nested = raw.cookies;
    if (Array.isArray(nested)) return nested.map((c) => ({ name: String(c?.name ?? ""), value: String(c?.value ?? "") }));
    const map = nested && typeof nested === "object" ? nested : raw;
    return Object.entries(map).filter(([k, v]) => k && typeof v === "string").map(([name, value]) => ({ name, value: String(value) }));
  }
  return [];
}

async function extractQids(cookie) {
  const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": UA } });
  const html = await home.text();
  const urls = Array.from(new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []));
  const out = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) continue;
    const js = await res.text();
    if (!js.includes("operationName:")) continue;
    for (const op of OPS) {
      if (out[op]) continue;
      const mm = js.match(new RegExp(`queryId:"([A-Za-z0-9_-]{10,30})",operationName:"${op}"`)) ||
        js.match(new RegExp(`operationName:"${op}",queryId:"([A-Za-z0-9_-]{10,30})"`));
      if (mm) out[op] = mm[1];
    }
    if (OPS.every((o) => out[o])) break;
  }
  return out;
}

async function gql(op, qid, cookie, csrf, variables, extraFeatures = {}) {
  const feats = { ...FEATURES, ...extraFeatures };
  const url = `https://x.com/i/api/graphql/${qid}/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(feats))}`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${BEARER}`, "x-csrf-token": csrf, cookie, "user-agent": UA, "x-twitter-active-user": "yes", origin: "https://x.com", referer: "https://x.com/media" },
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text: text.slice(0, 300) };
}

function parseMedia(j) {
  const tl = j?.data?.user?.result?.timeline?.timeline ?? j?.data?.user?.media?.timeline ?? null;
  const inst = tl?.instructions ?? [];
  const items = [];
  for (const ins of inst) {
    const entries = ins.entries ?? ins.entry?.content?.items ?? [];
    for (const e of entries) {
      const itemsArr = e?.content?.items ?? [e];
      for (const it of itemsArr) {
        let res = it?.item?.itemContent?.tweet_results?.result ?? it?.content?.itemContent?.tweet_results?.result ?? it?.itemContent?.tweet_results?.result;
        if (res?.__typename === "TweetTombstone" || !res) continue;
        const legacy = res.legacy ?? res.tweet?.legacy;
        const mediaArr = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
        for (const md of mediaArr) {
          if (md.type === "video" || md.type === "animated_gif") {
            const variants = (md.video_info?.variants ?? []).filter((v) => v.content_type === "video/mp4");
            variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
            const best = variants[0];
            if (best) items.push({ id: md.id_str, type: "VIDEO", url: best.url, name: (legacy.full_text ?? "").slice(0, 40) });
          } else if (md.type === "photo") {
            items.push({ id: md.id_str, type: "IMAGE", url: md.media_url_https, name: (legacy.full_text ?? "").slice(0, 40) });
          }
        }
      }
    }
  }
  return items;
}

const rows = await sql`select id, handle, session_json, oauth1_json, ads_account_id from accounts order by created_at desc`;
for (const a of rows) {
  const hasOauth = (() => { try { const o = JSON.parse(a.oauth1_json); return !!(o?.consumer_key && o?.access_token); } catch { return false; } })();
  console.log(`\n== @${a.handle} | ads=${a.ads_account_id ? "yes" : "no"} | oauth1=${hasOauth ? "yes" : "no"}`);
  const cookies = loadCookies(a.session_json);
  const cookie = cookies.filter((c) => c.name && c.value).map((c) => `${c.name}=${c.value}`).join("; ");
  const csrf = cookies.find((c) => c.name === "ct0")?.value ?? "";
  if (!cookie || !csrf) { console.log("   no cookies"); continue; }
  const qids = await extractQids(cookie);
  console.log("   qids:", JSON.stringify(qids));
  if (!qids.Viewer) { console.log("   no Viewer qid — bundle extract failed"); continue; }
  const v = await gql("Viewer", qids.Viewer, cookie, csrf, { withCommunitiesMemberships: true, withSuperFollowsUserFields: true, withUserResults: true, withVoice: true });
  const uname = v.j?.data?.viewer?.user_results?.result?.core?.screen_name;
  const uid2 = v.j?.data?.viewer?.user_results?.result?.rest_id;
  console.log(`   viewer: ${v.status} user=@${uname} id=${uid2}`);
  if (!uid2) continue;
  if (!qids.UserMedia) { console.log("   no UserMedia qid"); continue; }
  const vars1 = { userId: uid2, count: 50, includePromotedContent: false, withClientEventId: true, withSuperFollowsUserFields: true, withSuperFollowsTweetFields: true };
  let r = await gql("UserMedia", qids.UserMedia, cookie, csrf, vars1);
  let items = [];
  if (r.status === 200 && (r.j?.data?.user?.result || r.j?.data?.user?.media)) items = parseMedia(r.j);
  else {
    console.log(`   UserMedia v1 ${r.status}: ${r.text.slice(0, 120)}`);
    const vars2 = { userId: uid2, count: 50 };
    r = await gql("UserMedia", qids.UserMedia, cookie, csrf, vars2);
    if (r.status === 200 && (r.j?.data?.user?.result || r.j?.data?.user?.media)) items = parseMedia(r.j);
    else console.log(`   UserMedia v2 ${r.status}: ${r.text.slice(0, 120)}`);
  }
  console.log(`   MEDIA ITEMS: ${items.length}`);
  for (const it of items.slice(0, 5)) console.log(`     - [${it.type}] ${it.name} → ${it.url.slice(0, 90)}`);
}
console.log("\nDONE");