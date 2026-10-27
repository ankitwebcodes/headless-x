// Debug: which chunk contains which operation manifest?
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const m = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const DSN = (m.match(/DATABASE_URL\s*=\s*"([^"]+)"/) || m.match(/DATABASE_URL\s*=\s*(\S+)/))[1];
const db = neon(DSN);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const acct = (await db`select session_json from accounts where handle ilike '%guysexhibition%' limit 1`)[0];
const s = typeof acct.session_json === "string" ? JSON.parse(acct.session_json) : acct.session_json;
const jar = s.cookies ?? s;
const pick = (n) => Array.isArray(jar) ? (jar.find((c) => c.name === n)?.value ?? "") : (jar[n] ?? "");
const cookie = `auth_token=${pick("auth_token")}; ct0=${pick("ct0")}`;

const home = await fetch("https://x.com/home", { headers: { cookie, "user-agent": UA } });
console.log("home status:", home.status);
const html = await home.text();
const urls = Array.from(new Set(html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"' ]+\.js/g) ?? []));
console.log("chunk urls found:", urls.length);
const OPS = ["Viewer", "CreateTweet", "DeleteTweet", "UserMedia"];
const found = {};
let i = 0;
for (const u of urls) {
  i++;
  const res = await fetch(u);
  if (!res.ok) continue;
  const js = await res.text();
  if (!js.includes("operationName:")) continue;
  for (const op of OPS) {
    if (found[op]) continue;
    const mm = js.match(new RegExp(`queryId:"([A-Za-z0-9_-]{10,30})",operationName:"${op}"`)) ||
      js.match(new RegExp(`operationName:"${op}",queryId:"([A-Za-z0-9_-]{10,30})"`));
    if (mm) { found[op] = mm[1]; console.log(op, "=", mm[1], "(chunk " + i + ")"); }
  }
  if (OPS.every((o) => found[o])) break;
}
console.log("FOUND:", JSON.stringify(found));
