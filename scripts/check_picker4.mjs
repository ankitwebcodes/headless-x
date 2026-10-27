// v4: poll video readyState up to 25s in the real picker, then screenshot.
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
const fails = [];
page.on("response", (r) => { if (r.url().includes("proxy-media") && r.status() >= 400) fails.push(`${r.status()} ${decodeURIComponent(r.url().split("u=")[1] || "").slice(0, 60)}`); });
await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("button", { timeout: 20000 });
const btn = page.locator("button", { hasText: "Add media" }).first();
if (await btn.count()) await btn.click().catch(() => {});
await page.waitForSelector("video", { timeout: 20000 });
// poll readyState for up to 25s
for (let i = 0; i < 25; i++) {
  const snap = await page.evaluate(() => {
    const vs = Array.from(document.querySelectorAll("video"));
    return { n: vs.length, ready: vs.filter((v) => v.readyState >= 2).length, errs: vs.filter((v) => v.error).length };
  });
  if (snap.ready >= snap.n || (snap.n && i > 6 && snap.ready === 0 && snap.errs > 0)) {
    console.log(`t+${i}s:`, JSON.stringify(snap)); break;
  }
  if (i === 24) console.log(`t+24s final:`, JSON.stringify(snap));
  await page.waitForTimeout(1000);
}
const detail = await page.evaluate(() => Array.from(document.querySelectorAll("video")).map((v) => `${v.readyState}/${v.videoWidth}x${v.videoHeight}`).join(" "));
console.log("videos rs/size:", detail);
console.log("proxy 4xx/5xx:", fails.length ? fails.slice(0, 6) : "none");
await page.waitForTimeout(1500);
await page.screenshot({ path: "C:/Users/ankit/x_panel/scripts/picker_check4.png" });
await browser.close();
console.log("done");
