import io

# ---- 1. append OAuth1 media upload to lib/xpost.ts ----
XPOST = r"C:\Users\ankit\x_panel\lib\xpost.ts"
with io.open(XPOST, "r", encoding="utf-8") as f:
    src = f.read()

ADD = '''
// --- v1.1 media upload via OAuth1 (NO cookies needed) -----------------------
// Full-perms OAuth1 tokens can upload media and post v2 tweets without any
// browser session. Used as the fallback when the account's cookies are dead.

const UPLOAD_BASE = "https://upload.twitter.com/1.1/media/upload.json";

export async function uploadMediaOAuth1(
  creds: OAuth1Creds,
  mediaUrl: string
): Promise<string> {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("media download is empty");
  const isVideo = mediaUrl.includes("video.twimg") || /\\.(mp4|mov|webm)(\\?|$)/i.test(mediaUrl);
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
    const aRes = await fetch(`${UPLOAD_BASE}?${new URLSearchParams(q)}`, {
      method: "POST",
      headers: {
        authorization: h,
        "content-type": isVideo ? "video/mp4" : "image/jpeg",
        "content-length": String(part.length),
      },
      body: new Uint8Array(part),
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
'''

if "uploadMediaOAuth1" not in src:
    src = src.rstrip() + "\n" + ADD
    with io.open(XPOST, "w", encoding="utf-8", newline="") as f:
        f.write(src)
    print("OK xpost.ts uploadMediaOAuth1 added")
else:
    print("SKIP xpost.ts already has it")

# ---- 2. attemptPost: OAuth1 fallback when session dead ----
P1 = r"C:\Users\ankit\x_panel\lib\postOne.ts"
with io.open(P1, "r", encoding="utf-8") as f:
    p1 = f.read()

OLD = """  if (!p || !p.ok || !p.username) {
    return {
      ...base,
      status: "failed",
      tweetUrl: null,
      error: `X session expired for @${acct.handle} — refresh cookies: Admin → Accounts → this account's ⋯ menu → Refresh (paste a fresh X Grabber blob).`,
    };
  }"""
NEW = """  if (!p || !p.ok || !p.username) {
    // cookies dead — but a FULL-PERMS OAuth1 token posts fine without cookies
    if (creds && creds.consumer_key && creds.access_token) {
      const who = await verifyOAuth1(creds).catch(() => null);
      if (who && who.screen_name.toLowerCase() === handleLower) {
        try {
          const upId = await uploadMediaOAuth1(creds, m.url);
          const text = urlTxt ? `${captionTxt}\\n\\n${urlTxt}` : captionTxt;
          const tweetId = await postTweetV2(creds, { text, mediaIds: [upId] });
          const now = Date.now();
          const jobId = uid();
          await db.insert(jobs).values({
            id: jobId, userId, accountId: acct.id, mediaId: m.id,
            caption: captionTxt, url: urlTxt, title: titleTxt,
            status: "done" as const,
            tweetUrl: `https://x.com/${who.screen_name}/status/${tweetId}`,
            error: null, claimedBy: null, createdAt: now, updatedAt: now,
          });
          return {
            ...base, status: "done",
            tweetUrl: `https://x.com/${who.screen_name}/status/${tweetId}`,
            error: null, jobId, path: "oauth1-v2",
          };
        } catch (e) {
          return {
            ...base, status: "failed", tweetUrl: null,
            error: `OAuth1-v2 post failed: ${(e as Error).message?.slice(0, 240)}`,
          };
        }
      }
    }
    return {
      ...base,
      status: "failed",
      tweetUrl: null,
      error: `X session expired for @${acct.handle} and no full-perms OAuth1 on file — refresh cookies: Admin → Accounts → Assign…/refresh (paste a fresh X Grabber blob).`,
    };
  }"""

if OLD in p1:
    p1 = p1.replace(OLD, NEW)
    # add imports
    p1 = p1.replace(
        'import {\n  probeSession,',
        'import {\n  probeSession,\n  uploadMediaOAuth1,\n  postTweetV2,\n  verifyOAuth1,',
    )
    # creds must be parsed BEFORE the session probe (move the block up)
    with io.open(P1, "w", encoding="utf-8", newline="") as f:
        f.write(p1)
    print("OK postOne.ts OAuth1 fallback")
else:
    print("FAIL postOne pattern not found")
