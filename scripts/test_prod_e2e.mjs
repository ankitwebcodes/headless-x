// FULL USER-PATH E2E against PROD (no secret minting):
// 1) ensure a QA admin user in Neon (role=admin can post to any approved account)
// 2) login at prod /api/auth/login -> real Set-Cookie xp_session
// 3) POST /api/posts with @guysexhibition + library video + affiliate link
// 4) verify the tweet carries a CARD and no link in text (syndication API)
// 5) DELETE the tweet via the account's own session cookies
// Prints NO secrets.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";

const m = readFileSync(new URL("../.env.prod", import.meta.url), "utf8");
const env = {};
for (const line of m.split("\n")) {
  const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (mt) env[mt[1]] = mt[2].replace(/^"|"$/g, "");
}
const db = neon(env.DATABASE_URL);

const EMAIL = "qa-e2e-admin@pinelab.org";
const PW = "Qa" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const hash = bcrypt.hashSync(PW, 10);
await db`delete from users where email = ${EMAIL}`;
await db`insert into users (id, email, password_hash, name, role, created_at) values ('qa-e2e-admin-0003', ${EMAIL}, ${hash}, 'QA E2E Admin', 'admin', ${Date.now()})`;
console.log("qa admin user ready");

// ---- login on prod ----
const login = await fetch("https://x-panel-six.vercel.app/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
const setCookie = login.headers.get("set-cookie") || "";
const sess = (setCookie.match(/xp_session=([^;]+)/) || [])[1];
console.log("login:", login.status, "| cookie issued:", sess ? "YES" : "NO — " + (await login.text()).slice(0, 120));
if (!sess) process.exit(1);

// ---- pick account + video ----
const acct = (await db`select id, handle from accounts where handle='guysexhibition' limit 1`)[0];
const vid = (await db`select id, media_key from media where account_id = ${acct.id} and media_type='VIDEO' and media_key like 'gm_%' order by created_at desc limit 1`)[0];
if (!vid) { console.log("NO SYNCED VIDEO"); process.exit(1); }
console.log("video:", vid.media_key);

// ---- post through the real prod API ----
const LINK = "https://www.ourdreamersai13.com/48X5HCL/NFC9H/?uid=193";
const res = await fetch("https://x-panel-six.vercel.app/api/posts", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `xp_session=${sess}` },
  body: JSON.stringify({
    accountId: acct.id, mediaId: vid.id,
    caption: "E2E panel test — safe to ignore",
    url: LINK, title: "Try free",
  }),
});
const body = await res.json().catch(() => ({}));
console.log("POST /api/posts:", res.status);
console.log("status:", body.status, "| path:", body.job?.path, "| error:", body.error ?? body.job?.error ?? "none");
const tweetUrl = body.tweetUrl ?? body.job?.tweetUrl;
if (!tweetUrl) process.exit(1);
console.log("tweetUrl:", tweetUrl);
const tid = tweetUrl.split("/status/")[1];

// ---- verify card on the tweet via syndication ----
const syn = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tid}&lang=en`, {
  headers: { "user-agent": "Mozilla/5.0" },
});
const sJson = await syn.json().catch(() => ({}));
console.log("syndication card:", sJson?.card?.name ?? "(none)");
console.log("link in text:", String(sJson?.text ?? "").includes("ourdreamersai13"), "| text:", String(sJson?.text ?? "").slice(0, 80));

// ---- cleanup ----
const g = (await db`select session_json from accounts where handle='guysexhibition' limit 1`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => Array.isArray(jar) ? (jar.find((c) => c.name === n)?.value ?? "") : (jar[n] ?? "");
const xp = readFileSync(new URL("../lib/xpost.ts", import.meta.url), "utf8");
const GUEST_BEARER = (xp.match(/GUEST_BEARER =\s*\n?\s*"([^"]+)"/) || [])[1];
const WEB_UA = (xp.match(/WEB_UA = "([^"]+)"/) || [])[1] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const delQid = "nxpZCY2K-I6QoFHAHeojFQ";
const d = await fetch(`https://x.com/i/api/graphql/${delQid}/DeleteTweet`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${GUEST_BEARER}`, "x-csrf-token": pick("ct0"),
    "x-twitter-auth-type": "OAuth2Session", "content-type": "application/json",
    cookie: `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`,
    "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home",
  },
  body: JSON.stringify({ variables: { tweet_id: tid }, queryId: delQid }),
});
console.log("DELETE:", d.status);
await db`delete from users where email = ${EMAIL}`;
console.log("qa user cleaned");