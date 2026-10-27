import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Where the automation lives (the Python xflow repo). */
export const XFLOW_DIR = process.env.XFLOW_DIR ?? "C:\\Users\\ankit\\xflow";
export const PYTHON =
  process.env.XFLOW_PYTHON ??
  "C:\\Users\\ankit\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
const BRIDGE = process.env.XFLOW_BRIDGE ?? "http://127.0.0.1:9411";

const TARGETS_F = path.join(XFLOW_DIR, "targets.json");
const LINKS_F = path.join(XFLOW_DIR, "links.json");
const LOCK_F = path.join(XFLOW_DIR, "run.lock");
/** Cooperative-stop flag the controller polls; also a bridge /stop ping. */
const STOP_F = path.join(XFLOW_DIR, "stop.flag");
/** Autopilot progress (slot N of M) written by the controller. */
const AUTO_F = path.join(XFLOW_DIR, "logs", "autopilot.json");
const LOG_F = path.join(XFLOW_DIR, "logs", "controller.log");
export const SHOT_F = path.join(XFLOW_DIR, "logs", "slot_shot.png");
/** Per-profile run report the controller writes (live during a run, final after). */
const RUN_JSON_F = path.join(XFLOW_DIR, "logs", "last_run.json");

export type Target = {
  slot: number;
  n: number;
  name: string;
  key: string;
  handle: string;
};

export type Defaults = {
  max_parallel: number;
  max_minutes: number;
  shot_every: number;
  dry_run: boolean;
  send_message: boolean;
  force: boolean;
  tile: "6x3" | "8x4" | "8x2x2";
};

export type RunState = {
  running: boolean;
  pid?: number;
  startedAt?: string;
  ageMin?: number;
  /** Worker mode: how many profiles are working right now, and which ones. */
  count?: number;
  keys?: string[];
  worker?: boolean;
};

function readJson<T>(f: string, fb: T): T {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return fb;
  }
}

function writeJson(f: string, v: unknown) {
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, f);
}

/** Canonical run order — 20 slots across Chrome + Brave. */
export function targets(): Target[] {
  const t = readJson<{ order?: Record<string, unknown>[] }>(TARGETS_F, { order: [] });
  return (t.order ?? []).map((o) => ({
    slot: Number(o.slot ?? 0),
    n: Number(o.n ?? 0),
    name: String(o.name ?? ""),
    key: String(o.key ?? ""),
    handle: String(o.expected_handle ?? ""),
  }));
}

export function linksConfig(): {
  template: string;
  by_profile: Record<string, string>;
  defaults: Defaults;
} {
  const l = readJson<Record<string, any>>(LINKS_F, {});
  return {
    template: l.template ?? "{link}\n\nDone ✅",
    by_profile: (l.by_profile ?? {}) as Record<string, string>,
    defaults: {
      max_parallel: Number(l.defaults?.max_parallel ?? 6),
      max_minutes: Number(l.defaults?.max_minutes ?? 45),
      shot_every: Number(l.defaults?.shot_every ?? 20),
      dry_run: Boolean(l.defaults?.dry_run),
      send_message: l.defaults?.send_message !== false,
      force: l.defaults?.force !== false,
      tile: (l.defaults?.tile ?? "6x3") as Defaults["tile"],
    },
  };
}

