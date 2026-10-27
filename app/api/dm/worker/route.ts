import { json } from "@/lib/reqAuth";
import { validDmWorkerKey } from "@/lib/dm-auth";
import { runnableDmRuns } from "@/lib/dm-store";
import { processDmRun } from "@/lib/dm-run";
import { boundedInt } from "@/lib/dm-core";
import { dmWorkerHeartbeat } from "@/lib/dm-worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Invoke every minute from a cloud scheduler. Work also advances while the UI is open.
export async function POST(req: Request) {
  if (!validDmWorkerKey(req)) return json({ ok: false,error: "Unauthorized" },401);
  await dmWorkerHeartbeat("cloud");
  const candidates = await runnableDmRuns();
  const budget = boundedInt(new URL(req.url).searchParams.get("budgetMs") ?? undefined,35000,16000,40000);
  const results = await Promise.allSettled(candidates.map(async ({ owner,key }) => {
    const run = await processDmRun(owner,key.slice(4),budget);
    return { id: run.id,status: run.status };
  }));
  return json({ ok: true,results: results.map(r => r.status === "fulfilled" ? r.value : { error: String(r.reason?.message ?? r.reason) }) });
}
