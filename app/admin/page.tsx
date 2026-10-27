"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

type Account = {
  id: string;
  handle: string;
  status: string;
  enabled: number;
  hasSession: boolean;
  hasOauth1: boolean;
  adsAccountId: string;
  defaultUrl: string;
  defaultTitle: string;
  defaultCaption: string | null;
  userId: string;
  createdAt: number;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  accounts: string[];
  createdAt: number;
};

type JobRow = {
  id: string;
  accountId: string;
  caption: string;
  url: string;
  status: string;
  tweetUrl: string | null;
  error: string | null;
  createdAt: number;
};

export default function AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"accounts" | "users" | "jobs">("accounts");
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);

  // modals
  const [showConnect, setShowConnect] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [assigning, setAssigning] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, u, j] = await Promise.all([
        fetch("/api/accounts").then((r) => r.json()),
        fetch("/api/users").then((r) => r.json()),
        fetch("/api/jobs").then((r) => r.json()),
      ]);
      setAccounts(a.accounts ?? []);
      setUsers(u.users ?? []);
      setJobs(j.jobs ?? []);
    } catch {
      setError("Failed to load data");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d?.user || d.user.role !== "admin") {
          router.replace("/dashboard");
          return;
        }
        setMe(d.user);
        load();
      })
      .catch(() => router.replace("/login"));
  }, [router, load]);

  const flash = (msg: string, isErr = false) => {
    setError(isErr ? msg : "");
    setNotice(isErr ? "" : msg);
    if (msg) setTimeout(() => { setNotice(""); setError(""); }, 6000);
  };

  const acctAction = async (id: string, action: string, extra?: object) => {
    const r = await fetch(`/api/accounts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = await r.json();
    if (!r.ok) flash(d.error ?? "Action failed", true);
    else flash(`✅ ${action} ok`);
    load();
    return d;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" style={{ width: 28, height: 28 }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      {/* header */}
      <div className="flex items-center justify-between mb-7 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            <span className="brand-gradient">Admin Console</span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {me?.email} — accounts, users and posts all live here
          </p>
        </div>
        <div className="flex gap-2">
          <a href="/dashboard" className="btn btn-ghost">← Dashboard</a>
          <button
            className="btn btn-ghost"
            onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); }}
          >
            Logout
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className="tabs mb-6">
        <button className={`tab ${tab === "accounts" ? "active" : ""}`} onClick={() => setTab("accounts")}>X Accounts ({accounts.length})</button>
        <button className={`tab ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}>Users ({users.length})</button>
        <button className={`tab ${tab === "jobs" ? "active" : ""}`} onClick={() => setTab("jobs")}>Posts ({jobs.length})</button>
      </div>

      {notice && <div className="card mb-4" style={{ borderColor: "rgba(16,185,129,.4)" }}><span className="text-emerald-400 text-sm font-semibold">{notice}</span></div>}
      {error && <div className="card mb-4" style={{ borderColor: "rgba(239,68,68,.4)" }}><span className="text-red-400 text-sm font-semibold">{error}</span></div>}

      {/* ============ ACCOUNTS ============ */}
      {tab === "accounts" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-3">
            <p className="text-sm text-slate-400 max-w-xl">
              Connect with the <b className="text-slate-200">X Grabber</b> browser extension: the user grabs their
              account in one click, sends you the copied text, you paste it below. Everything else is automatic.
            </p>
            <button className="btn btn-primary" onClick={() => setShowConnect(true)}>+ Connect Account</button>
          </div>

          {accounts.length === 0 && (
            <div className="card text-center py-12 text-slate-400">
              No accounts yet — click <b className="text-slate-200">+ Connect Account</b> and paste an X Grabber blob.
            </div>
          )}

          {accounts.map((a) => (
            <div key={a.id} className="card card-hover">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center font-extrabold text-sm"
                    style={{ background: "linear-gradient(135deg,#6d5efc,#9b5cfc)" }}
                  >
                    @{a.handle.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="font-bold">@{a.handle}</div>
                    <div className="flex gap-2 mt-1 flex-wrap">
                      <span className={`badge badge-${a.status}`}>{a.status}</span>
                      <span className={`badge ${a.enabled === 1 ? "badge-approved" : "badge-off"}`}>
                        {a.enabled === 1 ? "enabled" : "disabled"}
                      </span>
                      <span className="badge badge-off">{a.hasSession ? "session ✓" : "no session"}</span>
                      {a.hasOauth1 ? <span className="badge badge-off">oauth1</span> : null}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button className="btn btn-ghost" onClick={() => setEditing(a)}>Edit…</button>
                  <button className="btn btn-ghost" onClick={() => setAssigning(a)}>Assign…</button>
                  <button className="btn btn-ghost" onClick={async () => { flash("Testing…"); const d = await acctAction(a.id, "test"); if (d?.session?.ok) flash(`✅ @${a.handle} session LIVE`); else flash(`❌ @${a.handle} session DEAD — refresh this account`, true); }}>Test</button>
                  <button className={`btn ${a.enabled === 1 ? "btn-amber" : "btn-green"}`} onClick={() => acctAction(a.id, a.enabled === 1 ? "disable" : "enable")}>
                    {a.enabled === 1 ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="btn btn-red"
                    onClick={() => { if (confirm(`Delete @${a.handle}? This cannot be undone.`)) acctAction(a.id, "delete"); }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-3 text-xs text-slate-500">
                Assigned to: {users.find((u) => u.id === a.userId)?.email ?? a.userId.slice(0, 12) + "…"}
                {a.adsAccountId ? ` · ads: ${a.adsAccountId}` : ""}
                {a.defaultUrl ? ` · default link: ${a.defaultUrl}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============ USERS ============ */}
      {tab === "users" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-3">
            <p className="text-sm text-slate-400 max-w-xl">
              Create a login for each client, then assign them their X accounts (Accounts tab → Assign…).
              Their media library only shows their own accounts.
            </p>
            <button className="btn btn-primary" onClick={() => setShowCreateUser(true)}>+ Create User</button>
          </div>

          <div className="card overflow-x-auto">
            {users.length === 0 && <div className="text-slate-400 text-center py-8">No users yet.</div>}
            {users.length > 0 && (
              <table>
                <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Assigned accounts</th><th></th></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="font-semibold">{u.email}</td>
                      <td className="text-slate-400">{u.name}</td>
                      <td><span className={`badge ${u.role === "admin" ? "badge-approved" : "badge-queued"}`}>{u.role}</span></td>
                      <td className="text-slate-400">{u.accounts.length ? u.accounts.map((h) => "@" + h).join(", ") : "—"}</td>
                      <td>
                        {u.role !== "admin" && (
                          <button className="btn btn-red" onClick={() => { if (confirm(`Delete ${u.email}? Their accounts fall back to you.`)) {
                            fetch(`/api/users?id=${u.id}`, { method: "DELETE" }).then(() => { flash("✅ user deleted"); load(); });
                          } }}>Delete</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ============ JOBS ============ */}
      {tab === "jobs" && (
        <div className="card overflow-x-auto">
          {jobs.length === 0 && <div className="text-slate-400 text-center py-8">No posts yet.</div>}
          {jobs.length > 0 && (
            <table>
              <thead><tr><th>When</th><th>Account</th><th>Link</th><th>Status</th><th>Result</th></tr></thead>
              <tbody>
                {jobs.slice(0, 60).map((j) => (
                  <tr key={j.id}>
                    <td className="text-slate-400 text-xs">{new Date(j.createdAt).toLocaleString()}</td>
                    <td className="font-semibold">@{accounts.find((a) => a.id === j.accountId)?.handle ?? j.accountId.slice(0, 8)}</td>
                    <td className="text-slate-400 text-xs max-w-52 truncate">{j.url || "—"}</td>
                    <td><span className={`badge badge-${j.status}`}>{j.status}</span></td>
                    <td className="text-xs">
                      {j.tweetUrl ? (
                        <a className="text-indigo-400 font-semibold" href={j.tweetUrl} target="_blank">View post ↗</a>
                      ) : (
                        <span className="text-red-400">{(j.error ?? "").slice(0, 90)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ============ CONNECT MODAL (ONE FIELD) ============ */}
      {showConnect && (
        <ConnectModal
          onClose={() => setShowConnect(false)}
          onDone={async (note) => { setShowConnect(false); flash(note || "✅ account connected"); load(); }}
          flash={flash}
        />
      )}

      {/* ============ CREATE USER MODAL ============ */}
      {showCreateUser && (
        <CreateUserModal
          onClose={() => setShowCreateUser(false)}
          onDone={async (note) => { setShowCreateUser(false); flash(note); load(); }}
          flash={flash}
        />
      )}

      {/* ============ ASSIGN MODAL ============ */}
      {assigning && (
        <AssignModal
          account={assigning}
          users={users.filter((u) => u.role !== "admin")}
          onClose={() => setAssigning(null)}
          onDone={async (userId, note) => { setAssigning(null); await acctAction(assigning.id, "assign", { userId }); flash(note); }}
          flash={flash}
        />
      )}

      {/* ============ EDIT MODAL ============ */}
      {editing && (
        <EditModal
          account={editing}
          onClose={() => setEditing(null)}
          onDone={async (patch, note) => {
            setEditing(null);
            const d = await acctAction(editing.id, "update", patch);
            if (d?.ok) flash(note || "✅ account updated");
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

function ConnectModal({ onClose, onDone, flash }: { onClose: () => void; onDone: (note: string) => void; flash: (m: string, e?: boolean) => void }) {
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blob }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Connect failed"); setBusy(false); return; }
      onDone(d.note ?? "✅ connected");
    } catch {
      setErr("Network error");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h2 className="text-lg font-extrabold mb-1">Connect X Account</h2>
        <p className="text-xs text-slate-400 mb-4">
          Ask the user to install <b className="text-indigo-300">X Grabber</b> (Chrome/Brave extension), open x.com
          logged into their account, click <b className="text-indigo-300">GRAB</b> and send you the copied text.
          Paste it here — handle, cookies and verification are automatic.
        </p>
        <textarea
          className="input font-mono text-xs"
          placeholder='{"v":1,"kind":"xgrab","handle":"theirname","cookies":{...}}'
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          rows={8}
          required
        />
        {err && <p className="text-red-400 text-sm mt-2">{err}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !blob.trim()}>
            {busy ? <span className="spinner" /> : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

function CreateUserModal({ onClose, onDone, flash }: { onClose: () => void; onDone: (note: string) => void; flash: (m: string, e?: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const suggest = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let p = "";
    for (let i = 0; i < 14; i++) p += chars[Math.floor(Math.random() * chars.length)];
    setPassword(p);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Create failed"); setBusy(false); return; }
      onDone(`✅ user ${d.user.email} created — share the password with them, then assign accounts`);
    } catch {
      setErr("Network error");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h2 className="text-lg font-extrabold mb-4">Create User Login</h2>
        <div className="space-y-3">
          <input className="input" type="email" placeholder="their@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            <input className="input" type="text" placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            <button type="button" className="btn btn-ghost" onClick={suggest}>Generate</button>
          </div>
          {password && <p className="text-xs text-slate-400">Password to send them: <b className="text-indigo-300">{password}</b></p>}
        </div>
        {err && <p className="text-red-400 text-sm mt-2">{err}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : "Create"}</button>
        </div>
      </form>
    </div>
  );
}

function AssignModal({ account, users, onClose, onDone, flash }: {
  account: Account;
  users: UserRow[];
  onClose: () => void;
  onDone: (userId: string, note: string) => void;
  flash: (m: string, e?: boolean) => void;
}) {
  const [userId, setUserId] = useState("");

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="text-lg font-extrabold mb-1">Assign @{account.handle}</h2>
        <p className="text-xs text-slate-400 mb-4">Which user login can post to this account? Their media library will show only their own accounts.</p>
        <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">— pick a user —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.email} ({u.accounts.length} accounts)</option>
          ))}
        </select>
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!userId}
            onClick={() => {
              const u = users.find((x) => x.id === userId);
              if (u) onDone(u.id, `✅ @${account.handle} assigned to ${u.email}`);
              else flash("Pick a user", true);
            }}
          >
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}

function EditModal({ account, onClose, onDone, flash }: {
  account: Account;
  onClose: () => void;
  onDone: (patch: Record<string, unknown>, note?: string) => void;
  flash: (m: string, e?: boolean) => void;
}) {
  const [mode, setMode] = useState<"blob" | "fields">("blob");
  const [blob, setBlob] = useState("");
  const [sessionJson, setSessionJson] = useState("");
  const [oauth1Json, setOauth1Json] = useState("");
  const [defaultUrl, setDefaultUrl] = useState(account.defaultUrl || "");
  const [defaultTitle, setDefaultTitle] = useState(account.defaultTitle || "");
  const [defaultCaption, setDefaultCaption] = useState(account.defaultCaption || "");
  const [adsAccountId, setAdsAccountId] = useState(account.adsAccountId || "");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const patch: Record<string, unknown> = {};
    let note = `✅ @${account.handle} updated`;

    if (mode === "blob" && blob.trim()) {
      patch.blob = blob.trim();
      note = `✅ @${account.handle} refreshed from blob`;
    } else if (mode === "fields") {
      if (sessionJson.trim()) patch.sessionJson = sessionJson.trim();
      if (oauth1Json.trim()) patch.oauth1Json = oauth1Json.trim();
      if (defaultUrl !== account.defaultUrl) patch.defaultUrl = defaultUrl;
      if (defaultTitle !== account.defaultTitle) patch.defaultTitle = defaultTitle;
      if (defaultCaption !== (account.defaultCaption || "")) patch.defaultCaption = defaultCaption;
      if (adsAccountId !== account.adsAccountId) patch.adsAccountId = adsAccountId;
      if (!Object.keys(patch).length) {
        flash("Nothing to update", true);
        setBusy(false);
        return;
      }
    } else {
      flash("Paste a blob or switch to fields", true);
      setBusy(false);
      return;
    }

    onDone(patch, note);
    setBusy(false);
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} style={{ maxWidth: 520 }}>
        <h2 className="text-lg font-extrabold mb-1">Edit @{account.handle}</h2>
        <div className="flex gap-2 mb-4">
          <button type="button" className={`btn ${mode === "blob" ? "btn-primary" : "btn-ghost"}`} onClick={() => setMode("blob")}>Paste Blob</button>
          <button type="button" className={`btn ${mode === "fields" ? "btn-primary" : "btn-ghost"}`} onClick={() => setMode("fields")}>Fields</button>
        </div>

        {mode === "blob" && (
          <div>
            <p className="text-xs text-slate-400 mb-2">
              Paste the full X Grabber blob here — it refreshes cookies + OAuth1 in one shot.
              Current: {account.hasSession ? "session ✓" : "no session"} · {account.hasOauth1 ? "oauth1 ✓" : "no oauth1"}
            </p>
            <textarea
              className="input"
              style={{ minHeight: 120, fontFamily: "monospace", fontSize: 11 }}
              placeholder='{"v":2,"kind":"xgrab","handle":"...","cookies":{...},"oauth1":{...}}'
              value={blob}
              onChange={(e) => setBlob(e.target.value)}
            />
          </div>
        )}

        {mode === "fields" && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-400">Session JSON (cookies)</label>
              <textarea
                className="input"
                style={{ minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
                placeholder='[{"name":"auth_token",...}] or {"auth_token":"...",...}'
                value={sessionJson}
                onChange={(e) => setSessionJson(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">OAuth1 JSON</label>
              <textarea
                className="input"
                style={{ minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
                placeholder='{"consumer_key":"...","consumer_secret":"...","access_token":"...","access_token_secret":"..."}'
                value={oauth1Json}
                onChange={(e) => setOauth1Json(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400">Default URL</label>
                <input className="input" value={defaultUrl} onChange={(e) => setDefaultUrl(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-slate-400">Default Title</label>
                <input className="input" value={defaultTitle} onChange={(e) => setDefaultTitle(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400">Default Caption</label>
                <input className="input" value={defaultCaption} onChange={(e) => setDefaultCaption(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-slate-400">Ads Account ID</label>
                <input className="input" value={adsAccountId} onChange={(e) => setAdsAccountId(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