/** Merge-write links.json, preserving the readme + any other keys. */
export function saveLinksConfig(next: {
  by_profile?: Record<string, string>;
  template?: string;
  defaults?: Partial<Defaults>;
}) {
  const cur = readJson<Record<string, any>>(LINKS_F, {});
  const out = {
    ...cur,
    template: next.template ?? cur.template ?? "{link}\n\nDone ✅",
    by_profile: { ...(cur.by_profile ?? {}), ...(next.by_profile ?? {}) },
    defaults: { ...(cur.defaults ?? {}), ...(next.defaults ?? {}) },
  };
  writeJson(LINKS_F, out);
  return out;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ReportRow = {
  key: string;
  handle: string | null;
  status: string;
  processed: number;
  messaged: number;
  skipped: number;
  reposted: number;
  seconds: number;
  error?: string | null;
  link?: string | null;
};

export type RunReport = {
  job?: string | null;
  running: boolean;
  updated: number;
  summary: Record<string, number | string>;
  rows: ReportRow[];
};

/**
 * Per-profile report (done / skipped / messaged) that the controller writes to
 * logs/last_run.json — live during a run, final once it finishes.  Prefer the
 * bridge copy (always fresh); fall back to reading the file directly.
 */
export async function runReport(): Promise<RunReport | null> {
  const fromBridge = await bridge<{ ok: boolean; report: RunReport | null }>("/result");
  if (fromBridge?.report) return fromBridge.report;
  return readJson<RunReport | null>(RUN_JSON_F, null);
}

export function runState(): RunState {
  const lock = readJson<{ pid?: number; ts?: number } | null>(LOCK_F, null);
  if (lock?.pid && pidAlive(lock.pid)) {
    const started = (lock.ts ?? 0) * 1000;
    return {
      running: true,
      pid: lock.pid,
      startedAt: new Date(started).toISOString(),
      ageMin: Math.max(0, Math.round((Date.now() - started) / 60000)),
    };
  }
  return { running: false };
}

/** Talk to the controller's local bridge (port 9411). */
export async function bridge<T>(p: string): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(BRIDGE + p, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── persistent worker: per-profile START / STOP / CLEAR ─────────────────────
/**
 * The controller also runs in WORKER mode: one long-lived process that holds
 * the bridge open and accepts per-profile commands. Without it there is
 * nothing to send a single profile's START to, so every per-profile action
 * boots it first. Spawned detached, so it outlives this request AND the panel
 * itself — the old one-shot controller was a child of the agent session and
 * died with it, which is why repostops.xyz kept going down.
 */
export type WorkerSnap = {
  ok: boolean;
  worker: boolean;
  running: Record<string, { slot: string; ts: number; age: number }>;
  stopped: string[];
  done: string[];
  slots: string[];
};

async function bridgePost<T>(p: string, body: unknown, timeoutMs = 20000): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(BRIDGE + p, {
      method: "POST",
      signal: ctl.signal,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    clearTimeout(t);
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Live per-profile state from the bridge (null when the engine is down). */
export async function workerProfiles(): Promise<WorkerSnap | null> {
  const w = await bridge<WorkerSnap>("/profiles");
  return w?.ok ? w : null;
}

export async function workerUp(): Promise<boolean> {
  const h = await bridge<{ ok: boolean }>("/health");
  return Boolean(h?.ok);
}

/** Bring the persistent controller up if it is not already listening. */
export async function ensureWorker(): Promise<{
  ok: boolean;
  started: boolean;
  pid?: number;
  error?: string;
}> {
  if (await workerUp()) return { ok: true, started: false };
  try {
    fs.rmSync(STOP_F, { force: true });
  } catch {}
  try {
    fs.mkdirSync(path.join(XFLOW_DIR, "logs"), { recursive: true });
    const out = fs.openSync(LOG_F, "a");
    const child = spawn(PYTHON, [path.join(XFLOW_DIR, "controller.py"), "--serve"], {
      cwd: XFLOW_DIR,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8:replace",
        PYTHONUTF8: "1",
      },
    });
    child.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await workerUp()) return { ok: true, started: true, pid: child.pid };
    }
    return { ok: false, started: true, pid: child.pid, error: "engine did not come up" };
  } catch (e) {
    return { ok: false, started: false, error: (e as Error).message };
  }
}

export type ProfileStartOpts = {
  byProfile?: Record<string, string>;
  template?: string;
  autopilot?: boolean;
  batch?: number;
  force?: boolean;
  dry_run?: boolean;
  defaults?: Partial<Defaults>;
};

/** START one or many profiles. One key = just that profile. */
export async function startProfiles(
  keys: string[],
  opts: ProfileStartOpts = {}
): Promise<{ ok: boolean; error?: string; started?: string[]; busy?: string[] }> {
  if (!keys?.length) return { ok: false, error: "no profiles" };
  if (opts.byProfile) {
    const missing = keys.filter((k) => !String(opts.byProfile![k] ?? "").trim());
    if (missing.length) return { ok: false, error: `missing link for: ${missing.join(", ")}` };
    saveLinksConfig({ by_profile: opts.byProfile, template: opts.template });
  }
  const w = await ensureWorker();
  if (!w.ok) return { ok: false, error: w.error ?? "engine did not start" };
  const d = { ...linksConfig().defaults, ...(opts.defaults ?? {}) };
  const res = await bridgePost<{
    ok: boolean;
    started?: string[];
    skipped_busy?: string[];
    err?: string;
  }>("/job/start", {
    profiles: keys,
    batch: opts.autopilot ? opts.batch ?? d.max_parallel ?? 6 : 0,
    force: opts.force ?? d.force,
    dry_run: opts.dry_run ?? d.dry_run,
    defaults: {
      max_parallel: d.max_parallel,
      max_minutes_per_profile: d.max_minutes,
      tile: d.tile,
      send_message: d.send_message,
    },
  });
  if (!res) return { ok: false, error: "engine (bridge) not reachable" };
  if (!res.ok) return { ok: false, error: res.err ?? "already running", busy: res.skipped_busy };
  return { ok: true, started: res.started, busy: res.skipped_busy };
}

/** STOP the given profiles; call with [] to stop everything. */
export async function stopProfiles(keys: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!(await workerUp())) return { ok: false, error: "engine not running" };
  const res = await bridgePost<{ ok: boolean }>("/job/stop", { profiles: keys ?? [] });
  return res?.ok ? { ok: true } : { ok: false, error: "stop failed" };
}

