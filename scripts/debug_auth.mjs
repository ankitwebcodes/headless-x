// Debug why minted token 401s on prod. No secret material printed.
import { readFileSync } from "node:fs";
import { SignJWT, jwtVerify } from "jose";

function loadEnv(file) {
  const m = readFileSync(file, "utf8");
  const env = {};
  for (const line of m.split("\n")) {
    const mt = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (mt) env[mt[1]] = mt[2].replace(/^"|"$/g, "");
  }
  return env;
}
const prodEnv = loadEnv("C:/Users/ankit/xp_deploy_copy/.env.prod");
const locEnv = loadEnv("C:/Users/ankit/xp_deploy_copy/.env.local");
console.log("prod AUTH_SECRET len:", (prodEnv.AUTH_SECRET || "").length, "| local len:", (locEnv.AUTH_SECRET || "").length, "| same:", prodEnv.AUTH_SECRET === locEnv.AUTH_SECRET);

const secret = new TextEncoder().encode(locEnv.AUTH_SECRET);
const token = await new SignJWT({ id: "x", email: "x@x.x", name: "x", role: "user" })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(secret);
const v = await jwtVerify(token, secret);
console.log("local verify of minted token:", v.payload.id);

const me = await fetch("https://x-panel-six.vercel.app/api/auth/me", {
  headers: { cookie: `xp_session=${token}` },
});
console.log("/api/auth/me:", me.status, (await me.text()).slice(0, 120));