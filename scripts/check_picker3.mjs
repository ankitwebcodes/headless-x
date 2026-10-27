// v3: robust modal wait + raw URL probes from DB (twimg vs blob shapes).
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { chromium } from "playwright";

const env = {};
for (const line of readFileSync(new URL("../.env.prod", import.meta.url), "utf8").split("\n")) {
  const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (mt) env[mt[1]] = mt[2].replace(/^"|"$/g, "");
}
const db = neon(env.DATABASE_URL);
const BASE = "https://x-panel-six.netlify.app";
const EMAIL = "qa-e2e-admin@pinelab.org";
const PW = "Qa" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
await db`delete from users where email = ${EMAIL}`;
await db`insert into users (id, email, password_hash, name, role, created_at) values ('qa-e2e-admin-0004', ${EMAIL}, ${bcrypt.hashSync(PW, 10)}, 'QA', 'admin', ${Date.now()})`;
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) });
const sess = ((login.headers.get("set-cookie") || "").match(/xp_session=([^;]+)/) || [])[1];
if (!sess) { console.log("login FAIL"); process.exit(1); }

// ---- raw probes straight from DB (bypass browser entirely) ----
console.log("=== RAW PROBES (via panel proxy, as the browser would) ===");
const twimg = await db`select url from media where media_type='VIDEO' and url like '%twimg%' order by created_at desc limit 4`;
const blobs = await db`select url from media where url like '%blob%' and url like '%.mp4%' order by created_at desc limit 3`;
for (const grp of [["twimg", twimg], ["blob", blobs]]) {
  for (const r of grp[1].slice(0, 4)) {
    const prox = `${BASE}/api/proxy-media?u=${encodeURIComponent(r.url)}`;
    for (const rg of [undefined, "bytes=0-"]) {
      try {
        const res = await fetch(prox, { headers: rg ? { range: rg } : {}, redirect: "manual" });
        console.log(`${grp[0]} range=${rg ?? "none"} -> ${res.status} ct=${res.headers.get("content-type")} loc=${(res.headers.get("location") || "").slice(0, 50)} ar=${res.headers.get("accept-ranges") ?? "-"}`);
        res.body?.cancel?.();
      } catch (e) { console.log(`${grp[0]} range=${rg ?? "none"} -> EXC ${String(e).slice(0, 70)}`); }
    }
    // follow the 302 and range it, like the browser does
    try {
      const res = await fetch(prox, { headers: { range: "bytes=0-" }, redirect: "follow" });
      console.log(`${grp[0]} FOLLOWED range=0- -> ${res.status} ct=${res.headers.get("content-type")} cr=${res.headers.get("content-range") ?? "-"}`);
      res.body?.cancel?.();
    } catch (e) { console.log(`${grp[0]} FOLLOWED -> EXC ${String(e).slice(0, 70)}`); }
  }
}

// ---- browser UI check (robust) ----
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: "xp_session", value: sess, url: BASE }]);
const page = await ctx.newPage();
const fails = [];
page.on("response", (r) => { if (r.url().includes("proxy-media") && r.status() >= 400) fails.push(`${r.status()} ${decodeURIComponent(r.url().split("u=")[1] || "").slice(0, 70)}`); });
await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("button", { timeout: 20000 });
try { await page.waitForSelector(".media-thumb, video", { timeout: 8000 }); } catch {}
// click the dashed add-media button if present
const btn = page.locator("button", { hasText: "Add media" }).first();
if (await btn.count()) await btn.click().catch(() => {});
await page.waitForSelector("video", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(5000);
const vids = await page.evaluate(() => Array.from(document.querySelectorAll("video")).map((v) => ({
  rs: v.readyState, err: v.error ? v.error.code : 0,
  shape: /twimg/.test(v.currentSrc || "") ? "twimg" : "blob",
})));
const sum = {};
vids.forEach((v) => { const k = `${v.shape}_rs${v.rs}_err${v.err}`; sum[k] = (sum[k] || 0) + 1; });
console.log("=== UI videos ===", JSON.stringify(sum), "of", vids.length, "mounted");
console.log("=== UI proxy 4xx/5xx ===", fails.length ? fails.slice(0, 8) : "none");
await page.screenshot({ path: "C:/Users/ankit/x_panel/scripts/picker_check3.png" });
await browser.close();
