// Temporary local smoke test for the /xflow panel API.
// Mints an admin session cookie from .env.local's AUTH_SECRET and calls the API.
const fs = require("fs");

function readEnvKey(file, key) {
  const txt = fs.readFileSync(file, "utf8").replace(/\r/g, "");
  const line = txt.split("\n").find((l) => l.startsWith(key + "="));
  if (!line) return null;
  let v = line.slice(key.length + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

(async () => {
  const secret = readEnvKey(".env.local", "AUTH_SECRET");
  if (!secret) {
    console.log("AUTH_SECRET missing from .env.local");
    process.exit(1);
  }
  console.log("AUTH_SECRET length (unquoted):", secret.length);

  const { SignJWT } = await import("jose");
  const tok = await new SignJWT({ id: "smoke", email: "smoke@local", name: "smoke", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  const base = process.env.BASE || "http://localhost:3000";
  const cookie = { cookie: "xp_session=" + tok };

  const me = await fetch(base + "/api/auth/me", { headers: cookie });
  console.log("/api/auth/me ->", me.status, (await me.text()).slice(0, 100));

  const r = await fetch(base + "/api/automation", { headers: cookie });
  console.log("/api/automation ->", r.status);
  if (!r.ok) {
    console.log((await r.text()).slice(0, 300));
    return;
  }
  const j = await r.json();
  console.log("roster rows :", j.roster.length);
  console.log("defaults    :", JSON.stringify(j.defaults));
  console.log("run         :", JSON.stringify(j.run));
  console.log("bridgeUp    :", j.bridgeUp, "| live:", JSON.stringify(j.live));
  console.log("template    :", JSON.stringify(j.template));
  console.log("logTail     :", (j.log || "").split("\n").length, "lines");
  console.log("--- roster ---");
  for (const x of j.roster) {
    console.log(
      "  n" + String(x.n).padStart(2),
      x.key.padEnd(22),
      (x.handle || "?").padEnd(20),
      "link=" + (x.link ? x.link.slice(0, 52) : "(none)")
    );
  }

  const shot = await fetch(base + "/api/automation/shot", { headers: cookie });
  console.log("/api/automation/shot ->", shot.status, shot.headers.get("content-type") || "");
})();
