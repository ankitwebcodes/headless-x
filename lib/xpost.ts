import { randomUUID, webcrypto } from "node:crypto";
import { readMediaBytes } from "@/lib/storage";

// ---------------------------------------------------------------------------
// X posting helpers (serverless): ads-api OAuth1 (cards) + web GraphQL
// (CreateTweet with session cookies). Mirrors the proven Python pipeline at
// ~/x_poster/pipeline/{card,post}.py.
// ---------------------------------------------------------------------------

export type OAuth1Creds = {
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_token_secret: string;
};

export const API_BASE = "https://ads-api.x.com/12";

// Public token used by the X web client for every GraphQL call; auth is via
// the session cookies + csrf header.
export const GUEST_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---- dynamic GraphQL query ids --------------------------------------------
// X rotates operation queryIds; a stale qid breaks calls with auth errors.
// We keep last-known-good fallbacks and refresh from X's own JS bundle.
const QID_FALLBACKS: Record<string, string> = {
  Viewer: "TpQxQtWMTMnIAMPlMGMqNw",
  CreateTweet: "wR5Z_lEibLvkew3tF9w-Sg",
  DeleteTweet: "nxpZCY2K-I6QoFHAHeojFQ",
  UserMedia: "QWOimofaocjeRda7Tm5pNA", // live-verified 2026-10
};
const qidCache = new Map<string, string>();
let qidFetchedAt = 0;

async function extractQueryIdsFromBundle(cookie: string): Promise<Record<string, string> | null> {
  try {
    const home = await fetch("https://x.com/home", {
      headers: { cookie, "user-agent": WEB_UA },
    });
    const html = await home.text();
    const urls = Array.from(
      new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? [])
    );
    const out: Record<string, string> = {};
    for (const u of urls) {
      const res = await fetch(u);
      if (!res.ok) continue;
      const js = await res.text();
      if (!js.includes('operationName:')) continue;
      for (const op of Object.keys(QID_FALLBACKS)) {
        if (out[op]) continue;
        const m =
          js.match(new RegExp(`queryId:"([A-Za-z0-9_-]{10,30})",operationName:"${op}"`)) ||
          js.match(new RegExp(`operationName:"${op}",queryId:"([A-Za-z0-9_-]{10,30})"`));
        if (m) out[op] = m[1];
      }
      if (out.Viewer && out.CreateTweet && out.UserMedia) break;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function queryId(op: string, cookie: string, force = false): Promise<string> {
  if (force || Date.now() - qidFetchedAt > 6 * 3600_000) {
    const fresh = await extractQueryIdsFromBundle(cookie);
    if (fresh) {
      for (const [k, v] of Object.entries(fresh)) qidCache.set(k, v);
      qidFetchedAt = Date.now();
    } else if (!force) {
      qidFetchedAt = Date.now(); // don't hammer the bundle on every call
    }
  }
  return qidCache.get(op) || QID_FALLBACKS[op] || "";
}

// --- URL/pct encoding helpers ----------------------------------------------

const pct = (s: string): string =>
  encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/%7E/g, "~")
    .replace(/\*/g, "%2A");

const utf8 = (s: string): Uint8Array => Buffer.from(s, "utf-8");

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const subtle = webcrypto.subtle;
  const k = await subtle.importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await subtle.sign("HMAC", k, utf8(data));
  return Buffer.from(sig).toString("base64");
}

