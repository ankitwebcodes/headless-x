import { readDmDoc, updateDmDoc, runnableDmRuns } from "./dm-store.ts";
import { processDmRun } from "./dm-run.ts";

type WorkerHeartbeat = { at: number; kind: "pc" | "cloud"; online: boolean };
export async function dmWorkerHeartbeat(kind: WorkerHeartbeat["kind"], online = true) {
  const value = { at: Date.now(), kind, online };
  await updateDmDoc("__dm_system__", "worker:heartbeat", () => value, () => value);
}
export async function dmWorkerStatus() {
  const heartbeat = await readDmDoc<WorkerHeartbeat>("__dm_system__", "worker:heartbeat");
  return { online: !!heartbeat?.online && Date.now() - heartbeat.at < 90000, kind: heartbeat?.kind ?? null };
}
export async function dispatchDmWorker() {
  const candidates = await runnableDmRuns();
  return Promise.allSettled(candidates.map(({ owner, key }) => processDmRun(owner, key.slice(4), 40000)));
}
