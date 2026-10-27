// CROSS-ACCOUNT CARD TEST v2: upload guysexhibition's video to the gold ads
// library via OAuth1 chunked upload, create VIDEO_WEBSITE card, attach
// card_uri to a CreateTweet posted via guysexhibition's session cookies.
// Post → verify → DELETE immediately.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const m = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const DSN = (m.match(/DATABASE_URL\s*=\s*"([^"]+)"/) || m.match(/DATABASE_URL\s*=\s*(\S+)/))[1];
const db = neon(DSN);

const xp = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const GUEST_BEARER = (xp.match(/GUEST_BEARER =\s*\n?\s*"([^"]+)"/) || [])[1];
const WEB_UA = (xp.match(/WEB_UA = "([^"]+)"/) || [])[1] ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const gold = (await db`select oauth1_json, ads_account_id from accounts where handle='menxbonners'`)[0];
const g = (await db`select handle, session_json from accounts where handle='guysexhibition'`)[0];
const o1 = typeof gold.oauth1_json === "string" ? JSON.parse(gold.oauth1_json) : gold.oauth1_json;
const ADS_ID = gold.ads_account_id;

const vid = (await db`select media_key, url from media where account_id=(select id from accounts where handle='guysexhibition') and media_key like 'gm_%' and media_type='VIDEO' order by created_at desc limit 1`)[0];
if (!vid) { console.log("NO SYNCED VIDEO"); process.exit(1); }
console.log("video:", vid.media_key, "url:", (vid.url || "").slice(0, 70));