export async function oauthHeader(
  creds: OAuth1Creds,
  method: string,
  baseUrl: string,
  query: Record<string, string> = {}
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumer_key,
    oauth_nonce: randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.access_token,
    oauth_version: "1.0",
  };
  const params: Record<string, string> = { ...query, ...oauth };
  const base = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const sigBase = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(base)}`;
  const key = `${pct(creds.consumer_secret)}&${pct(creds.access_token_secret)}`;
  const signature = await hmacSha1Base64(key, sigBase);

  // IMPORTANT: signature must be the LAST parameter (matches the proven
  // requests-style header layout — otherwise X rejects with 400 code 215).
  const ks = Object.keys(params).sort();
  return (
    "OAuth " +
    ks.map((k) => `${k}="${pct(oauth[k])}"`).join(", ") +
    `, oauth_signature="${pct(signature)}"`
  );
}

// --- ads-api v12 -------------------------------------------------------------

/** Auto-discover the X Ads account ID for a set of OAuth1 credentials. */
export async function discoverAdsAccountId(
  creds: OAuth1Creds
): Promise<string | null> {
  try {
    const d = await adsFetch(creds, "GET", "/accounts", { count: "1" });
    const first = Array.isArray(d?.data) ? d.data[0] : d?.data;
    if (first?.id) return String(first.id);
  } catch {
    /* no ads account or insufficient perms */
  }
  return null;
}

async function adsFetch(
  creds: OAuth1Creds,
  method: "GET" | "POST",
  path: string,
  query: Record<string, string> = {},
  payload?: unknown
): Promise<any> {
  const baseUrl = API_BASE + path;
  const qs = Object.keys(query)
    .map((k) => `${pct(k)}=${pct(query[k])}`)
    .join("&");
  const url = qs ? `${baseUrl}?${qs}` : baseUrl;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: await oauthHeader(creds, method, baseUrl, query),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let d: any = null;
  try {
    d = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (res.status >= 400) {
    throw new Error(`ads ${path} ${res.status}: ${text.slice(0, 220)}`);
  }
  return d;
}

/** List an ads account's media library (paginated). */
export async function adsFetchAllMedia(
  creds: OAuth1Creds,
  adsAccountId: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const query: Record<string, string> = {};
    if (cursor) query.cursor = cursor;
    else query.limit = "100";
    const d = await adsFetch(creds, "GET", `/accounts/${adsAccountId}/media_library`, query);
    const rows = d?.data;
    if (Array.isArray(rows)) out.push(...rows);
    cursor = d?.next_cursor || null;
    if (!cursor || !Array.isArray(rows) || rows.length === 0) break;
  }
  return out;
}

/** Create a VIDEO_WEBSITE card. Returns card_uri. */
export async function adsCreateCard(
  creds: OAuth1Creds,
  adsAccountId: string,
  mediaId: string,
  url: string,
  title: string,
  attempt = 1
): Promise<string> {
  const d = await adsFetch(creds, "POST", `/accounts/${adsAccountId}/cards`, {}, {
    card_type: "VIDEO_WEBSITE",
    name: `card_${mediaId}_${attempt}`,
    components: [
      { media_key: `13_${mediaId}`, type: "MEDIA" },
      { title, destination: { url, type: "WEBSITE" }, type: "DETAILS" },
    ],
  });
  const data = d?.data;
  const cardUri = Array.isArray(data) ? data?.[0]?.card_uri : data?.card_uri;
  if (!cardUri) {
    throw new Error(`card response missing card_uri: ${JSON.stringify(d).slice(0, 300)}`);
  }
  return String(cardUri);
}

/**
 * Card factory for accounts WITHOUT their own OAuth1/ads id: upload the
 * video into the ads library with any full-perms OAuth1 (the agency "gold"
 * token), then build the VIDEO_WEBSITE card around it. The resulting
 * card_uri attaches fine to a tweet posted by a DIFFERENT account's session
 * (cross-account attach live-verified 2026-10: card renders with CTA).
 * Returns card_uri + the uploaded ads-library media id so callers can cache
 * both (repeat posts of the same video+link are then instant).
 */
export async function createCardFromUrl(
  creds: OAuth1Creds,
  adsAccountId: string,
  videoUrl: string,
  url: string,
  title: string,
  preUploadedMediaId?: string
): Promise<{ cardUri: string; mediaId: string }> {
  const mediaId = preUploadedMediaId ?? (await uploadMediaOAuth1(creds, videoUrl));
  const cardUri = await adsCreateCard(creds, adsAccountId, mediaId, url, title);
  return { cardUri, mediaId };
}

// --- web GraphQL CreateTweet (session cookies + guest bearer) -----------------

export type SessionCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

export function loadCookies(sessionJson: unknown): SessionCookie[] {
  let raw = sessionJson ?? [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  const asArr = (a: any[]): SessionCookie[] =>
    a.map((c) => ({
      name: String(c?.name ?? ""),
      value: String(c?.value ?? ""),
      domain: String(c?.domain ?? ".x.com"),
      path: String(c?.path ?? "/"),
    }));
  if (Array.isArray(raw)) return asArr(raw);
  if (typeof raw === "object" && raw) {
    const nested = (raw as Record<string, unknown>).cookies;
    if (Array.isArray(nested)) return asArr(nested);
    // {auth_token:"...", ct0:"..."} — the X Grabber cookie map
    const map = (nested && typeof nested === "object" ? nested : raw) as Record<string, unknown>;
    return Object.entries(map)
      .filter(([k, v]) => k && typeof v === "string" && v)
      .map(([name, value]) => ({ name, value: String(value), domain: ".x.com", path: "/" }));
  }
  return [];
}

export function cookieHeader(sessionJson: unknown): string {
  return loadCookies(sessionJson)
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export function csrfFromSession(sessionJson: unknown): string {
  return loadCookies(sessionJson).find((c) => c.name === "ct0")?.value ?? "";
}

export function mediaIdFromKey(key: string): string {
  const m = String(key).match(/^(?:\d+|gm)_(\d+)/); // gm_ = cookie-synced media tab items
  return m ? m[1] : String(key);
}

/** Quick liveness check of a browser session (used before instant posting).
 *  Uses the GraphQL Viewer endpoint (verify_credentials.json was retired by X).
 *  Returns ok + the REAL username/id the session belongs to when possible,
 *  so the panel can verify an account's own identity instead of trusting labels. */
export async function probeSession(
  sessionJson: unknown
): Promise<{ ok: boolean; username?: string; id?: string; reason?: string }> {
  const csrf = csrfFromSession(sessionJson);
  const cookie = cookieHeader(sessionJson);
  if (!csrf || !cookie) return { ok: false, reason: "missing ct0/cookies" };
  try {
    const qid0 = await queryId("Viewer", cookie);
    const vars = encodeURIComponent(
      JSON.stringify({
        withCommunitiesMemberships: true,
        withSuperFollowsUserFields: true,
        withUserResults: true,
        withVoice: true,
      })
    );
    const feats = encodeURIComponent(JSON.stringify(FEATURES));
    const probe = async (qid: string) =>
      fetch(`https://x.com/i/api/graphql/${qid}/Viewer?variables=${vars}&features=${feats}`, {
        headers: {
          authorization: `Bearer ${GUEST_BEARER}`,
          "x-csrf-token": csrf,
          cookie,
          "user-agent": WEB_UA,
          "x-twitter-active-user": "yes",
          origin: "https://x.com",
          referer: "https://x.com/home",
        },
      });
    // The bundle scan can latch onto a DIFFERENT "Viewer" operation variant
    // (X ships several) whose required features differ → non-200. If the
    // extracted qid fails, retry with the live-verified fallback before
    // declaring the session dead (a false "expired" breaks posting).
    let r = await probe(qid0);
    if (r.status !== 200) {
      r = await probe(QID_FALLBACKS.Viewer);
    }
    if (r.status !== 200) return { ok: false, reason: `http ${r.status}` };
    const j = await r.json();
    const res = j?.data?.viewer?.user_results?.result;
    const username = res?.core?.screen_name;
    if (!username) return { ok: false, reason: "session not logged in" };
    return { ok: true, username, id: res?.rest_id ? String(res.rest_id) : undefined };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// --- cookie-based media-library sync (no OAuth1 needed) ---------------------

