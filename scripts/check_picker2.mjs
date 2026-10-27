// Per-shape video load diagnostics on PROD picker + raw twimg probes.
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

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: "xp_session", value: sess, url: BASE }]);
const page = await ctx.newPage();
const events = [];
page.on("request", (r) => { if (r.url().includes("proxy-media")) events.push({ t: "req", url: r.url(), range: r.headers()["range"] || "-" }); });
page.on("response", (r) => { if (r.url().includes("proxy-media")) events.push({ t: "res", url: r.url(), status: r.status() }); });
page.on("requestfailed", (r) => { if (r.url().includes("proxy-media")) events.push({ t: "fail", url: r.url(), why: r.failure()?.errorText }); });

await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3000);
await page.getByText("Add media", { exact: false }).first().click();
await page.waitForTimeout(6000);

const vids = await page.evaluate(() => Array.from(document.querySelectorAll("video")).map((v) => ({
  rs: v.readyState, err: v.error ? v.error.code : 0,
  shape: /twimg/.test(v.currentSrc || "") ? "twimg" : "blob",
  src: decodeURIComponent((v.currentSrc || "").split("u=")[1] || "").slice(0, 90),
})));
console.log("=== per-video ===");
vids.forEach((v, i) => console.log(`${i}: shape=${v.shape} rs=${v.rs} err=${v.err} :: ${v.src}`));

// probe the exact failing URLs node-side (no browser)
console.log("=== raw probes of video srcs ===");
for (const v of vids.slice(0, 6)) {
  const u = v.src;
  if (!u) continue;
  for (const rg of [undefined, "bytes=0-"]) {
    const h = rg ? { range: rg } : {};
    try {
      const r = await fetch(u, { headers: h, redirect: "follow" });
      console.log(`probe ${v.shape} range=${rg ?? "none"} -> ${r.status} ct=${r.headers.get("content-type")} cr=${r.headers.get("content-range") ?? "-"} ar=${r.headers.get("accept-ranges") ?? "-"}`);
      r.body?.cancel?.();
    } catch (e) { console.log(`probe ${v.shape} range=${rg ?? "none"} -> EXC ${String(e).slice(0, 80)}`); }
  }
}
console.log("=== event log (first 18) ===");
events.slice(0, 18).forEach((e) => console.log(JSON.stringify(e).slice(0, 150)));
await page.screenshot({ path: "C:/Users/ankit/x_panel/scripts/picker_check2.png" });
await browser.close();
