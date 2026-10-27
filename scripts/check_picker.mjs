// LIVE picker/thumbnail check against PROD (Netlify).
// Mints a QA admin (random pw, never printed), real-login via API, then drives
// a real Chromium: open composer -> Add media modal -> inspect every <video>.
// Prints NON-SECRET diagnostics only; saves a screenshot of the modal.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { chromium } from "playwright";

const envPath = new URL("../.env.prod", import.meta.url);
const m = readFileSync(envPath, "utf8");
const env = {};
for (const line of m.split("\n")) {
  const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (mt) env[mt[1]] = mt[2].replace(/^"|"$/g, "");
}
const db = neon(env.DATABASE_URL);
const BASE = "https://x-panel-six.netlify.app";

const EMAIL = "qa-e2e-admin@pinelab.org";
const PW = "Qa" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const hash = bcrypt.hashSync(PW, 10);
await db`delete from users where email = ${EMAIL}`;
await db`insert into users (id, email, password_hash, name, role, created_at) values ('qa-e2e-admin-0004', ${EMAIL}, ${hash}, 'QA E2E Admin', 'admin', ${Date.now()})`;

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
const setCookie = login.headers.get("set-cookie") || "";
const sess = (setCookie.match(/xp_session=([^;]+)/) || [])[1];
console.log("login:", login.status, "| cookie:", sess ? "OK" : "FAIL");
if (!sess) process.exit(1);

// library shape: how many videos/images total
const counts = await db`select media_type, count(*)::int as n from media group by 1`;
console.log("library:", counts.map((r) => `${r.media_type}=${r.n}`).join(" "));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: "xp_session", value: sess, url: BASE }]);
const page = await ctx.newPage();
const failures = [];
page.on("requestfailed", (r) => { if (r.url().includes("proxy-media")) failures.push("REQFAIL " + r.failure()?.errorText + " " + r.url().slice(0, 80)); });
page.on("response", (r) => { if (r.url().includes("proxy-media") && r.status() >= 400) failures.push("HTTP " + r.status() + " " + r.url().slice(0, 80)); });

await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);
console.log("page title:", await page.title());

// open the Add media modal
const addBtn = page.getByText("Add media", { exact: false }).first();
if (await addBtn.count()) {
  await addBtn.click();
  console.log("clicked add-media trigger");
} else {
  console.log("add-media button NOT found — dumping buttons:");
  console.log(await page.locator("button").allTextContents().then((a) => a.slice(0, 20).join(" | ")));
}
await page.waitForTimeout(5000);

// modal content: videos and their state
const vids = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("video").forEach((v) => {
    out.push({
      readyState: v.readyState, // 0=NOTHING 1=META 2=DATA ...
      networkState: v.networkState, // 2=LOADING 3=NO_SOURCE on error
      w: v.videoWidth, h: v.videoHeight,
      err: v.error ? v.error.code : null, // 4=SRC_NOT_SUPPORTED
      src: (v.currentSrc || v.src || "").slice(0, 60),
    });
  });
  return out;
});
console.log("videos in DOM:", vids.length);
const byState = {};
vids.forEach((v) => { const k = `rs${v.readyState}_err${v.err ?? "0"}`; byState[k] = (byState[k] || 0) + 1; });
console.log("video states:", JSON.stringify(byState));
console.log("sample src:", vids.slice(0, 2).map((v) => v.src).join(" ;; "));

// fallback boxes (🎬 label) = VideoThumb error state
const fallbacks = await page.evaluate(() => {
  let n = 0;
  document.querySelectorAll("div").forEach((d) => { if (d.textContent?.trim().startsWith("🎬") && d.children.length === 0) n++; });
  return n;
});
console.log("fallback 🎬 boxes:", fallbacks);
console.log("proxy-media failures:", failures.length ? failures.slice(0, 5).join(" || ") : "none");

await page.screenshot({ path: "C:/Users/ankit/x_panel/scripts/picker_check.png" });
console.log("screenshot saved");
await browser.close();