export type UserMediaItem = {
  key: string; // gm_<mediaEntityId> — dedup-safe
  url: string;
  type: "VIDEO" | "IMAGE";
  name: string;
  createdAt?: number;
};

function cleanMediaName(text: unknown, id: string, type: "VIDEO" | "IMAGE"): string {
  const t = String(text ?? "")
    .replace(/https:\/\/t\.co\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t) return t.length > 60 ? t.slice(0, 57) + "..." : t;
  return type === "VIDEO" ? `video_${id}.mp4` : `photo_${id}.jpg`;
}

/** Sync the logged-in user's own X media tab (videos + photos) using ONLY the
 *  session cookies — works for cookie-only accounts (no OAuth1/ads account).
 *  Uses the GraphQL UserMedia endpoint with dynamically-extracted queryId.
 *  LIVE-VERIFIED 2026-10 (returned 31 items for a cookie-only account). */
export async function fetchUserMediaCookies(
  sessionJson: unknown
): Promise<{ items: UserMediaItem[]; username?: string; error?: string }> {
  const probe = await probeSession(sessionJson);
  if (!probe.ok || !probe.id) {
    return { items: [], error: probe.reason ?? "session not logged in" };
  }
  const csrf = csrfFromSession(sessionJson);
  const cookie = cookieHeader(sessionJson);
  try {
    const qid = await queryId("UserMedia", cookie);
    if (!qid) return { items: [], error: "no UserMedia queryId" };
    const vars: Record<string, unknown> = {
      userId: probe.id,
      count: 100,
      includePromotedContent: false,
      withClientEventId: true,
      withSuperFollowsUserFields: true,
      withSuperFollowsTweetFields: true,
    };
    const items: UserMediaItem[] = [];
    const seenMedia = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 30; page++) {
      if (cursor) vars.cursor = cursor;
      const url = `https://x.com/i/api/graphql/${qid}/UserMedia?variables=${encodeURIComponent(
        JSON.stringify(vars)
      )}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
      const r = await fetch(url, {
        headers: {
          authorization: `Bearer ${GUEST_BEARER}`,
          "x-csrf-token": csrf,
          cookie,
          "user-agent": WEB_UA,
          "x-twitter-active-user": "yes",
          origin: "https://x.com",
          referer: "https://x.com/media",
        },
      });
      if (r.status !== 200) {
        return { items, username: probe.username, error: `UserMedia http ${r.status}` };
      }
      const j = await r.json();
      const tl = j?.data?.user?.result?.timeline?.timeline ?? j?.data?.user?.media?.timeline ?? null;
      const inst = tl?.instructions ?? [];
      const pageMediaCountBefore = items.length;
      for (const ins of inst) {
        const entries = ins.entries ?? ins.entry?.content?.items ?? [];
        for (const e of entries) {
          const itemsArr = e?.content?.items ?? [e];
          for (const it of itemsArr) {
            const res =
              it?.item?.itemContent?.tweet_results?.result ??
              it?.content?.itemContent?.tweet_results?.result ??
              it?.itemContent?.tweet_results?.result;
            if (!res || res.__typename === "TweetTombstone") continue;
            const legacy = res.legacy ?? res.tweet?.legacy;
            const mediaArr = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
            for (const md of mediaArr) {
              const key = `gm_${md.id_str}`;
              if (seenMedia.has(key)) continue;
              if (md.type === "video" || md.type === "animated_gif") {
                const variants: { bitrate?: number; content_type: string; url: string }[] = (md.video_info?.variants ?? []).filter(
                  (v: { bitrate?: number; content_type: string; url: string }) => v.content_type === "video/mp4"
                );
                variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
                const best = variants[0];
                if (best) {
                  seenMedia.add(key);
                  items.push({
                    key,
                    url: best.url,
                    type: "VIDEO",
                    name: cleanMediaName(legacy?.full_text, md.id_str, "VIDEO"),
                    createdAt: Date.parse(legacy?.created_at ?? "") || undefined,
                  });
                }
              } else if (md.type === "photo") {
                seenMedia.add(key);
                items.push({
                  key,
                  url: md.media_url_https,
                  type: "IMAGE",
                  name: cleanMediaName(legacy?.full_text, md.id_str, "IMAGE"),
                  createdAt: Date.parse(legacy?.created_at ?? "") || undefined,
                });
              }
            }
          }
        }
      }
      const bottom = [...inst].reverse().flatMap((instruction: any) => instruction.entries ?? [])
        .find((entry: any) => String(entry?.entryId ?? "").startsWith("cursor-bottom-") || entry?.content?.cursorType === "Bottom");
      const next = bottom?.content?.value;
      if (!items.length || items.length === pageMediaCountBefore || typeof next !== "string" || !next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return { items, username: probe.username };
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

/**
 * Post a tweet via X web GraphQL with media_entities (videos already in the
 * poster's own X media library, by media_id). THIS posts as whatever account
 * the session cookies belong to — the honest per-account identity path.
 * Optional `cardUri` attaches a VIDEO_WEBSITE card (URL stays OUT of the text).
 */
export async function postTweetGraphQL(
  sessionJson: unknown,
  opts: { text: string; mediaIds?: string[]; cardUri?: string }
): Promise<string> {
  const csrf = csrfFromSession(sessionJson);
  if (!csrf) throw new Error("CreateTweet: session missing ct0 cookie");
  const cookie = cookieHeader(sessionJson);
  const entities = (opts.mediaIds ?? []).map((id) => ({ media_id: String(id) }));
  const qid = await queryId("CreateTweet", cookie);
  const body = {
    variables: {
      tweet_text: opts.text,
      media: { media_entities: entities, possibly_sensitive: false },
      ...(opts.cardUri ? { card_uri: opts.cardUri } : {}),
      semantic_annotation_ids: [],
    },
    features: FEATURES,
    queryId: qid,
  };
  const headers = {
    authorization: `Bearer ${GUEST_BEARER}`,
    "x-csrf-token": csrf,
    "x-twitter-auth-type": "OAuth2Session",
    "content-type": "application/json",
    cookie,
    "user-agent": WEB_UA,
    origin: "https://x.com",
    referer: "https://x.com/home",
  };
  const res = await fetch(
    `https://x.com/i/api/graphql/${qid}/CreateTweet`,
    { method: "POST", headers, body: JSON.stringify(body) }
  );
  const text = await res.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* not json */
  }
  const tweetId =
    j?.data?.create_tweet?.tweet_results?.result?.rest_id ??
    j?.data?.createTweet?.tweet_results?.result?.rest_id;
  if (j?.errors?.length && !tweetId) {
    throw new Error(`CreateTweet: ${JSON.stringify(j.errors).slice(0, 320)}`);
  }
  if (!tweetId) {
    throw new Error(`CreateTweet no tweet_id (http ${res.status}): ${text.slice(0, 320)}`);
  }
  return String(tweetId);
}

