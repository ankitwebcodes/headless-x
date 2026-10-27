// In-memory registry of post fan-out "runs".
//
// WHY: a fan-out used to run entirely INSIDE the POST request. Cold card
// creation (ads-library upload of the video) takes 20-60s, so the request
// stayed open for a minute; any hiccup on the browser→Cloudflare→tunnel path
// killed it, the client saw "Network error", and NOTHING was recorded — the
// user could not even tell whether the post had gone out.
//
// Now the route creates a run, returns a runId in ~200ms, and the fan-out
// keeps running on the server. The dashboard polls GET /api/posts/bulk?runId=…
// so results survive a dropped connection, a page reload, or a closed tab.

import type { PostAttempt } from "./postOne";

export type RunState = {
  id: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  total: number;
  dry: boolean;
  status: "running" | "finished";
  results: PostAttempt[];
  summary: { total: number; done: number; queued: number; failed: number };
};

const RUNS = new Map<string, RunState>();
const MAX_RUNS = 40;
const MAX_AGE_MS = 6 * 3600_000;

export function createRun(userId: string, total: number, dry = false): RunState {
  const run: RunState = {
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    total,
    dry,
    status: "running",
    results: [],
    summary: { total, done: 0, queued: 0, failed: 0 },
  };
  RUNS.set(run.id, run);
  pruneRuns();
  return run;
}

export function addResult(run: RunState, r: PostAttempt): void {
  run.results.push(r);
  const done = run.results.filter((x) => x.status === "done").length;
  const queued = run.results.filter((x) => x.status === "queued").length;
  const failed = run.results.filter((x) => x.status === "failed").length;
  run.summary = { total: run.total, done, queued, failed };
  run.updatedAt = Date.now();
}

export function finishRun(run: RunState): void {
  run.status = "finished";
  run.updatedAt = Date.now();
}

export function getRun(id: string): RunState | undefined {
  return RUNS.get(id);
}

/** Most recent run for a user — lets the UI re-attach after a reload or a
 *  dropped connection (when it never received the runId). */
export function latestRunFor(userId: string): RunState | undefined {
  const all = Array.from(RUNS.values()).filter((r) => r.userId === userId);
  if (!all.length) return undefined;
  all.sort((a, b) => b.createdAt - a.createdAt);
  return all[0];
}

function pruneRuns(): void {
  const now = Date.now();
  const all = Array.from(RUNS.values());
  for (const r of all) {
    if (now - r.updatedAt > MAX_AGE_MS) RUNS.delete(r.id);
  }
  const rest = Array.from(RUNS.values());
  if (rest.length <= MAX_RUNS) return;
  rest.sort((a, b) => a.createdAt - b.createdAt);
  for (const r of rest.slice(0, rest.length - MAX_RUNS)) RUNS.delete(r.id);
}
