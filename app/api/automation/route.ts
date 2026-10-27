import { json } from "@/lib/reqAuth";
import { hasAutomationSession } from "@/lib/automation-auth";
import {
  bridge,
  clearProfile,
  linksConfig,
  runReport,
  runStateLive,
  startProfiles,
  stopProfiles,
  autopilotState,
  targets,
  logTail,
  type Defaults,
} from "@/lib/xflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LiveSlot = {
  slot: string;
  handle: string;
  progress: number;
  messaged: number;
  skipped: number;
  reposted: number;
  status: string;
  live: boolean;
};

type Live = {
  ok: boolean;
  total: number;
  beats: number;
  slots: LiveSlot[];
};

/** Automation is a SEPARATE door: its own ID + password, not the panel login. */
async function requireAutomation(req: Request) {
  if (!(await hasAutomationSession(req))) {
    return { error: json({ error: "Automation login required" }, 401) };
  }
  return { ok: true as const };
}

/** Full state for the automation console: roster + links + live progress + report. */
export async function GET(req: Request) {
  const guard = await requireAutomation(req);
  if ("error" in guard) return guard.error;

  const cfg = linksConfig();
  const [run, live, report] = await Promise.all([
    runStateLive(),
    bridge<Live>("/live"),
    runReport(),
  ]);
  const working = new Set(run.keys ?? []);

  // Match a live slot to a roster row by handle; keep the last-known numbers in
  // the report as a fallback so a row never drops back to zero between runs.
  // Handles are compared case-insensitively: the controller reads the handle
  // straight off the logged-in X page, so casing (@GayOnStreet vs @gayonstreet)
  // differs from targets.json and an exact match would silently drop live rows.
  const norm = (h: string) => h.trim().toLowerCase();
  const byHandle = new Map((live?.slots ?? []).map((s) => [norm(s.handle), s]));
  const repByKey = new Map((report?.rows ?? []).map((r) => [r.key, r]));

  return json({
    roster: targets().map((t) => {
      const l = byHandle.get(norm(t.handle));
      const rep = repByKey.get(t.key);
      return {
        ...t,
        link: cfg.by_profile[t.key] ?? "",
        progress: l?.progress ?? rep?.processed ?? 0,
        messaged: l?.messaged ?? rep?.messaged ?? 0,
        skipped: l?.skipped ?? rep?.skipped ?? 0,
        status: l?.status ?? rep?.status ?? "",
        // per-profile START/STOP/CLEAR state for this row
        working: working.has(t.key),
        live: l?.live ?? false,
      };
    }),
    template: cfg.template,
    defaults: cfg.defaults,
    run,
    live: live ? { total: live.total, beats: live.beats } : null,
    bridgeUp: Boolean(live),
    report,
    autopilot: autopilotState(run.running),
    log: logTail(30),
  });
}

/**
 * One endpoint for every action:
 *   { action: "start", profileKeys, byProfile?, template?, defaults? }
 *   { action: "stop",  profileKeys }   // [] = stop every profile
 *   { action: "clear", profileKeys }   // stop + forget link/state + close window
 * `action` defaults to "start", so the old call shape still works.
 */
export async function POST(req: Request) {
  const guard = await requireAutomation(req);
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "start");
  const profileKeys: string[] = body?.profileKeys ?? [];
  const byProfile: Record<string, string> = body?.byProfile ?? {};
  const keys = Array.isArray(profileKeys) ? profileKeys : [];

  if (action === "stop") {
    const res = await stopProfiles(keys);
    if (!res.ok) return json({ error: res.error }, 409);
    return json({ ok: true, stopped: keys.length ? keys : "all" });
  }

  if (action === "clear") {
    if (!keys.length) return json({ error: "profileKeys required" }, 400);
    const cleared = [];
    for (const k of keys) cleared.push({ key: k, ...(await clearProfile(k)) });
    return json({ ok: cleared.every((c) => c.ok), cleared });
  }

  // start
  if (!keys.length) return json({ error: "profileKeys required" }, 400);
  const res = await startProfiles(keys, {
    byProfile,
    template: typeof body?.template === "string" ? body.template : undefined,
    defaults: (body?.defaults ?? undefined) as Partial<Defaults> | undefined,
    autopilot: body?.autopilot === true,
    batch: typeof body?.batch === "number" ? body.batch : undefined,
  });
  if (!res.ok) return json({ error: res.error, busy: res.busy }, 409);
  return json({ ok: true, started: res.started, busy: res.busy });
}

/** STOP everything (the sticky bar's STOP button). */
export async function DELETE(req: Request) {
  const guard = await requireAutomation(req);
  if ("error" in guard) return guard.error;

  // Only the PROFILES stop — the persistent worker (the engine itself) must
  // survive, or the whole console would go dark after one STOP.
  const res = await stopProfiles([]);
  if (!res.ok) return json({ error: res.error }, 409);
  return json({ ok: true, stopped: "all" });
}