const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => Array.isArray(jar) ? (jar.find((c) => c.name === n)?.value ?? "") : (jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");

// ---- OAuth1 signing ----
const { webcrypto } = await import("node:crypto");
const enc = new TextEncoder();
function pct(s) { return encodeURIComponent(s).replace(/[!*']/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }
async function hmac(key, msg) {
  const k = await webcrypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await webcrypto.subtle.sign("HMAC", k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function oauthHeader(method, url, extraParams = {}) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: o1.consumer_key, oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: o1.access_token, oauth_version: "1.0",
  };
  const all = { ...oauth, ...extraParams, ...Object.fromEntries(u.searchParams) };
  const base = [method.toUpperCase(), pct(u.origin + u.pathname), pct(Object.entries(all).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${pct(k)}=${pct(v)}`).join("&"))].join("&");
  const sig = await hmac(`${o1.consumer_secret}&${o1.access_token_secret}`, base);
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${k}="${pct(String(v))}"`).join(", ");
}

const UPLOAD_BASE = "https://upload.twitter.com/1.1/media/upload.json";

// ---- STEP 0: download video ----
console.log("== STEP 0: download video");
const vRes = await fetch(vid.url, { headers: { "user-agent": WEB_UA } });
const buf = Buffer.from(await vRes.arrayBuffer());
console.log("downloaded:", buf.length, "bytes, http", vRes.status);
if (buf.length < 10000) { console.log("TOO SMALL — abort"); process.exit(1); }

// ---- STEP 1: chunked upload to gold ads library ----
console.log("== STEP 1: OAuth1 upload to ads library");
const initQ = { command: "INIT", media_type: "video/mp4", total_bytes: String(buf.length), media_category: "amplify_video" };
const initH = await oauthHeader("POST", UPLOAD_BASE, initQ);
const initRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(initQ)}`, { method: "POST", headers: { authorization: initH } });
const initJson = await initRes.json().catch(() => ({}));
const mediaId = String(initJson?.media_id_string ?? initJson?.media_id ?? "");
console.log("INIT:", initRes.status, "media_id:", mediaId || JSON.stringify(initJson).slice(0, 200));
if (!mediaId) process.exit(1);

const CHUNK = 4 * 1024 * 1024;
for (let i = 0, idx = 0; i < buf.length; i += CHUNK, idx++) {
  const part = buf.subarray(i, Math.min(i + CHUNK, buf.length));
  const q = { command: "APPEND", media_id: mediaId, segment_index: String(idx) };
  const h = await oauthHeader("POST", UPLOAD_BASE, q);
  const B = "XbOuNdArYx9q";
  const head = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="media"; filename="chunk${idx}.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${B}--\r\n`);
  const body = Buffer.concat([head, part, tail]);
  const aRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(q)}`, {
    method: "POST", headers: { authorization: h, "content-type": `multipart/form-data; boundary=${B}`, "content-length": String(body.length) },
    body: new Uint8Array(body),
  });
  if (!aRes.ok) { console.log("APPEND fail:", aRes.status, (await aRes.text()).slice(0, 200)); process.exit(1); }
}
console.log("APPEND ok");
const fq = { command: "FINALIZE", media_id: mediaId };
const fh = await oauthHeader("POST", UPLOAD_BASE, fq);
const fRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(fq)}`, { method: "POST", headers: { authorization: fh } });
let fJson = await fRes.json().catch(() => ({}));
console.log("FINALIZE:", fRes.status, "state:", fJson?.processing_info?.state ?? "none");
if (fJson?.processing_info?.state && fJson.processing_info.state !== "succeeded") {
  for (let attempt = 0; attempt < 30; attempt++) {
    const waitMs = Math.max(2000, (fJson?.processing_info?.check_after_secs ?? 4) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    const sq = { command: "STATUS", media_id: mediaId };
    const sh = await oauthHeader("GET", UPLOAD_BASE, sq);
    const sRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(sq)}`, { method: "GET", headers: { authorization: sh } });
    const sJson = await sRes.json().catch(() => ({}));
    const st = sJson?.processing_info?.state;
    console.log("  STATUS:", st);
    if (st === "succeeded") break;
    if (st === "failed") { console.log("PROCESSING FAILED:", JSON.stringify(sJson).slice(0, 300)); process.exit(1); }
    if (sJson?.processing_info) fJson.processing_info = sJson.processing_info;
  }
}

// ---- STEP 2: create card under gold ads account ----
const LINK = "https://www.ourdreamersai13.com/48X5HCL/NFC9H/?uid=193";
console.log("== STEP 2: create VIDEO_WEBSITE card");
async function adsFetch(method, path, payload) {
  const url = `https://ads-api.x.com/12${path}`;
  const auth = await oauthHeader(method, url);
  const r = await fetch(url, { method, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
  return { status: r.status, text: await r.text() };
}
const cardRes = await adsFetch("POST", `/accounts/${ADS_ID}/cards`, {
  card_type: "VIDEO_WEBSITE",
  name: `xcard_${mediaId}`,
  components: [
    { media_key: `13_${mediaId}`, type: "MEDIA" },
    { title: "Try free", destination: { url: LINK, type: "WEBSITE" }, type: "DETAILS" },
  ],
});
console.log("card status:", cardRes.status, cardRes.text.slice(0, 300));
const cardJ = JSON.parse(cardRes.text || "{}");
const cardUri = cardJ?.data?.card_uri || cardJ?.data?.[0]?.card_uri;
if (!cardUri) { console.log("NO CARD URI — stopping"); process.exit(1); }
console.log("CARD_URI:", cardUri);

// ---- STEP 3: CreateTweet via guysexhibition cookies with card_uri ----
async function gql(op, qid, body) {
  const r = await fetch(`https://x.com/i/api/graphql/${qid}/${op}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${GUEST_BEARER}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session",
      "content-type": "application/json", cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}
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
console.log("== STEP 3: CreateTweet as @guysexhibition with card_uri");
const createQid = await qidFor("CreateTweet", "wR5Z_lEibLvkew3tF9w-Sg");
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
const r = await gql("CreateTweet", createQid, {
  variables: {
    tweet_text: "Panel card test — safe to ignore",
    media: { media_entities: [], possibly_sensitive: false },
    card_uri: cardUri,
    semantic_annotation_ids: [],
  },
  features: FEATURES,
  queryId: createQid,
});
console.log("CreateTweet status:", r.status);
const j = JSON.parse(r.text || "{}");
const tid = j?.data?.create_tweet?.tweet_results?.result?.rest_id;
if (j.errors?.length && !tid) console.log("ERRORS:", JSON.stringify(j.errors).slice(0, 500));
if (tid) {
  const res = j?.data?.create_tweet?.tweet_results?.result;
  console.log("TWEET OK: https://x.com/" + g.handle + "/status/" + tid);
  console.log("card in result:", !!res?.card, res?.card?.name ?? "");
  console.log("legacy entities:", JSON.stringify(res?.legacy?.entities ?? {}).slice(0, 200));
  console.log("media in legacy:", (res?.legacy?.extended_entities?.media ?? []).length);
  const delQid = await qidFor("DeleteTweet", "nxpZCY2K-I6QoFHAHeojFQ");
  const d = await gql("DeleteTweet", delQid, { variables: { tweet_id: tid }, queryId: delQid });
  console.log("DELETE:", d.status, d.text.slice(0, 100));
} else {
  console.log("no tweet id; raw:", r.text.slice(0, 500));
}