const FEATURES = {
  // Matches the live X web client (2026-10 verified working for CreateTweet+Viewer)
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

/** Post a tweet with card_uri ONLY (media lives inside the card). Returns tweet id. */
export async function postTweetWithCard(
  sessionJson: unknown,
  cardUri: string,
  caption: string
): Promise<string> {
  const csrf = csrfFromSession(sessionJson);
  if (!csrf) throw new Error("CreateTweet: session missing ct0 cookie");
  const cookie = cookieHeader(sessionJson);
  const qid = await queryId("CreateTweet", cookie);
  const body = {
    variables: {
      tweet_text: caption,
      media: { media_entities: [], possibly_sensitive: false },
      card_uri: cardUri,
      semantic_annotation_ids: [],
    },
    features: FEATURES,
    queryId: qid,
  };
  const headers = {
    authorization: `Bearer ${GUEST_BEARER}`,
    "x-csrf-token": csrf,
    "x-twitter-auth-type": "OAuth2Session",
    "content-type": "application/json",
    cookie,
    "user-agent": WEB_UA,
    origin: "https://x.com",
    referer: "https://x.com/home",
  };
  const res = await fetch(
    `https://x.com/i/api/graphql/${qid}/CreateTweet`,
    { method: "POST", headers, body: JSON.stringify(body) }
  );
  const text = await res.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* not json */
  }
  const tweetId =
    j?.data?.create_tweet?.tweet_results?.result?.rest_id ??
    j?.data?.createTweet?.tweet_results?.result?.rest_id;
  if (j?.errors?.length && !tweetId) {
    throw new Error(`CreateTweet: ${JSON.stringify(j.errors).slice(0, 320)}`);
  }
  if (!tweetId) {
    throw new Error(`CreateTweet no tweet_id (http ${res.status}): ${text.slice(0, 320)}`);
  }
  return String(tweetId);
}

