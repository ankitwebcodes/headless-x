// Delete a tweet via the account's own session (proven DeleteTweet pattern).
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const TID = process.argv[2];
const envf = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (envf.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.replace(/^\"|\"$/g, "") ?? "";
const db = neon(env("DATABASE_URL"));
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const g = (await db`select session_json from accounts where id = 'ab625df9-786f-4c68-b4f3-f9b505a72614'`)[0];
const s = typeof g.session_json === "string" ? JSON.parse(g.session_json) : g.session_json;
const jar = s.cookies ?? s;
const pick = (n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;
const csrf = pick("ct0");
const guest = envf.match(/GUEST_BEARER\s*=\s*\n?\s*"([^"]+)"/)?.[1] ?? "";

async function qidFor(name, fallback) {
  const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": WEB_UA } });
  const html = await home.text();
  const urls = Array.from(new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []));
  for (const u of urls) {
    const rr = await fetch(u);
    if (!rr.ok) continue;
    const js = await rr.text();
    const mm = js.match(new RegExp('queryId:"([A-Za-z0-9_-]{10,30})",operationName:"' + name + '"')) ||
      js.match(new RegExp('operationName:"' + name + '",queryId:"([A-Za-z0-9_-]{10,30})"'));
    if (mm) return mm[1];
  }
  return fallback;
}
const delQid = await qidFor("DeleteTweet", "nxpZCY2K-I6QoFHAHeojFQ");
console.log("DeleteTweet qid:", delQid);
const r = await fetch(`https://x.com/i/api/graphql/${delQid}/DeleteTweet`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${guest}`, "x-csrf-token": csrf, "x-twitter-auth-type": "OAuth2Session",
    "content-type": "application/json", cookie, "user-agent": WEB_UA, origin: "https://x.com", referer: "https://x.com/home",
  },
  body: JSON.stringify({ variables: { tweet_id: TID }, queryId: delQid }),
});
const t = await r.text();
console.log("DELETE", TID, "HTTP", r.status, t.slice(0, 120));