/**
 * CLEAR one profile: stop it, drop its link, wipe its dedupe/disabled state and
 * close its browser window — that one account's bot is back to factory.
 */
export async function clearProfile(
  key: string
): Promise<{ ok: boolean; error?: string; detail?: unknown }> {
  const w = await ensureWorker();
  if (!w.ok) return { ok: false, error: w.error ?? "engine did not start" };
  // Forget it in the panel's own links.json too, so the row's box goes blank.
  const cur = readJson<Record<string, any>>(LINKS_F, {});
  const bp = { ...(cur.by_profile ?? {}) };
  if (key in bp) {
    delete bp[key];
    writeJson(LINKS_F, { ...cur, by_profile: bp });
  }
  const res = await bridgePost<{ ok: boolean; cleared?: unknown }>(
    "/job/clear",
    { profiles: [key] },
    40000
  );
  if (!res) return { ok: false, error: "engine (bridge) not reachable" };
  return { ok: res.ok, detail: res.cleared };
}

/**
 * Live run state, worker-aware: with the persistent controller run.lock is
 * never written, so "running" now means "how many profiles are working".
 */
export async function runStateLive(): Promise<RunState> {
  const w = await workerProfiles();
  if (w) {
    const keys = Object.keys(w.running ?? {});
    const ts = keys.map((k) => w.running[k].ts).sort()[0];
    return {
      running: keys.length > 0,
      count: keys.length,
      keys,
      worker: true,
      startedAt: ts ? new Date(ts * 1000).toISOString() : undefined,
      ageMin: ts ? Math.round((Date.now() / 1000 - ts) / 60) : 0,
    };
  }
  return { ...runState(), worker: false };
}