// ---------------------------------------------------------------------------
// v2 Twitter API posting (OAuth1-only — NO cookies). The user-level OAuth1
// token never expires, so this is the cookie-free posting path. X does not
// accept card_uri on v2, so we put the link IN THE TEXT and attach the
// library media via media_ids — X auto-generates the link preview card.
// ---------------------------------------------------------------------------

const API_V2 = "https://api.twitter.com/2";

async function v2Fetch(
  creds: OAuth1Creds,
  method: "GET" | "POST",
  path: string,
  query: Record<string, string> = {},
  payload?: unknown
): Promise<any> {
  const url = `${API_V2}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: await oauthHeader(creds, method, url, query),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let d: any = null;
  try {
    d = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (res.status >= 400) {
    throw new Error(`v2 ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return d;
}

/**
 * Post a tweet via the v2 API with OAuth1 only (cookie-free).
 * - mediaIds: library media ids (numeric part of "13_..." keys)
 * - url: goes INTO the tweet text so X renders the link preview under the video
 * Returns the tweet id.
 */
export async function postTweetV2(
  creds: OAuth1Creds,
  opts: { text: string; mediaIds?: string[] }
): Promise<string> {
  const body: Record<string, unknown> = { text: opts.text };
  if (opts.mediaIds?.length) {
    body.media = { media_ids: opts.mediaIds };
  }
  const d = await v2Fetch(creds, "POST", "/tweets", {}, body);
  const id = d?.data?.id;
  if (!id) throw new Error(`v2 tweet missing id: ${JSON.stringify(d).slice(0, 300)}`);
  return String(id);
}

