// Local UI screenshot helper: launches its own headless Chrome profile, injects the
// panel session cookie, opens /dm and saves a PNG. Chrome is never killed; only the
// throwaway profile this script created is closed.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = readFileSync(process.argv[2], "utf8").trim();
const target = process.argv[3] ?? "http://localhost:3000/dm";
const out = process.argv[4] ?? "dm-report.png";
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = mkdtempSync(join(tmpdir(), "cdp-shot-"));
const port = 9333;
const child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1500,2600", "about:blank"], { stdio: "ignore" });
const wait = ms => new Promise(r => setTimeout(r, ms));
let version;
for (let i = 0; i < 60; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await wait(250); } }
if (!version) { console.error("chrome did not start"); process.exit(1); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => { const mid = ++id; return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); }); };
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Network.enable", {}, sessionId);
  await send("Network.setCookie", { name: "xp_session", value: token, domain: "localhost", path: "/", sameSite: "Lax" }, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 2400, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: target }, sessionId);
  await wait(14000);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`saved ${out}`);
} finally { try { child.kill(); } catch {} }
process.exit(0);
