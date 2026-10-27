// Shared single-account posting logic used by both the instant single-post
// route (/api/posts) and the multi-account fan-out route (/api/posts/bulk).
// Path 1 (preferred): live session (GraphQL) — video + pretty card when the
//   account has OAuth1 + ads id (card attach).
// HARD RULE (user directive): if a link is set on the post, it MUST go out as
//   a card. If card creation fails, the post FAILS — never a degraded tweet
//   with the raw link pasted into the caption. Only linkless posts may go out
//   without a card.
import { db } from "@/lib/db";
import { jobs } from "@/lib/schema";
import { uid } from "@/lib/auth";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { tweetCaption } from "@/lib/media-policy";
import {
  probeSession,
  postTweetGraphQL,
  postTweetWithCard,
  createCardFromUrl,
  mediaIdFromKey,
  uploadMediaOAuth1,
  postTweetV2,
  postTweetGraphQLOAuth1,
  verifyOAuth1,
  type OAuth1Creds,
} from "@/lib/xpost";

export type PostAttempt = {
  accountId: string;
  handle: string;
  status: "done" | "failed" | "queued" | "dry";
  tweetUrl: string | null;
  error: string | null;
  path?: string;
  jobId?: string;
};

type AcctRow = {
  id: string;
  handle: string;
  sessionJson: string;
  oauth1Json: string;
  adsAccountId: string;
  defaultUrl: string;
  defaultTitle: string;
  defaultCaption: string | null;
};

type MediaRow = {
  id: string;
  mediaKey: string | null;
  url: string;
  name: string;
  accountId: string | null;
};

// --- card cache + agency card factory ----------------------------------------
// The first post of a given video+link pays the ads-library upload + card
// creation (~10-30s); every repeat is instant from the DB cache.

async function lookupCard(mediaKey: string, link: string): Promise<string | null> {
  try {
    const r = await db.execute(
      sql`select card_uri from cards where media_key = ${mediaKey} and link = ${link} order by created_at desc limit 1`
    );
    const row = (r as { rows?: Array<{ card_uri?: unknown }> }).rows?.[0];
    return row?.card_uri ? String(row.card_uri) : null;
  } catch {
    return null;
  }
}

async function saveCard(mediaKey: string, link: string, cardUri: string): Promise<void> {
  try {
    await db.execute(
      sql`insert into cards (id, media_key, link, card_uri, created_at) values (${randomUUID()}, ${mediaKey}, ${link}, ${cardUri}, ${Date.now()}) on conflict (media_key, link) do nothing`
    );
  } catch {
    /* cache is best-effort */
  }
}

async function lookupAdsMedia(mediaKey: string, adsAccountId: string): Promise<string | null> {
  try {
    const r = await db.execute(
      sql`select ads_media_id from ads_media where media_key = ${mediaKey} and ads_account_id = ${adsAccountId} limit 1`
    );
    const row = (r as { rows?: Array<{ ads_media_id?: unknown }> }).rows?.[0];
    return row?.ads_media_id ? String(row.ads_media_id) : null;
  } catch {
    return null;
  }
}

async function saveAdsMedia(mediaKey: string, adsAccountId: string, adsMediaId: string): Promise<void> {
  try {
    await db.execute(
      sql`insert into ads_media (id, media_key, ads_account_id, ads_media_id, created_at) values (${randomUUID()}, ${mediaKey}, ${adsAccountId}, ${adsMediaId}, ${Date.now()}) on conflict (media_key, ads_account_id) do nothing`
    );
  } catch {
    /* cache is best-effort */
  }
}

