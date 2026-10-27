// Prod UI verification v2: login as QA admin, scan ALL dashboard scripts for markers
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
const PW = "qa-" + Math.random().toString(36).slice(2, 10);
const hash = bcrypt.hashSync(PW, 10);
await db`insert into users (id, email, password_hash, name, role, created_at) values ('qa-e2e-admin-0003', ${EMAIL}, ${hash}, 'QA E2E Admin', 'admin', ${Date.now()}) on conflict (id) do update set password_hash = ${hash}`;

const login = await fetch("https://x-panel-six.vercel.app/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
const cookie = ((login.headers.get("set-cookie") ?? "").match(/xp_session=[^;]+/) ?? [])[0];
console.log("LOGIN:", login.status, cookie ? "cookie ok" : "NO COOKIE");
if (!cookie) process.exit(1);
const H = { cookie };

const html = await (await fetch("https://x-panel-six.vercel.app/dashboard", { headers: H })).text();
const fixed = html.replaceAll("\\u002F", "/");
const srcs = [...new Set([...fixed.matchAll(/src="(\/_next\/[^"]+?\.js)"/g)].map((x) => x[1]))];
console.log("scripts found:", srcs.length);

let io = false, sidebar = false, protect = false, loadmore = false, pageChunk = null;
for (const s of srcs) {
  const j = await (await fetch("https://x-panel-six.vercel.app" + s, { headers: H })).text();
  if (j.includes("IntersectionObserver")) { io = true; pageChunk = s; }
  if (j.includes("x-sidebar")) sidebar = true;
  if (j.includes("contextmenu")) protect = true;
  if (j.includes("Load more")) loadmore = true;
}
console.log("LazyMount(IntersectionObserver):", io ? "PASS" : "FAIL", pageChunk ?? "");
console.log("X-theme sidebar:", sidebar ? "PASS" : "FAIL");
console.log("Protect(contextmenu):", protect ? "PASS" : "FAIL");
console.log("old 'Load more' gone:", !loadmore ? "PASS" : "FAIL");

const med = await fetch("https://x-panel-six.vercel.app/api/media", { headers: H }).then((r) => r.json());
console.log("MEDIA COUNT:", (med.media ?? []).length);
console.log("DONE");
