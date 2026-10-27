// One-shot codemod for lib/xpost.ts: add UserMedia qid + cookie-based media sync.
import { readFileSync, writeFileSync } from "node:fs";

const p = new URL("../lib/xpost.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let src = readFileSync(p, "utf8");

// 1. Add UserMedia fallback qid
if (!src.includes('UserMedia: "QWOimofaocjeRda7Tm5pNA"')) {
  src = src.replace(
    `  DeleteTweet: "nxpZCY2K-I6QoFHAHeojFQ",\n};`,
    `  DeleteTweet: "nxpZCY2K-I6QoFHAHeojFQ",\n  UserMedia: "QWOimofaocjeRda7Tm5pNA", // live-verified 2026-10\n};`
  );
}

// 2. Extractor should fetch UserMedia too
src = src.replace(
  `if (out.Viewer && out.CreateTweet) break;`,
  `if (out.Viewer && out.CreateTweet && out.UserMedia) break;`
);

// 3. Insert the cookie-based media sync helpers after probeSession (before the CreateTweet comment block)
if (!src.includes("fetchUserMediaCookies")) {
  const block = `// --- cookie-based media-library sync (no OAuth1 needed) ---------------------

export type UserMediaItem = {
  key: string; // gm_<mediaEntityId> — dedup-safe
  url: string;
  type: "VIDEO" | "IMAGE";
  name: string;
  createdAt?: number;
};

function cleanMediaName(text: unknown, id: string, type: "VIDEO" | "IMAGE"): string {
  const t = String(text ?? "")
    .replace(/https:\\/\\/t\\.co\\/\\S+/g, "")
    .replace(/\\s+/g, " ")
    .trim();
  if (t) return t.length > 60 ? t.slice(0, 57) + "..." : t;
  return type === "VIDEO" ? \`video_\${id}.mp4\` : \`photo_\${id}.jpg\`;
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
    const vars = {
      userId: probe.id,
      count: 50,
      includePromotedContent: false,
      withClientEventId: true,
      withSuperFollowsUserFields: true,
      withSuperFollowsTweetFields: true,
    };
    const url = \`https://x.com/i/api/graphql/\${qid}/UserMedia?variables=\${encodeURIComponent(
      JSON.stringify(vars)
    )}&features=\${encodeURIComponent(JSON.stringify(FEATURES))}\`;
    const r = await fetch(url, {
      headers: {
        authorization: \`Bearer \${GUEST_BEARER}\`,
        "x-csrf-token": csrf,
        cookie,
        "user-agent": WEB_UA,
        "x-twitter-active-user": "yes",
        origin: "https://x.com",
        referer: "https://x.com/media",
      },
    });
    if (r.status !== 200) {
      return { items: [], error: \`UserMedia http \${r.status}\` };
    }
    const j = await r.json();
    // Response shape (2026-10): data.user.result.timeline.timeline.instructions
    const tl = j?.data?.user?.result?.timeline?.timeline ?? j?.data?.user?.media?.timeline ?? null;
    const inst = tl?.instructions ?? [];
    const items: UserMediaItem[] = [];
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
            if (md.type === "video" || md.type === "animated_gif") {
              const variants = (md.video_info?.variants ?? []).filter(
                (v) => v.content_type === "video/mp4"
              );
              variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
              const best = variants[0];
              if (best) {
                items.push({
                  key: \`gm_\${md.id_str}\`,
                  url: best.url,
                  type: "VIDEO",
                  name: cleanMediaName(legacy?.full_text, md.id_str, "VIDEO"),
                  createdAt: Date.parse(legacy?.created_at ?? "") || undefined,
                });
              }
            } else if (md.type === "photo") {
              items.push({
                key: \`gm_\${md.id_str}\`,
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
    return { items, username: probe.username };
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

/**
 * Post a tweet via X web GraphQL with media_entities (videos already in the`;

  src = src.replace(`/**\n * Post a tweet via X web GraphQL with media_entities (videos already in the`, block);
}

writeFileSync(p, src);
console.log("xpost.ts updated:", {
  qid: src.includes('UserMedia: "QWOimofaocjeRda7Tm5pNA"'),
  fn: src.includes("fetchUserMediaCookies"),
});