export function logTail(lines = 50): string {
  try {
    const txt = fs.readFileSync(LOG_F, "utf8");
    return txt.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Is Surfshark currently routing us through Singapore? (best-effort) */
export function vpnHint(): string | null {
  const t = logTail(400);
  if (/VPN OK — egress country is Singapore/.test(t)) return "singapore";
  if (/VPN FAILED/.test(t)) return "failed";
  return null;
}

export type StartInput = {
  profileKeys: string[];
  byProfile: Record<string, string>;
  template?: string;
  defaults?: Partial<Defaults>;
  /** Autopilot: run the whole list in sequential slots, auto-advancing. */
  autopilot?: boolean;
  /** Slot size for autopilot (defaults to max_parallel, i.e. 6). */
  batch?: number;
};

/**
 * Launch a run fully detached, so it survives the HTTP request and the phone
 * can be locked/closed.  Writes the picked links to links.json first, so a
 * crash mid-run can be resumed with the same mapping.
 */
export function startRun(input: StartInput): { ok: boolean; error?: string; pid?: number } {
  const st = runState();
  if (st.running) return { ok: false, error: `a run is already active (pid ${st.pid})` };
  if (!input.profileKeys?.length) return { ok: false, error: "no profiles selected" };

  const missing = input.profileKeys.filter((k) => !String(input.byProfile[k] ?? "").trim());
  if (missing.length) return { ok: false, error: `missing link for: ${missing.join(", ")}` };

  saveLinksConfig({ by_profile: input.byProfile, template: input.template });

  const d = { ...linksConfig().defaults, ...(input.defaults ?? {}) };
  const args = [
    path.join(XFLOW_DIR, "controller.py"),
    "--profiles",
    ...input.profileKeys,
    "--tile",
    d.tile,
    "--parallel",
    String(d.max_parallel),
    "--max-minutes",
    String(d.max_minutes),
    "--shot-every",
    String(d.shot_every),
  ];
  if (d.force) args.push("--force");
  if (d.dry_run) args.push("--dry-run");
  if (!d.send_message) args.push("--none");
  // Autopilot: one START, then the controller runs the list in sequential slots
  // of `batch` (6), closing each slot's windows before starting the next.
  if (input.autopilot) {
    args.push("--batch", String(input.batch ?? d.max_parallel ?? 6));
  }

  // never let a leftover stop flag kill the run we are about to launch
  try {
    fs.rmSync(STOP_F, { force: true });
  } catch {}

  try {
    fs.mkdirSync(path.join(XFLOW_DIR, "logs"), { recursive: true });
    const out = fs.openSync(LOG_F, "a");
    const child = spawn(PYTHON, args, {
      cwd: XFLOW_DIR,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        // stdout/stderr go to a file handle, so Python falls back to the
        // Windows locale codec (cp1252) and any emoji in a log line (✅ ⚠️ ❌)
        // raises UnicodeEncodeError, which kills each profile. Force UTF-8.
        PYTHONIOENCODING: "utf-8:replace",
        PYTHONUTF8: "1",
      },
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type AutopilotSnap = {
  job: string;
  active: boolean;
  batch: number;
  batches: number;
  total_profiles: number;
  profiles_done: number;
  processed: number;
  messaged: number;
  updated: number;
};

/**
 * Autopilot progress: which slot of how many. `active` is forced false whenever
 * no run is live, so a crashed run can never show as still running.
 */
export function autopilotState(runningOverride?: boolean): AutopilotSnap | null {
  const ap = readJson<AutopilotSnap | null>(AUTO_F, null);
  if (!ap) return null;
  const live = runningOverride ?? runState().running;
  if (ap.active && !live) ap.active = false;
  return ap;
}

function cleanupStop() {
  try {
    fs.rmSync(STOP_F, { force: true });
  } catch {}
  // drop a lock left behind by a process that is already gone
  const lock = readJson<{ pid?: number } | null>(LOCK_F, null);
  if (lock?.pid && !pidAlive(lock.pid)) {
    try {
      fs.rmSync(LOCK_F, { force: true });
    } catch {}
  }
}

/**
 * Stop a live run — cooperatively.
 *
 * On Windows a Node SIGTERM becomes a hard TerminateProcess: the Python
 * controller never gets to run its `finally` block, so the browser windows stay
 * open and the in-page extension keeps working (this is why STOP looked like it
 * "did nothing").  So instead we:
 *   1. write stop.flag AND ping the controller's bridge /stop — every worker
 *      thread sees it and unwinds gracefully (extensions told to stop, windows
 *      closed, lock removed);
 *   2. wait up to ~12s for the process to actually exit;
 *   3. only as a last resort, `taskkill /T /F` the whole process tree.
 */
export async function stopRun(): Promise<{
  ok: boolean;
  error?: string;
  pid?: number;
  forced?: boolean;
}> {
  const st = runState();
  const lock = readJson<{ pid?: number } | null>(LOCK_F, null);
  const pid = st.pid ?? lock?.pid;
  if (!pid) return { ok: false, error: "no active run" };

  try {
    fs.writeFileSync(STOP_F, JSON.stringify({ ts: Date.now() / 1000, by: "panel" }), "utf8");
  } catch {}

  // The bridge only exists while the controller is up; ignore connection errors.
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    await fetch(BRIDGE + "/stop", { method: "POST", signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
  } catch {}

  for (let i = 0; i < 24; i++) {
    if (!pidAlive(pid)) {
      cleanupStop();
      return { ok: true, pid };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch {}
  cleanupStop();
  return { ok: true, pid, forced: true };
}
