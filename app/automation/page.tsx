"use client";

import { useCallback, useEffect, useState } from "react";
import AutomationConsole from "./AutomationConsole";

type Gate = {
  configured: boolean;
  username: string | null;
  authed: boolean;
};

export default function AutomationPage() {
  const [gate, setGate] = useState<Gate | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/automation/auth", { cache: "no-store" });
      const j: Gate = await r.json();
      setGate(j);
      if (j.configured && !j.authed && j.username) setUsername(j.username);
    } catch {
      setGate({ configured: false, username: null, authed: false });
      setError("Network error");
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!gate) return;
    setError("");

    const setup = !gate.configured;
    if (setup && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/automation/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: setup ? "setup" : "login", username, password }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "Failed");
        setBusy(false);
        return;
      }
      setPassword("");
      setConfirm("");
      await check();
    } catch {
      setError("Network error");
    }
    setBusy(false);
  }

  const logout = useCallback(async () => {
    await fetch("/api/automation/auth", { method: "DELETE" });
    setGate((g) => (g ? { ...g, authed: false } : g));
    setUsername("");
    setPassword("");
    await check();
  }, [check]);

  if (!gate) {
    return <div className="p-6 text-gray-400">Loading…</div>;
  }

  if (gate.authed) {
    return <AutomationConsole username={gate.username} onLogout={logout} />;
  }

  const setup = !gate.configured;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-sm">
        <h1 className="text-xl font-bold mb-1">Automation</h1>
        <p className="text-gray-400 text-sm mb-6">
          {setup ? (
            <>
              Private area. This is the <strong>first login</strong> — the ID and password
              you set here are saved and asked for every time after.
            </>
          ) : (
            <>Private area. Enter your ID and password.</>
          )}
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input
            className="input"
            type="text"
            autoComplete={setup ? "off" : "username"}
            placeholder="ID"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            className="input"
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            placeholder={setup ? "Password (min 6 chars)" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {setup && (
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button className="btn btn-primary w-full justify-center" disabled={busy}>
            {busy ? "Please wait…" : setup ? "Set ID & password" : "Log in"}
          </button>
        </form>
        <p className="text-[11px] text-gray-500 mt-4">
          This is separate from the panel login. Automation only — nothing here is public.
        </p>
      </div>
    </div>
  );
}