/** Approved accounts with OAuth1 + ads id, oldest first — the card factory pool. */
async function goldCardCandidates(): Promise<Array<{ creds: OAuth1Creds; adsAccountId: string }>> {
  const out: Array<{ creds: OAuth1Creds; adsAccountId: string }> = [];
  try {
    const r = await db.execute(
      sql`select oauth1_json, ads_account_id from accounts
          where oauth1_json is not null and oauth1_json != ''
            and ads_account_id is not null and ads_account_id != ''
            and status = 'approved'
          order by created_at asc limit 5`
    );
    for (const row of (r as { rows?: Array<Record<string, unknown>> }).rows ?? []) {
      try {
        const raw = row.oauth1_json;
        const p = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (p?.consumer_key && p?.access_token && row.ads_account_id) {
          out.push({
            creds: {
              consumer_key: String(p.consumer_key),
              consumer_secret: String(p.consumer_secret ?? ""),
              access_token: String(p.access_token),
              access_token_secret: String(p.access_token_secret ?? ""),
            },
            adsAccountId: String(row.ads_account_id),
          });
        }
      } catch {
        /* try next row */
      }
    }
  } catch {
    /* none */
  }
  return out;
}

/**
 * The single best "gold" credential for the shared Ads card factory.
 *
 * Prefers the env-pinned app (GOLD_OAUTH1_JSON / GOLD_ADS_ACCOUNT_ID) because
 * it is DURABLE: re-grabbing an account's credentials through the browser
 * extension with an app that lacks Ads API access would otherwise silently
 * break card creation again (403 UNAUTHORIZED_CLIENT_APPLICATION).
 * Falls back to the DB pool of approved accounts that carry an ads id.
 */
export async function goldCardFactory(): Promise<{ creds: OAuth1Creds; adsAccountId: string } | null> {
  try {
    const raw = process.env.GOLD_OAUTH1_JSON;
    const adsId = process.env.GOLD_ADS_ACCOUNT_ID;
    if (raw && adsId) {
      const p = JSON.parse(raw);
      if (p?.consumer_key && p?.access_token) {
        return {
          creds: {
            consumer_key: String(p.consumer_key),
            consumer_secret: String(p.consumer_secret ?? ""),
            access_token: String(p.access_token),
            access_token_secret: String(p.access_token_secret ?? ""),
          },
          adsAccountId: String(adsId),
        };
      }
    }
  } catch {
    /* fall through to the DB pool */
  }
  const pool = await goldCardCandidates();
  return pool[0] ?? null;
}

/**
 * Build (or fetch the cached) VIDEO_WEBSITE card_uri for a video + link.
 *
 * ALWAYS uses the Ads-enabled gold token (env-pinned first, DB pool after) —
 * never the target account's own OAuth1, because those creds typically belong
 * to an app WITHOUT Ads API access and fail with UNAUTHORIZED_CLIENT_APPLICATION.
 *
 * Ads-library upload + card creation is slow and occasionally flaky, so this
 * retries each candidate a few times. Returns null only when every path fails;
 * callers MUST treat null as a hard failure for link posts (never degrade to a
 * raw URL in the caption).
 */
const cardInflight = new Map<string, Promise<string | null>>();

/** Concurrent callers for the SAME video+link share ONE card build instead of
 *  uploading the video into the ads library several times in parallel. */
export async function ensureCard(
  mediaKey: string | null,
  videoUrl: string,
  url: string,
  title: string,
  mediaRef?: string | null
): Promise<string | null> {
  const key = `${mediaKey || (mediaRef ? `media:${mediaRef}` : `url:${url}`)}|${url}`;
  const running = cardInflight.get(key);
  if (running) return running;
  const job = ensureCardUncached(mediaKey, videoUrl, url, title, mediaRef);
  cardInflight.set(key, job);
  try {
    return await job;
  } finally {
    cardInflight.delete(key);
  }
}