/** Verify an OAuth1 token: returns the authenticated account (screen_name, id). */
export async function verifyOAuth1(creds: OAuth1Creds): Promise<{
  id: string;
  screen_name: string;
  name: string;
} | null> {
  try {
    const d = await v2Fetch(creds, "GET", "/users/me");
    const u = d?.data;
    return u ? { id: String(u.id), screen_name: String(u.username), name: String(u.name ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * Post a tweet with a card_uri via GraphQL using OAuth1 signing (no session cookies needed).
 * The v2 API does not support card_uri, so we must use GraphQL CreateTweet.
 */
export async function postTweetGraphQLOAuth1(
  creds: OAuth1Creds,
  opts: { text: string; cardUri?: string; mediaIds?: string[] }
): Promise<string> {
  // GraphQL endpoint URL
  const gqlUrl = "https://x.com/i/api/graphql/Tweetthread/postTweet";
  // Use a known CreateTweet queryId
  const qid = "bLqoahsSN5yccsxsQT2Mqg"; // CreateTweet
  const endpoint = `https://x.com/i/api/graphql/${qid}/CreateTweet`;

  const variables: Record<string, unknown> = {
    tweet_text: opts.text,
    media: {
      media_entities: (opts.mediaIds ?? []).map((id) => ({ media_id: id, tagged_users: [] })),
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };
  if (opts.cardUri) {
    variables.card_uri = opts.cardUri;
  }

  const body = JSON.stringify({
    variables,
    features: FEATURES,
    queryId: qid,
  });

  const auth = await oauthHeader(creds, "POST", endpoint, {});
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      Authorization: auth,
      "x-twitter-auth-type": "OAuth1Session",
      "x-twitter-client-language": "en",
    },
    body,
  });
  const text = await res.text();
  let d: any = null;
  try { d = JSON.parse(text); } catch { /* not json */ }
  const id = d?.data?.create_tweet?.tweet_results?.result?.rest_id;
  if (!id) throw new Error(`GraphQL OAuth1 tweet failed: ${text.slice(0, 300)}`);
  return String(id);
}

// --- retry classification -----------------------------------------------------

const RETRY_MARKERS = [
  "card is not ready", "not ready", "hasn't indexed", "hasn’t indexed",
  "card", "retry", "rate limit", "temporar", "slow down", "try again",
  "too many", "over capacity", "unavailable", "timed out", "timeout",
  "fetch failed", "network", "socket", "503", "502", "504", "429",
  "internal server", "bad gateway", "service unavailable", "failed to fetch",
];

export function isRetryablePostError(msg: string): boolean {
  const m = String(msg ?? "").toLowerCase();
  return RETRY_MARKERS.some((k) => m.includes(k));
}

// --- v1.1 media upload via OAuth1 (NO cookies needed) -----------------------
// Full-perms OAuth1 tokens can upload media and post v2 tweets without any
// browser session. Used as the fallback when the account's cookies are dead.

const UPLOAD_BASE = "https://upload.twitter.com/1.1/media/upload.json";

export async function uploadMediaOAuth1(
  creds: OAuth1Creds,
  mediaUrl: string
): Promise<string> {
  // Private Vercel Blob URLs 403 on a plain fetch — readMediaBytes signs them.
  const buf = await readMediaBytes(mediaUrl);
  if (buf.length === 0) throw new Error("media download is empty");
  const isVideo = mediaUrl.includes("video.twimg") || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(mediaUrl);
  const mediaType = isVideo ? "video/mp4" : "image/jpeg";
  const category = isVideo ? "amplify_video" : "tweet_image";

  // INIT
  const initQ: Record<string, string> = {
    command: "INIT",
    media_type: mediaType,
    total_bytes: String(buf.length),
    media_category: category,
  };
  const initH = await oauthHeader(creds, "POST", UPLOAD_BASE, initQ);
  const initRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(initQ)}`, {
    method: "POST",
    headers: { authorization: initH },
  });
  const initJson = await initRes.json().catch(() => ({}));
  const mediaId = String(initJson?.media_id_string ?? initJson?.media_id ?? "");
  if (!mediaId) throw new Error(`INIT failed: ${JSON.stringify(initJson).slice(0, 200)}`);

  // APPEND (binary body, oauth params signed as query)
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, idx = 0; i < buf.length; i += CHUNK, idx++) {
    const part = buf.subarray(i, Math.min(i + CHUNK, buf.length));
    const q: Record<string, string> = {
      command: "APPEND",
      media_id: mediaId,
      segment_index: String(idx),
    };
    const h = await oauthHeader(creds, "POST", UPLOAD_BASE, q);
    const B = "XbOuNdArYx9q";
    const head = Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="media"; filename="chunk${idx}.${isVideo ? "mp4" : "jpg"}"\r\nContent-Type: ${isVideo ? "video/mp4" : "image/jpeg"}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${B}--\r\n`);
    const body = Buffer.concat([head, part, tail]);
    const aRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(q)}`, {
      method: "POST",
      headers: {
        authorization: h,
        "content-type": `multipart/form-data; boundary=${B}`,
        "content-length": String(body.length),
      },
      body: new Uint8Array(body),
    });
    if (!aRes.ok) {
      const t = await aRes.text().catch(() => "");
      throw new Error(`APPEND ${idx} failed: HTTP ${aRes.status} ${t.slice(0, 160)}`);
    }
  }

  // FINALIZE
  const fq: Record<string, string> = { command: "FINALIZE", media_id: mediaId };
  const fh = await oauthHeader(creds, "POST", UPLOAD_BASE, fq);
  const fRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(fq)}`, {
    method: "POST",
    headers: { authorization: fh },
  });
  const fJson = await fRes.json().catch(() => ({}));
  const state = fJson?.processing_info?.state;
  if (state && state !== "succeeded") {
    // wait for processing (videos)
    for (let attempt = 0; attempt < 30; attempt++) {
      const waitMs = Math.max(2000, (fJson?.processing_info?.check_after_secs ?? 4) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      const sq: Record<string, string> = { command: "STATUS", media_id: mediaId };
      const sh = await oauthHeader(creds, "GET", UPLOAD_BASE, sq);
      const sRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(sq)}`, {
        method: "GET",
        headers: { authorization: sh },
      });
      const sJson = await sRes.json().catch(() => ({}));
      const st = sJson?.processing_info?.state;
      if (st === "succeeded") break;
      if (st === "failed") throw new Error(`processing failed: ${JSON.stringify(sJson).slice(0, 200)}`);
      if (sJson?.processing_info) Object.assign(fJson, { processing_info: sJson.processing_info });
    }
  }
  return mediaId;
}
