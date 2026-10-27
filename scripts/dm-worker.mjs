import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error("The PC DM worker requires Postgres.");
const { dmWorkerHeartbeat, dispatchDmWorker } = await import("../lib/dm-worker.ts");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
const pulse = setInterval(() => dmWorkerHeartbeat("pc").catch(e => console.error("DM worker heartbeat:", e.message)), 15000);
try {
  await dmWorkerHeartbeat("pc");
  console.log("DM PC worker online. Only started runs advance; paused/restricted runs stay stopped.");
  while (!stopping) {
    try {
      const results = await dispatchDmWorker();
      for (const result of results) if (result.status === "rejected" && !/already scanning|cooling down/i.test(result.reason?.message ?? "")) console.error("DM batch:", result.reason?.message ?? "Failed");
    } catch (e) { console.error("DM dispatcher:", e.message); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
} finally { clearInterval(pulse); await dmWorkerHeartbeat("pc", false); }