async function ensureCardUncached(
  mediaKey: string | null,
  videoUrl: string,
  url: string,
  title: string,
  mediaRef?: string | null
): Promise<string | null> {
  // Cache identity MUST be tied to the actual VIDEO — never to the link alone.
  // Fresh panel uploads arrive with mediaKey=null, and keying those by URL made
  // every post that reused the same product link serve the FIRST video's cached
  // card forever (users saw an old/never-selected video on the timeline).
  // mediaRef is the stable media row id, so each distinct video gets its own
  // card while repeat posts of the *same* video still hit the cache.
  const cacheKey = String(
    mediaKey || (mediaRef ? `media:${mediaRef}` : `url:${url}`)
  );
  const cached = await lookupCard(cacheKey, url);
  if (cached) return cached;

  const candidates: Array<{ creds: OAuth1Creds; adsAccountId: string }> = [];
  const envGold = await goldCardFactory();
  if (envGold) candidates.push(envGold);
  for (const c of await goldCardCandidates()) {
    if (!envGold || c.creds.consumer_key !== envGold.creds.consumer_key) candidates.push(c);
  }

  for (const c of candidates) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const pre = await lookupAdsMedia(cacheKey, c.adsAccountId);
        const made = await createCardFromUrl(c.creds, c.adsAccountId, videoUrl, url, title, pre ?? undefined);
        await saveCard(cacheKey, url, made.cardUri);
        if (!pre) await saveAdsMedia(cacheKey, c.adsAccountId, made.mediaId);
        return made.cardUri;
      } catch {
        if (attempt < 3) await new Promise((r) => setTimeout(r, 900 * attempt));
      }
    }
  }
  return null;
}

/**
 * Post a LINK as a real VIDEO_WEBSITE card ("From <domain>" under the video).
 *
 * The video lives INSIDE the card, so this needs NO media key at all — it
 * works for a freshly uploaded video and for an account that has no OAuth1 of
 * its own. The card-library upload + card creation run on the shared gold
 * (Ads-enabled) token; the resulting card_uri attaches to the target account's
 * own tweet via its session cookies (cross-account attach, live-verified).
 *
 * Returns null on any failure so the caller can fall back gracefully.
 */
async function tryGoldCardPost(
  acct: AcctRow,
  m: MediaRow,
  captionTxt: string,
  urlTxt: string,
  titleTxt: string,
  userId: string,
  handleLower: string,
  dry = false
): Promise<PostAttempt | null> {
  if (!urlTxt) return null;

  const gold = await goldCardFactory();
  if (!gold) return null;

  // The tweet itself is sent from the ACCOUNT's own live session.
  const p = acct.sessionJson ? await probeSession(acct.sessionJson).catch(() => null) : null;
  if (!p?.ok || !p.username) return null;
  if (String(p.username).toLowerCase().replace(/^@/, "") !== handleLower) return null;

  const cardUri = await ensureCard(m.mediaKey, m.url, urlTxt, titleTxt || "Learn more", m.id);
  if (!cardUri) return null;

  // DRY RUN: do everything (session probe + card build) but never publish.
  // Lets the panel verify the whole path end-to-end without touching the feed.
  if (dry) {
    return {
      accountId: acct.id, handle: acct.handle,
      status: "dry", tweetUrl: null, error: null, path: "gold-card(dry)",
    };
  }

  try {
    const tweetId = await postTweetWithCard(acct.sessionJson, cardUri, captionTxt);
    const now = Date.now();
    const jobId = uid();
    const tweetUrl = `https://x.com/${String(p.username)}/status/${tweetId}`;
    await db.insert(jobs).values({
      id: jobId, userId, accountId: acct.id, mediaId: m.id,
      caption: captionTxt, url: urlTxt, title: titleTxt,
      status: "done" as const, tweetUrl, error: null,
      claimedBy: null, createdAt: now, updatedAt: now,
    });
    return {
      accountId: acct.id, handle: acct.handle,
      status: "done", tweetUrl, error: null, jobId, path: "gold-card",
    };
  } catch {
    return null;
  }
}

