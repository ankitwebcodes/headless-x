"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Row = {
  slot: number;
  n: number;
  name: string;
  key: string;
  handle: string;
  link: string;
  progress: number;
  messaged: number;
  skipped: number;
  status: string;
  /** this account is being worked right now (per-profile START) */
  working: boolean;
  live: boolean;
};

type ReportRow = {
  key: string;
  handle: string | null;
  status: string;
  processed: number;
  messaged: number;
  skipped: number;
  seconds: number;
  error?: string | null;
};

type Report = {
  job?: string | null;
  running: boolean;
  updated: number;
  summary: Record<string, number | string>;
  rows: ReportRow[];
} | null;

type Defaults = {
  max_parallel: number;
  max_minutes: number;
  shot_every: number;
  dry_run: boolean;
  send_message: boolean;
  force: boolean;
  tile: "6x3" | "8x4" | "8x2x2";
};

type AutopilotSnap = {
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

type State = {
  roster: Row[];
  template: string;
  defaults: Defaults;
  run: {
    running: boolean;
    pid?: number;
    startedAt?: string;
    ageMin?: number;
    count?: number;
    keys?: string[];
    worker?: boolean;
  };
  live: { total: number; beats: number } | null;
  bridgeUp: boolean;
  report: Report;
  autopilot: AutopilotSnap | null;
  log: string;
};

const API = "/api/automation";

const STATUS_ICON: Record<string, string> = {
  done: "✅",
  partial: "⚠️",
  failed: "❌",
  skipped: "⏭",
  dry: "🧪",
  stopped: "⏹",
};

export default function AutomationConsole({
  username,
  onLogout,
}: {
  username: string | null;
  onLogout: () => void;
}) {
  const [st, setSt] = useState<State | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState("");
  const [d, setD] = useState<Defaults | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [shotN, setShotN] = useState(0);
  const [auto, setAuto] = useState(true);
  /** which row's Start/Stop/Clear is mid-flight (locks just that row) */
  const [rowBusy, setRowBusy] = useState<string>("");

  const load = useCallback(async () => {
    const r = await fetch(API, { cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      onLogout();
      return;
    }
    const data: State = await r.json();
    setSt(data);
    setTemplate((t) => t || data.template);
    setD((x) => x ?? data.defaults);
    setLinks((l) => {
      const merged: Record<string, string> = {};
      for (const row of data.roster) merged[row.key] = l[row.key] ?? row.link ?? "";
      return merged;
    });
  }, [onLogout]);

  useEffect(() => {
    load();
  }, [load]);

  const running = st?.run.running ?? false;

  useEffect(() => {
    const ms = running ? 10000 : 30000;
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, running]);

  const filled = useMemo(
    () => sel.filter((k) => (links[k] ?? "").trim().length > 0),
    [sel, links]
  );

  function toggle(key: string) {
    setSel((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));
  }

  function selectFirst() {
    if (!st || !d) return;
    const take = st.roster.slice(0, d.max_parallel).map((r) => r.key);
    setSel(take);
    const l = { ...links };
    for (const r of st.roster.slice(0, d.max_parallel)) {
      if (!(l[r.key] ?? "").trim() && r.link) l[r.key] = r.link;
    }
    setLinks(l);
  }

  function selectAll() {
    if (!st) return;
    const l = { ...links };
    for (const r of st.roster) {
      if (!(l[r.key] ?? "").trim() && r.link) l[r.key] = r.link;
    }
    setSel(st.roster.map((r) => r.key));
    setLinks(l);
  }

  async function start() {
    if (!d) return;
    if (!filled.length) {
      setMsg("Put a link against at least one account.");
      return;
    }
    if (!auto && filled.length > d.max_parallel) {
      setMsg(`You picked ${filled.length} accounts but parallelism is ${d.max_parallel}. Raise it or deselect.`);
      return;
    }
    setBusy(true);
    setMsg("Starting…");
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileKeys: filled,
          byProfile: Object.fromEntries(filled.map((k) => [k, (links[k] ?? "").trim()])),
          template,
          defaults: d,
          autopilot: auto,
          batch: d.max_parallel,
        }),
      });
      const j = await r.json();
      setMsg(
        r.ok
          ? auto && filled.length > d.max_parallel
            ? `Autopilot started — ${(j.started ?? filled).length} accounts, slots of ${d.max_parallel}, auto-advancing. Runs on the PC even if you close this tab. VPN must be on Singapore.`
            : `Started ${(j.started ?? filled).length} account(s) — they keep running on the PC even if you close this tab. VPN must be on Singapore.`
          : `❌ ${j.error}`
      );
      setTimeout(load, 1200);
    } catch {
      setMsg("❌ Network error");
    }
    setBusy(false);
  }

  /**
   * Per-profile control: only THIS account is touched.
   *   start -> it begins working (and stays working while others are idle)
   *   stop  -> it halts, its window closes
   *   clear -> stop + drop its link + wipe its bot memory + close its window
   */
  async function profileAction(key: string, action: "start" | "stop" | "clear") {
    const short = key.split(":")[1] ?? key;
    if (action === "start" && !(links[key] ?? "").trim()) {
      setMsg(`Put a link in ${short}'s box first.`);
      return;
    }
    setRowBusy(key);
    setMsg(
      action === "start"
        ? `▶ ${short} — starting…`
        : action === "stop"
          ? `⏹ ${short} — stopping…`
          : `🧹 ${short} — clearing link, bot memory and window…`
    );
    try {
      const body: Record<string, unknown> = { action, profileKeys: [key] };
      if (action === "start") {
        body.byProfile = { [key]: (links[key] ?? "").trim() };
        body.template = template;
        body.autopilot = false;
        body.defaults = { ...d, max_parallel: 6 };
      }
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) setMsg(`❌ ${j.error}`);
      else if (action === "start")
        setMsg(
          `▶ ${short} started — it works on its own, on the PC, while you do other things. VPN must be on Singapore.`
        );
      else if (action === "stop") setMsg(`⏹ ${short} stopped.`);
      else
        setMsg(
          `🧹 ${short} cleared — link dropped, bot memory reset, window closed.`,
        );
      setTimeout(load, 1500);
    } catch {
      setMsg("❌ Network error");
    }
    setRowBusy("");
  }

  async function stop() {
    setBusy(true);
    setMsg("Stopping… (the run halts and its windows close)");
    const r = await fetch(API, { method: "DELETE" });
    const j = await r.json();
    setMsg(
      r.ok
        ? j.forced
          ? "Stopped — the run was wedged, so it was force-killed."
          : "Stopped — run halted, windows closing."
        : `❌ ${j.error}`
    );
    setTimeout(load, 2500);
    setBusy(false);
  }

  if (!st || !d) {
    return <div className="p-6 text-gray-400">Loading…</div>;
  }

  return (
    <div className="min-h-screen pb-40">
      {/* header */}
      <div className="sticky top-0 z-20 bg-black/85 backdrop-blur border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold leading-tight">Automation</h1>
            <p className="text-[11px] text-gray-400">
              {running ? (
                <span className="text-green-400">
                  ● {st.run.count ?? 1} account{(st.run.count ?? 1) === 1 ? "" : "s"}{" "}
                  working
                  {st.run.worker
                    ? " · engine live"
                    : st.run.pid
                      ? ` · pid ${st.run.pid}`
                      : ""}
                  {st.live ? ` · ${st.live.total} processed` : ""}
                </span>
              ) : (
                <span>
                  ○ idle{st.run.worker ? " · engine live (ready)" : " · engine asleep"}
                </span>
              )}
              {" · "}
              bridge {st.bridgeUp ? "up" : "down"}
              {username ? ` · ${username}` : ""}
            </p>
          </div>
          <button className="btn text-xs" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {/* settings */}
        <div className="card space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {([
              ["max_parallel", "Parallel"],
              ["max_minutes", "Max min"],
              ["shot_every", "Shot/min"],
            ] as const).map(([k, label]) => (
              <label key={k} className="text-[11px] text-gray-400">
                {label}
                <input
                  className="input mt-1"
                  type="number"
                  inputMode="numeric"
                  value={d[k] as number}
                  onChange={(e) => setD({ ...d, [k]: Number(e.target.value || 0) })}
                />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={d.tile === "6x3"}
              onChange={(e) => setD({ ...d, tile: e.target.checked ? "6x3" : "8x4" })}
            />
            tile 6-up (2 monitors × 3)
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            🤖 autopilot — every account in slots of {d.max_parallel}, auto-advancing to the
            next slot until all are done
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={d.dry_run}
              onChange={(e) => setD({ ...d, dry_run: e.target.checked })}
            />
            dry run (prepare only, never press START)
          </label>
          <label className="text-[11px] text-gray-400 block">
            Message template — {"{link}"} inserted per account
            <textarea
              className="input mt-1 font-mono text-xs"
              rows={2}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </label>
        </div>

        {/* live shot */}
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Live view</span>
            <button
              className="btn text-xs"
              onClick={async () => {
                setMsg("Capturing…");
                await fetch(`${API}/shot`, { method: "POST" });
                setShotN((n) => n + 1);
                setMsg("");
              }}
            >
              Refresh shot
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={shotN}
            src={`${API}/shot?t=${shotN}`}
            alt="live montage"
            className="w-full rounded border border-white/10"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        </div>

        {/* per-profile report — done / skipped / messaged, per account */}
        {st.report && st.report.rows.length > 0 && (
          <div className="card space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">
                Report{st.report.job ? ` · ${st.report.job}` : ""}{" "}
                <span className="text-gray-500">
                  {st.report.running ? "(live)" : "(finished)"}
                </span>
              </span>
              <span className="text-[11px] text-gray-500">
                {Number(st.report.summary?.processed ?? 0)} done ·{" "}
                {Number(st.report.summary?.messaged ?? 0)} msg ·{" "}
                {Number(st.report.summary?.failed ?? 0)} failed
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-left font-normal">account</th>
                    <th className="text-right font-normal">done</th>
                    <th className="text-right font-normal">msg</th>
                    <th className="text-right font-normal">skip</th>
                    <th className="text-right font-normal">min</th>
                  </tr>
                </thead>
                <tbody>
                  {st.report.rows.map((r) => (
                    <tr key={r.key} className="border-t border-white/5 align-top">
                      <td className="py-1 pr-2">
                        <span className="mr-1">{STATUS_ICON[r.status] ?? "•"}</span>
                        {r.handle || r.key}
                        {r.error && (
                          <span className="block text-[10px] text-red-400/80">
                            {r.error}
                          </span>
                        )}
                      </td>
                      <td className="text-right">{r.processed}</td>
                      <td className="text-right">{r.messaged}</td>
                      <td className="text-right text-gray-400">{r.skipped}</td>
                      <td className="text-right text-gray-400">
                        {Math.round((r.seconds || 0) / 60)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* autopilot progress */}
        {st.autopilot?.active && (
          <div className="card border-indigo-400/40 bg-indigo-500/5 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-indigo-300">
                🤖 Autopilot — slot {st.autopilot.batch}/{st.autopilot.batches}
              </span>
              <span className="text-gray-400">
                {st.autopilot.profiles_done}/{st.autopilot.total_profiles} accounts
              </span>
            </div>
            <div className="h-1.5 w-full rounded bg-white/10 overflow-hidden">
              <div
                className="h-full bg-indigo-400"
                style={{
                  width: `${Math.round(
                    (st.autopilot.profiles_done / Math.max(1, st.autopilot.total_profiles)) * 100
                  )}%`,
                }}
              />
            </div>
            <div className="text-[11px] text-gray-400">
              {st.autopilot.processed} chats done · {st.autopilot.messaged} messages · the
              next slot starts on its own
            </div>
          </div>
        )}

        {/* roster */}
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">
              Accounts ({sel.length} selected, {filled.length} with link)
              <span className="block text-[10px] text-gray-500">
                ▶ starts just that account · ⏹ stops it · 🧹 clears its link + resets
                the bot + closes its window
              </span>
            </span>
            <div className="flex gap-2">
              <button className="btn text-xs" onClick={selectFirst}>
                First {d.max_parallel}
              </button>
              <button className="btn text-xs" onClick={selectAll}>
                All
              </button>
              <button className="btn text-xs" onClick={() => setSel([])}>
                Clear
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {st.roster.map((r) => {
              const on = sel.includes(r.key);
              return (
                <div
                  key={r.key}
                  className={`rounded-lg border p-2 ${
                    on ? "border-indigo-400/60 bg-indigo-500/5" : "border-white/10"
                  }`}
                >
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={on} onChange={() => toggle(r.key)} />
                    <span className="text-sm font-semibold">{r.handle || r.name}</span>
                    <span className="text-[10px] text-gray-500">{r.key}</span>
                    {(r.progress > 0 || r.messaged > 0) && (
                      <span className="ml-auto text-[10px] text-green-400">
                        {r.progress} done · {r.messaged} msg
                        {r.skipped > 0 ? ` · ${r.skipped} skip` : ""}
                      </span>
                    )}
                    {r.live && <span className="text-[10px] text-green-400">●</span>}
                    {r.working && (
                      <span className="text-[10px] font-semibold text-green-400">
                        ● working
                      </span>
                    )}
                  </label>
                  <input
                    className="input mt-2 text-xs"
                    type="url"
                    inputMode="url"
                    placeholder="https://x.com/…/status/…"
                    value={links[r.key] ?? ""}
                    onChange={(e) => setLinks({ ...links, [r.key]: e.target.value })}
                  />
                  {/* per-profile control: this account only */}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className="btn text-[11px] px-2 py-1"
                      disabled={busy || rowBusy === r.key || r.working}
                      onClick={() => profileAction(r.key, "start")}
                    >
                      ▶ Start
                    </button>
                    <button
                      className="btn text-[11px] px-2 py-1"
                      disabled={busy || rowBusy === r.key || !r.working}
                      onClick={() => profileAction(r.key, "stop")}
                    >
                      ⏹ Stop
                    </button>
                    <button
                      className="btn text-[11px] px-2 py-1"
                      disabled={busy || rowBusy === r.key}
                      onClick={() => profileAction(r.key, "clear")}
                    >
                      🧹 Clear
                    </button>
                    {rowBusy === r.key && (
                      <span className="text-[10px] text-amber-300">working…</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* log */}
        <div className="card">
          <div className="text-xs text-gray-400 mb-1">Controller log</div>
          <pre className="text-[10px] leading-snug whitespace-pre-wrap text-gray-300 max-h-52 overflow-auto">
            {st.log || "(empty)"}
          </pre>
        </div>
      </div>

      {/* sticky actions */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-black/90 backdrop-blur border-t border-white/10 px-3 py-3">
        {msg && <p className="text-[11px] text-amber-300 mb-2">{msg}</p>}
        <div className="flex gap-2">
          <button
            className="btn btn-primary flex-1 justify-center"
            disabled={busy || running}
            onClick={start}
          >
            {running
              ? st.autopilot?.active
                ? `🤖 slot ${st.autopilot.batch}/${st.autopilot.batches}…`
                : "Run in progress…"
              : auto && filled.length > d.max_parallel
                ? `START ALL (${filled.length}) · slots of ${d.max_parallel}`
                : `START (${filled.length})`}
          </button>
          <button className="btn flex-1 justify-center" disabled={busy || !running} onClick={stop}>
            STOP
          </button>
        </div>
      </div>
    </div>
  );
}
