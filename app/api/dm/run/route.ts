import { getUser, json } from "@/lib/reqAuth";
import { getSession, readDmDoc } from "@/lib/dm-store";
import { createDmRun, latestRun, processDmRun, controlDmRun, resolveDmItem, runSummary,runAttention, getDmProgress, type DmRun } from "@/lib/dm-run";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false,error: "Unauthorized" },401);
  const params = new URL(req.url).searchParams;
  const run = params.get("runId") ? await readDmDoc<DmRun>(user.id,`run:${params.get("runId")}`) : await latestRun(user.id,params.get("id") ?? "");
  const accountId = run?.accountId ?? params.get("id") ?? "";
  return json({ ok: true,run:run?{...run,attention:runAttention(run)}:null,summary: run ? runSummary(run) : null,
    progress: accountId ? await getDmProgress(user.id,accountId,run) : {} });
}
export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return json({ ok: false,error: "Unauthorized" },401);
  try {
    const body = await req.json();
    let run: DmRun;
    if (body.runId) {
      const old = await readDmDoc<DmRun>(user.id,`run:${String(body.runId)}`);
      if (!old || !await getSession(user.id,old.accountId)) return json({ ok: false,error: "Run not found" },404);
      if (body.action === "resolve" && ["sent","not_sent"].includes(body.resolution)) run = await resolveDmItem(user.id,old.id,String(body.conversationId),body.resolution);
      else if (["pause","resume","retry","cancel"].includes(body.action)) run = await controlDmRun(user.id,old.id,body.action,
        { includeReplied: typeof body.includeReplied === "boolean" ? body.includeReplied : undefined,
          cooldownMinutes: typeof body.cooldownMinutes === "number" ? body.cooldownMinutes : undefined });
      else run = await processDmRun(user.id,old.id);
    } else run = await createDmRun(user.id,body);
    return json({ ok: true,run:{...run,attention:runAttention(run)},summary: runSummary(run),progress: await getDmProgress(user.id,run.accountId,run) });
  } catch (e) { return json({ ok: false,error: (e as Error).message },409); }
}