export async function attemptPost(
  acct: AcctRow,
  m: MediaRow,
  captionTxt: string,
  urlTxt: string,
  titleTxt: string,
  userId: string,
  dry = false
): Promise<PostAttempt> {
  const base = { accountId: acct.id, handle: acct.handle };
  const sourceMediaKey = m.mediaKey;
  const handleLower = String(acct.handle).toLowerCase().replace(/^@/, "");

  // Normalize the link: card creation requires a fully-qualified URL.
  // "souszhi.com/2123888" or "  souszhi.com " would otherwise fail silently
  // downstream and produce a degraded link-in-text tweet.
  urlTxt = urlTxt.trim().replace(/[.,;]+$/, "");
  if (urlTxt && !/^https?:\/\//i.test(urlTxt)) {
    urlTxt = `https://${urlTxt.replace(/^\/+/, "")}`;
  }

  // HARD RULE: no link → no post. A missing Website URL used to publish a bare
  // video tweet with no card and no link at all (job url=""), which looked
  // exactly like "the post got dropped with no link in it". Fail loudly instead.
  if (!urlTxt) {
    return {
      ...base,
      status: "failed",
      tweetUrl: null,
      error: "Website URL missing — refusing to post without a link. Paste the link in the Website URL field and post again.",
    };
  }

  // Optional OAuth1 (parsed BEFORE everything — the instant-upload path needs it)
  let creds: OAuth1Creds | null = null;
  try {
    const parsed = JSON.parse(acct.oauth1Json);
    if (parsed?.consumer_key && parsed?.access_token) {
      creds = {
        consumer_key: String(parsed.consumer_key),
        consumer_secret: String(parsed.consumer_secret ?? ""),
        access_token: String(parsed.access_token),
        access_token_secret: String(parsed.access_token_secret ?? ""),
      };
    }
  } catch {
    /* no oauth1 */
  }

  // ── Link posts go out as a real VIDEO_WEBSITE card ──────────────────────
  // The video rides INSIDE the card, so this needs NO media key and works for
  // a freshly uploaded video on an account with no OAuth1 of its own. Tried
  // FIRST so a link post never degrades to a raw URL in the caption and never
  // depends on the (Playwright) background worker being alive.
  if (urlTxt) {
    const goldTry = await tryGoldCardPost(acct, m, captionTxt, urlTxt, titleTxt, userId, handleLower, dry);
    if (goldTry) return goldTry;
  }

  // Resolve only the target account's media key. A synchronized key is
  // account-scoped and cannot be reused from a different X account.
  m.mediaKey = m.accountId === acct.id ? sourceMediaKey : null;
  try {
    const r = await db.execute(
      sql`select media_key from account_media where media_id = ${m.id} and account_id = ${acct.id} limit 1`
    );
    const row = (r as { rows?: Array<{ media_key?: unknown }> }).rows?.[0];
    if (row?.media_key) m.mediaKey = String(row.media_key);
  } catch {

  }
  let resolvedMediaKey = m.mediaKey;
  m.mediaKey = sourceMediaKey;

  // Still no key → INSTANT path: upload straight into THIS account's X media
  // library (worker may not have pre-warmed yet). Only queue as a last resort.
  if (!resolvedMediaKey && creds) {
    try {
      const upId = await uploadMediaOAuth1(creds, m.url);
      if (upId) {
        m.mediaKey = `13_${upId}`;
        resolvedMediaKey = m.mediaKey;
        try {
          await db.execute(
            sql`insert into account_media (id, media_id, account_id, media_key, created_at)
                values (${randomUUID()}, ${m.id}, ${acct.id}, ${m.mediaKey}, ${Date.now()})
                on conflict (account_id, media_id) do update set media_key = ${m.mediaKey}`
          );
        } catch { /* best-effort cache */ }
      }
    } catch {
      /* fall through to worker queue */
    }
  }

  // FINAL fallback: queue for the background worker (worker-upload path).
  if (!resolvedMediaKey) {
    if (dry) {
      return { ...base, status: "dry", tweetUrl: null, error: null, path: "worker-upload(dry)" };
    }
    const now = Date.now();
    const jobId = uid();
    const jobRow = {
      id: jobId,
      userId,
      accountId: acct.id,
      mediaId: m.id,
      caption: captionTxt,
      url: urlTxt,
      title: titleTxt,
      status: "queued" as const,
      tweetUrl: null,
      error: null,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(jobs).values(jobRow);
    return { ...base, status: "queued", tweetUrl: null, error: null, jobId, path: "worker-upload" };
  }

  m.mediaKey = resolvedMediaKey;
  const mediaIdNum = mediaIdFromKey(String(m.mediaKey));

  const p = acct.sessionJson
    ? await probeSession(acct.sessionJson).catch(() => null)
    : null;
  if (!p || !p.ok || !p.username) {
      // cookies dead — but a FULL-PERMS OAuth1 token posts fine without cookies
      if (creds) {
        const who = await verifyOAuth1(creds).catch(() => null);
        if (who && who.screen_name.toLowerCase() === handleLower) {
          try {
            // Try to create a website card via OAuth1 even without a live session.
            // Auto-discover ads account ID if missing.
            let cardUri: string | null = null;
            if (urlTxt) {
              cardUri = await ensureCard(m.mediaKey, m.url, urlTxt, titleTxt || "Learn more", m.id);
              if (!cardUri) {
                return {
                  ...base,
                  status: "failed",
                  tweetUrl: null,
                  error: `Card could not be created for ${urlTxt} — refusing to post the raw link. Retry in a minute.`,
                };
              }
            }
            // Use the ALREADY uploaded media — no re-upload needed.
            // Card posts carry the video + CTA; media ids are NOT re-attached
            // (the card already holds the video) to avoid a duplicate attach.
            if (dry) {
              return { ...base, status: "dry", tweetUrl: null, error: null, path: "oauth1-v2(dry)" };
            }
            const tweetId = cardUri
              ? await postTweetGraphQLOAuth1(creds, { text: captionTxt, cardUri })
              : await postTweetV2(creds, { text: captionTxt, mediaIds: [mediaIdNum] });
            const now = Date.now();
            const jobId = uid();
            const tweetUrl = `https://x.com/${who.screen_name}/status/${tweetId}`;
            await db.insert(jobs).values({
              id: jobId, userId, accountId: acct.id, mediaId: m.id,
              caption: captionTxt, url: urlTxt, title: titleTxt,
              status: "done" as const, tweetUrl, error: null,
              claimedBy: null, createdAt: now, updatedAt: now,
            });
            return { ...base, status: "done", tweetUrl, error: null, jobId, path: "oauth1-v2" };
          } catch (e) {
            return {
              ...base,
              status: "failed",
              tweetUrl: null,
              error: `OAuth1-v2 post failed: ${(e as Error).message?.slice(0, 240)}`,
            };
          }
        }
      }
    return {
      ...base,
      status: "failed",
      tweetUrl: null,
      error: `X session expired for @${acct.handle} and no usable OAuth1 on file — refresh cookies: Admin → Accounts → reconnect with a fresh X Grabber blob.`,
    };
  }
  if (p.username.toLowerCase().replace(/^@/, "") !== handleLower) {
    return {
      ...base,
      status: "failed",
      tweetUrl: null,
      error: `REFUSED: stored session belongs to @${p.username}, not @${acct.handle}. Re-connect @${acct.handle}'s OWN cookies.`,
    };
  }
  const liveSession = acct.sessionJson;
  const screen_name = String(p.username);

  // Pretty card attach — EVERY live account with a link gets the card.
  // Own OAuth1 + ads id → direct card from the account's own media.
  // Cookie-only accounts → the agency OAuth1 pool uploads the video into the
  // ads library and cards it (cross-account card_uri — live-verified).
  // Cached per (media key, link): repeat posts skip straight to the tweet.
  let cardUri: string | null = null;
  let lastErr = "";
  if (urlTxt) {
    // One shared, retrying, gold-backed path. Never the account's own OAuth1
    // (that app has no Ads API access -> UNAUTHORIZED_CLIENT_APPLICATION).
    cardUri = await ensureCard(m.mediaKey, m.url, urlTxt, titleTxt || "Learn more", m.id);
  }

  if (urlTxt && !cardUri) {
    // Card creation failed through EVERY path. Per the user's HARD RULE we
    // FAIL the post rather than degrade to a raw link pasted into the caption.
    return {
      ...base,
      status: "failed",
      tweetUrl: null,
      error: `Card could not be created for ${urlTxt} — refusing to post the raw link. ${lastErr}`.trim(),
    };
  }

  if (dry) {
    return {
      ...base,
      status: "dry",
      tweetUrl: null,
      error: null,
      path: cardUri ? "session-card(dry)" : "session(dry)",
    };
  }

  const text = captionTxt;
  let tweetId: string | null = null;
  try {
    tweetId = cardUri
      ? await postTweetWithCard(liveSession, cardUri, captionTxt)
      : await postTweetGraphQL(liveSession, { text, mediaIds: [mediaIdNum] });
  } catch (e) {
    lastErr = lastErr || `GraphQL: ${(e as Error).message ?? String(e)}`;
    // one quick retry (transient GraphQL failures happen)
    try {
      tweetId = cardUri
        ? await postTweetWithCard(liveSession, cardUri, captionTxt)
        : await postTweetGraphQL(liveSession, { text, mediaIds: [mediaIdNum] });
    } catch (e2) {
      lastErr = `GraphQL: ${(e2 as Error).message ?? String(e2)}`;
    }
  }

  const now = Date.now();
  const jobId = uid();
  const finalRow = {
    id: jobId,
    userId,
    accountId: acct.id,
    mediaId: m.id,
    caption: captionTxt,
    url: urlTxt,
    title: titleTxt,
    status: (tweetId ? "done" : "failed") as "done" | "failed",
    tweetUrl: tweetId ? `https://x.com/${screen_name}/status/${tweetId}` : null,
    error: tweetId ? null : `post failed${lastErr ? `: ${lastErr.slice(0, 260)}` : ""}`.slice(0, 300),
    claimedBy: null,
    createdAt: now,
    updatedAt: Date.now(),
  };
  await db.insert(jobs).values(finalRow);

  return {
    ...base,
    status: finalRow.status,
    tweetUrl: finalRow.tweetUrl,
    error: finalRow.error,
    jobId,
    path: cardUri ? "session-card" : "session",
  };
}

// --- card pre-warm helpers (used by /api/posts/prepare) ----------------------
// Building a card is the slow part of a link post (video upload into the ads
// library, ~10-30s cold). The composer warms it as soon as a video + link are
// chosen so the actual Post click finishes in a couple of seconds.

export async function cardStatus(
  mediaKey: string | null,
  mediaRef: string,
  url: string
): Promise<boolean> {
  const cacheKey = String(mediaKey || `media:${mediaRef}`);
  return !!(await lookupCard(cacheKey, url));
}

/** True when this video is already in the ads library, so a card build is
 *  just the (fast) card API call. Used by the pre-warm path. */
export async function adsMediaReady(mediaKey: string | null, mediaRef: string): Promise<boolean> {
  const cacheKey = String(mediaKey || `media:${mediaRef}`);
  const gold = await goldCardFactory();
  if (!gold) return false;
  return !!(await lookupAdsMedia(cacheKey, gold.adsAccountId));
}

/**
 * Pre-upload a video into the X ads library with the gold (Ads-enabled) token.
 *
 * The ads-library media object is LINK-INDEPENDENT: it only holds the video.
 * So this can run the moment a video is uploaded — long before the user picks a
 * link — which turns the later card build from ~25-60s into ~1s. That is what
 * makes the composer's "card ready ✓" chip appear immediately instead of the
 * user watching a 3-minute spinner.
 */
const warmInflight = new Map<string, Promise<{ ok: boolean; ms: number; error?: string }>>();

export async function warmAdsMedia(
  mediaKey: string | null,
  mediaRef: string,
  videoUrl: string
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const cacheKey = String(mediaKey || `media:${mediaRef}`);
  const running = warmInflight.get(cacheKey);
  if (running) return running;
  const job = (async () => {
    const t0 = Date.now();
    try {
      const gold = await goldCardFactory();
      if (!gold) {
        return { ok: false, ms: Date.now() - t0, error: "no Ads-enabled (gold) credentials configured" };
      }
      if (await lookupAdsMedia(cacheKey, gold.adsAccountId)) {
        return { ok: true, ms: Date.now() - t0 };
      }
      const adsId = await uploadMediaOAuth1(gold.creds, videoUrl);
      await saveAdsMedia(cacheKey, gold.adsAccountId, adsId);
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 240) };
    }
  })();
  warmInflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    warmInflight.delete(cacheKey);
  }
}

export async function prepareCard(
  mediaKey: string | null,
  mediaRef: string,
  videoUrl: string,
  url: string,
  title: string
): Promise<boolean> {
  const cardUri = await ensureCard(mediaKey, videoUrl, url, title || "Learn more", mediaRef);
  return !!cardUri;
}
