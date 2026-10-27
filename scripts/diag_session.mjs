// Diagnostic: check each account's stored session cookies against X (no secrets printed).
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

const db = neon(env.DATABASE_URL);
const rows = await db`select handle, session_json, oauth1_json from accounts order by handle`;

const pick = (jar, n) => (Array.isArray(jar) ? jar.find((c) => c.name === n)?.value ?? "" : jar[n] ?? "");

for (const r of rows) {
  const raw = typeof r.session_json === "string" ? JSON.parse(r.session_json || "{}") : (r.session_json || {});
  const jar = raw.cookies ?? raw;
  const auth = pick(jar, "auth_token");
  const ct0 = pick(jar, "ct0");
  const twid = decodeURIComponent(pick(jar, "twid") || "");
  const uid = (twid.match(/u=(\d+)/) || [])[1] || "";
  const hasOa = !!(r.oauth1_json && String(r.oauth1_json).length > 10);
  let status = "no-cookies";
  let name = "";
  if (auth && ct0 && uid) {
    try {
      const vars = { userId: uid, count: 1, includePromotedContent: false };
      const feats = { responsive_web_graphql_timeline_navigation_enabled: true, rweb_video_timestamps_enabled: true };
      const res = await fetch(
        `https://x.com/i/api/graphql/7_KBXBpG0zBPRN6UCIV0-w/UserTweets?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(feats))}`,
        { headers: { authorization: `Bearer ${guest}`, "x-csrf-token": ct0, "x-twitter-auth-type": "OAuth2Session", cookie: `auth_token=${auth}; ct0=${ct0}`, "user-agent": UA, "content-type": "application/json", origin: "https://x.com", referer: "https://x.com/" } }
      );
      status = String(res.status);
      if (res.ok) {
        const j = await res.json();
        const s = JSON.stringify(j);
        name = (s.match(/"screen_name":"([^"]+)"/) || [])[1] || "";
      }
    } catch (e) {
      status = "ERR " + String(e.message).slice(0, 60);
    }
  }
  console.log(`${r.handle.padEnd(18)} session=${String(status).padEnd(8)} user=${name.padEnd(18)} oauth1=${hasOa}`);
}
