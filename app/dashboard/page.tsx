"use client";

import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { uploadToBlob } from "@/lib/blob-upload";

type Acct = { id: string; handle: string; status: string; enabled: number; hasSession: boolean; defaultUrl: string; defaultTitle: string };
type MediaRow = { id: string; name: string; url: string; mediaType: string | null; mediaKey: string | null; accountId: string | null; createdAt: number };
type JobRow = { id: string; accountId: string; caption: string; status: string; tweetUrl: string | null; error: string | null; createdAt: number };
type BulkResult = { accountId: string; handle: string; status: string; tweetUrl: string | null; error: string | null; path?: string };

function domainOf(u: string): string {
  try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return u.slice(0, 40); }
}
function acctColor(h: string): string {
  const hues = [211, 262, 330, 24, 160, 190, 285, 45];
  let n = 0; for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0;
  const hue = hues[n % hues.length];
  return `hsl(${hue} 65% 40%)`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<{ email: string; role: string; name: string } | null>(null);
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const autoSel = useRef(false);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [libraryAccountId, setLibraryAccountId] = useState("");
  const [mediaTotal, setMediaTotal] = useState(0);
  const [picked, setPicked] = useState<MediaRow | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [caption, setCaption] = useState("");
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);
  const [bulkSummary, setBulkSummary] = useState<string>("");
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState<"composer" | "library" | "posts">("composer");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const mediaRequest = useRef(0);
  const [runId, setRunId] = useState("");
  const [runTotal, setRunTotal] = useState(0);
  const [cardState, setCardState] = useState<"idle" | "checking" | "warming" | "ready" | "fail">("idle");
  const [cardErr, setCardErr] = useState("");
  const [cardSecs, setCardSecs] = useState(0);
  const [prepNonce, setPrepNonce] = useState(0);
  const prepIv = useRef<number | null>(null);

  const loadMedia = useCallback(async () => {
    const requestId = ++mediaRequest.current;
    if (!libraryAccountId) { setMedia([]); setMediaTotal(0); return; }
    setMedia([]);
    setMediaTotal(0);
    const d = await fetch(`/api/media?accountId=${encodeURIComponent(libraryAccountId)}`).then((r) => r.json()).catch(() => null);
    if (requestId === mediaRequest.current && d?.media) { setMedia(d.media); setMediaTotal(d.media.length); }
  }, [libraryAccountId]);

  const loadAll = useCallback(async () => {
    const [a, j] = await Promise.all([
      fetch("/api/accounts").then((r) => r.json()),
      fetch("/api/jobs").then((r) => r.json()),
    ]);
    const availableAccounts = a.accounts ?? [];
    setAccounts(availableAccounts);
    setLibraryAccountId((current) => {
      const next = current && availableAccounts.some((x: Acct) => x.id === current)
        ? current
        : availableAccounts[0]?.id ?? "";
      if (next !== current) void fetch(`/api/media?accountId=${encodeURIComponent(next)}`).then((r) => r.json()).then((d) => {
        if (d?.media) { setMedia(d.media); setMediaTotal(d.media.length); }
      }).catch(() => {});
      return next;
    });
    if (!autoSel.current) {
      autoSel.current = true;
      setSelected(new Set((a.accounts ?? []).filter((x: Acct) => x.enabled).map((x: Acct) => x.id)));
    }
    setJobs(j.jobs ?? []);
  }, []);

  useEffect(() => {
    void loadMedia();
  }, [loadMedia]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(async (d) => {
        if (!d?.user) { router.replace("/login"); return; }
        setMe(d.user);
        await loadAll();
        setLoading(false);
      })
      .catch(() => router.replace("/login"));
  }, [router, loadAll]);

  const flash = (msg: string, isErr = false) => {
    setError(isErr ? msg : "");
    setNotice(isErr ? "" : msg);
    if (msg) setTimeout(() => { setNotice(""); setError(""); }, 6000);
  };

  const toggleAcct = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const selectAll = () => {
    if (selected.size === accounts.length) setSelected(new Set());
    else setSelected(new Set(accounts.map((a) => a.id)));
  };

  // Keep watching a run until it finishes. The fan-out runs on the SERVER, so
  // a dropped connection, a reload, or a closed tab no longer loses the post.
  async function watchRun(startId: string) {
    const deadline = Date.now() + 30 * 60_000;
    let id = startId;
    for (;;) {
      const q = id ? `?runId=${encodeURIComponent(id)}` : "?latest=1";
      const d = await fetch(`/api/posts/bulk${q}`).then((r) => r.json()).catch(() => null);
      if (d?.results) {
        if (d.runId) { id = d.runId; setRunId(d.runId); }
        setBulkResults(d.results);
        const s = d.summary ?? {};
        setRunTotal(s.total ?? d.results.length);
        setBulkSummary(`${s.done ?? 0} posted · ${s.queued ?? 0} queued · ${s.failed ?? 0} failed · ${d.results.length}/${s.total ?? "?"} handled`);
        if (d.status === "finished") {
          flash(`✅ Done — ${s.done ?? 0} posted live${d.dry ? " (dry run: nothing published)" : ""}`);
          loadAll();
          return;
        }
      } else if (d?.error) {
        flash("Could not read the run status — check the Posts tab.", true);
        return;
      }
      if (Date.now() > deadline) {
        flash("Still running in the background — reopen the page to see the result.");
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function postNow() {
    if (!picked) { flash("Pick a video first", true); return; }
    if (!link.trim()) { flash("Website URL is required — without a link the post publishes with no card and no link at all. Paste your link and hit Post again.", true); return; }
    if (selected.size === 0) { flash("Pick at least one account", true); return; }
    setPosting(true);
    setBulkResults(null);
    setBulkSummary("");
    setRunTotal(selected.size);
    try {
      const r = await fetch("/api/posts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountIds: Array.from(selected),
          mediaId: picked.id,
          caption,
          url: link,
          title,
        }),
      });
      const d = await r.json();
      if (!r.ok) { flash(d.error ?? "Post failed", true); setPosting(false); return; }
      setRunId(d.runId ?? "");
      try { localStorage.setItem("xp_run", d.runId ?? ""); } catch {}
      flash(`🚀 Fan-out started for ${d.summary?.total ?? selected.size} account(s) — running on the server, safe to leave this tab.`);
      await watchRun(d.runId ?? "");
    } catch {
      // The POST connection dropped, but the fan-out keeps running server-side:
      // re-attach to it instead of claiming a failure.
      flash("Connection blip — the post is still running on the server. Re-attaching…");
      await watchRun("");
    }
    setPosting(false);
  }

  async function uploadFile(f: File) {
    if (!libraryAccountId) { flash("Choose an account in the Media Library first", true); return; }
    setUploading(true);
    try {
      // Prod: Direct-to-Blob upload (bytes go straight from the browser to
      // Vercel Blob, bypassing the serverless 4.5MB body cap). Falls back to
      // the old server-side FormData flow when Blob isn't configured (local dev).
      const tok = await fetch("/api/media/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((r) => r.json()).catch(() => null);
      let r: { media?: unknown; error?: string } | null = null;
      if (tok?.blob) {
        const blob = await uploadToBlob(f);
        r = await fetch("/api/media/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: f.name,
            url: blob.url,
            sizeBytes: f.size,
            mimeType: f.type || "video/mp4",
            accountIds: [libraryAccountId],
          }),
        }).then((x) => x.json()).catch(() => null);
      } else if (tok?.error === "no-blob-token") {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("accountId", libraryAccountId);
        r = await fetch("/api/media", { method: "POST", body: fd })
          .then((x) => x.json()).catch(() => null);
      } else {
        r = { error: tok?.error ?? "Blob upload token failed" };
      }
      if (r?.media) { flash(`✅ ${f.name} uploaded — the worker will push it into the X media library`); loadMedia(); }
      else flash(r?.error ?? "Upload failed", true);
    } finally {
      setUploading(false);
    }
  }

  async function sync() {
    setSyncing(true);
    const d = await fetch("/api/media/sync", { method: "POST", body: JSON.stringify({ accountId: libraryAccountId }), headers: { "Content-Type": "application/json" } })
      .then((r) => r.json()).catch(() => null);
    if (d) flash(`✅ Synced — ${d.synced ?? 0} new items`); else flash("Sync failed", true);
    if (d?.errors?.length) flash(d.errors[0], true);
    setSyncing(false);
    loadMedia();
  }

  // The Website URL is the whole point of the post, and it is the same link over
  // and over. Persist it so a reload can never leave the composer with an empty
  // URL (which silently published a bare video with no link once).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("xp_link");
      if (saved) setLink((v) => (v.trim() ? v : saved));
    } catch {}
  }, []);
  useEffect(() => {
    try { if (link.trim()) localStorage.setItem("xp_link", link); } catch {}
  }, [link]);

  // Re-attach to an in-flight / just-finished run after a reload.
  useEffect(() => {
    if (loading) return;
    let alive = true;
    (async () => {
      const d = await fetch("/api/posts/bulk?latest=1").then((r) => r.json()).catch(() => null);
      if (!alive || !d?.results || !d.results.length) return;
      setBulkResults(d.results);
      const s = d.summary ?? {};
      setBulkSummary(`${s.done ?? 0} posted · ${s.queued ?? 0} queued · ${s.failed ?? 0} failed · ${d.results.length}/${s.total ?? "?"} handled`);
      setRunId(d.runId ?? "");
      setRunTotal(s.total ?? d.results.length);
      if (d.status === "running") { setPosting(true); watchRun(d.runId ?? "").finally(() => setPosting(false)); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Warm the website-card as soon as a video AND a link are chosen, so the Post
  // click itself is fast (the card build is the slow ~10-30s part).
  useEffect(() => {
    if (prepIv.current) { window.clearInterval(prepIv.current); prepIv.current = null; }
    let gone = false;
    const raw = link.trim().replace(/[.,;]+$/, "");
    const u = raw && !/^https?:\/\//i.test(raw) ? `https://${raw.replace(/^\/+/, "")}` : raw;
    // Only fire for something that already looks like a real host. Firing on
    // every keystroke ("https://s", "https://so…") started doomed card builds
    // for junk links, which is a big part of why prep felt like it never ended.
    const plausible = /^https?:\/\/[^\s/]+\.[a-z]{2,}/i.test(u);
    if (!picked || !plausible) { setCardState("idle"); setCardErr(""); setCardSecs(0); return; }
    setCardState("checking");
    setCardErr("");
    setCardSecs(0);
    // 1.2s of quiet after the last keystroke before touching the server.
    const t = window.setTimeout(async () => {
      const d = await fetch("/api/posts/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: picked.id, url: u, title }),
      }).then((r) => r.json()).catch(() => null);
      if (gone) return;
      if (d?.status === "ready") { setCardState("ready"); return; }
      if (d?.status === "failed") {
        setCardState("fail");
        setCardErr(d.error || "the card could not be built for that link");
        return;
      }
      if (d?.status !== "warming") {
        setCardState("fail");
        setCardErr(d?.error || "the panel could not start the card build — check your connection, then Retry");
        return;
      }
      setCardState("warming");
      const started = Date.now();
      prepIv.current = window.setInterval(async () => {
        const s = await fetch(`/api/posts/prepare?mediaId=${encodeURIComponent(picked.id)}&url=${encodeURIComponent(u)}`).then((r) => r.json()).catch(() => null);
        if (gone || !prepIv.current) return;
        setCardSecs(Math.round((Date.now() - started) / 1000));
        if (s?.ready) {
          window.clearInterval(prepIv.current!); prepIv.current = null;
          setCardState("ready");
        } else if (s?.status === "failed") {
          window.clearInterval(prepIv.current!); prepIv.current = null;
          setCardState("fail");
          setCardErr(s.error || "the card build failed server-side");
        } else if (Date.now() - started > 240_000) {
          window.clearInterval(prepIv.current!); prepIv.current = null;
          setCardState("fail");
          setCardErr("card build timed out after 4 minutes — hit Retry");
        }
      }, 2500);
    }, 1200);
    return () => { gone = true; window.clearTimeout(t); };
  }, [picked, link, title, prepNonce]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" style={{ width: 28, height: 28 }} />
      </div>
    );
  }

  const noAccounts = accounts.length === 0;
  const firstSel = accounts.find((a) => selected.has(a.id));
  const showCard = !!link;

  const composerForm = (
    <>
      {notice && <div className="card mb-4" style={{ borderColor: "rgba(0,186,124,.5)" }}><span style={{ color: "var(--x-green)" }} className="text-sm font-semibold">{notice}</span></div>}
      {error && <div className="card mb-4" style={{ borderColor: "rgba(244,33,46,.5)" }}><span style={{ color: "var(--x-red)" }} className="text-sm font-semibold">{error}</span></div>}

      {noAccounts ? (
        <div className="card text-center py-14">
          <h2 className="text-lg font-bold mb-2">No accounts assigned yet</h2>
          <p className="text-sm" style={{ color: "var(--x-dim)" }}>
            Install the <b style={{ color: "var(--x-blue)" }}>X Grabber</b> extension in your browser where the X account is
            logged in, click <b style={{ color: "var(--x-blue)" }}>GRAB</b>, and send the copied text to the admin.
            Once they connect + assign it, posting appears here.
          </p>
        </div>
      ) : (
        <div className="x-compose-grid">
          {/* ============ LEFT: COMPOSER FORM ============ */}
          <div>
            {/* Name */}
            <div className="x-section-label" style={{ marginTop: 0 }}>Name</div>
            <input className="input" placeholder="Untitled ad (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />

            {/* Tweet box */}
            <div className="x-section-label">Post</div>
            <div className="x-tweet-box">
              <div className="x-tweet-head">
                <div className="x-avatar" style={{ width: 36, height: 36, fontSize: 15, background: firstSel ? acctColor(firstSel.handle) : "var(--x-bg2)" }}>
                  {firstSel ? firstSel.handle.slice(0, 2) : "?"}
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{firstSel ? firstSel.handle : "Select accounts"}</div>
                  <div style={{ color: "var(--x-dim)", fontSize: 12.5 }}>{selected.size} of {accounts.length} selected · <button className="font-bold" style={{ color: "var(--x-blue)" }} onClick={selectAll}>{selected.size === accounts.length ? "clear all" : "select all"}</button></div>
                </div>
              </div>
              <textarea placeholder="What's happening?" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={280} />
              <div className="x-reply-row">
                <svg className="x-ico" style={{ width: 16, height: 16 }} viewBox="0 0 24 24"><path d="M12 1.75C6.34 1.75 1.75 6.34 1.75 12S6.34 22.25 12 22.25 22.25 17.66 22.25 12 17.66 1.75 12 1.75zm0 18.5c-4.55 0-8.25-3.7-8.25-8.25S7.45 3.75 12 3.75s8.25 3.7 8.25 8.25-3.7 8.25-8.25 8.25zM11.25 7h1.5v6h-1.5V7zm0 8h1.5v1.5h-1.5V15z"/></svg>
                Everyone can reply
                <svg style={{ width: 14, height: 14, fill: "currentColor", marginLeft: 2 }} viewBox="0 0 24 24"><path d="M3.543 8.96l1.414-1.42L12 14.59l7.043-7.05 1.414 1.42L12 17.41 3.543 8.96z"/></svg>
              </div>
            </div>

            {/* Accounts chips */}
            <div className="flex flex-wrap gap-2 mt-3">
              {accounts.map((a) => (
                <span key={a.id} className={`handle-chip ${selected.has(a.id) ? "selected" : ""}`} onClick={() => toggleAcct(a.id)}>
                  {a.enabled ? "@" : "🔒 @"}{a.handle}
                </span>
              ))}
            </div>

            {/* Destination */}
            <div className="x-section-label">Destination</div>
            <div className="flex gap-3 flex-wrap">
              <div className="x-dest-card on">
                <div className="flex items-center justify-between">
                  <div className="t">Website</div>
                  <div className="check">✓</div>
                </div>
                <div className="s">Include a call to action to your website.</div>
              </div>
              <div className="x-dest-card" style={{ opacity: 0.45, cursor: "not-allowed" }}>
                <div className="t">App</div>
                <div className="s">Coming soon</div>
              </div>
            </div>

            <div className="x-section-label">Website URL <span className="req">*</span></div>
            <div className={"x-url-wrap" + (link.trim() ? "" : " x-url-missing")}>
              <span className="x-url-prefix">https://</span>
              <input placeholder="paste your link here — required" value={link} onChange={(e) => setLink(e.target.value)} />
            </div>
            {!link.trim() && (
              <div className="text-xs mt-2" style={{ color: "var(--x-red)" }}>
                Required — without a link the post goes out with no card and no link at all.
              </div>
            )}
            {!title ? (
              <input className="input" placeholder="+ Add headline (shown on the card)" value={title} onChange={(e) => setTitle(e.target.value)} />
            ) : (
              <div className="text-sm" style={{ color: "var(--x-dim)" }}>Headline: <b style={{ color: "var(--x-text)" }}>{title}</b> <button className="font-bold" style={{ color: "var(--x-blue)" }} onClick={() => setTitle("")}>edit</button></div>
            )}

            {/* Media */}
            <div className="x-section-label">Media <span className="req">*</span></div>
            <div className="flex gap-3 items-start flex-wrap">
              {picked ? (
                <div className="media-thumb selected" style={{ width: 132, height: 132 }} onClick={() => setShowPicker(true)}>
                  {picked.mediaType === "IMAGE"
                    ? <img referrerPolicy="no-referrer" src={prox(picked.url)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <VideoThumb url={prox(picked.url)} label={picked.name} />}
                </div>
              ) : (
                <button className="btn btn-ghost" style={{ height: 120, width: "100%", maxWidth: 420, borderStyle: "dashed" }} onClick={() => setShowPicker(true)}>
                  📼 Add media — pick from your library
                </button>
              )}
              <div className="flex gap-2">
                <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? <><span className="spinner" /> Uploading…</> : "⬆ Upload"}</button>
                <button className="btn btn-ghost" onClick={sync} disabled={syncing}>{syncing ? <><span className="spinner" /> Syncing…</> : "↻ Sync from X"}</button>
              </div>
            </div>
            <input ref={fileRef} type="file" accept="video/*,image/*" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />

            <div className="mt-6 flex items-center gap-3 flex-wrap">
              <button className="btn btn-primary" style={{ padding: "12px 28px", fontSize: 16 }} disabled={posting || !picked || selected.size === 0 || !link.trim()} onClick={postNow}>
                {posting
                  ? <><span className="spinner spinner-dark" /> Posting… {bulkResults?.length ?? 0}/{runTotal || selected.size}</>
                  : !link.trim() ? "Add a Website URL first"
                  : `Post to ${selected.size} account${selected.size === 1 ? "" : "s"}`}
              </button>
              {bulkSummary && <span className="text-sm font-semibold" style={{ color: "var(--x-dim)" }}>{bulkSummary}</span>}
              {cardState !== "idle" && picked && !!link.trim() && (
                <span className="text-xs flex items-center gap-2" style={{ color: cardState === "ready" ? "var(--x-green)" : cardState === "fail" ? "var(--x-red)" : "var(--x-dim)" }}>
                  {cardState === "checking" ? "checking card…"
                    : cardState === "warming" ? `preparing card… ${cardSecs ? `${cardSecs}s` : ""} (one-time per video, runs while you type)`
                    : cardState === "ready" ? "card ready ✓ — posting will be instant"
                    : `card not ready — ${cardErr || "build failed"}`}
                  {cardState === "fail" && (
                    <button
                      type="button"
                      onClick={() => setPrepNonce((n) => n + 1)}
                      style={{ padding: "2px 8px", fontSize: 11, fontWeight: 600, borderRadius: 999, border: "1px solid var(--x-border)", background: "transparent", color: "var(--x-text)", cursor: "pointer" }}
                    >
                      Retry
                    </button>
                  )}
                </span>
              )}
            </div>

            {bulkResults && (
              <div className="card mt-5" style={{ padding: 0, overflow: "hidden" }}>
                <table>
                  <thead><tr><th>Account</th><th>Status</th><th>Result</th></tr></thead>
                  <tbody>
                    {bulkResults.map((r, i) => (
                      <tr key={i}>
                        <td className="font-semibold">@{r.handle}</td>
                        <td><span className={`badge badge-${r.status}`}>{r.status}</span></td>
                        <td className="text-xs">
                          {r.tweetUrl ? <a className="font-semibold" style={{ color: "var(--x-blue)" }} href={r.tweetUrl} target="_blank">View post ↗</a>
                            : <span style={{ color: "var(--x-red)" }}>{(r.error ?? "").slice(0, 110)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ============ RIGHT: LIVE PREVIEW ============ */}
          <div className="x-preview-col">
            <div className="x-section-label" style={{ marginTop: 0 }}>Preview</div>
            <div className="x-phone" style={{ position: "relative", maxWidth: 340 }}>
              <div className="x-phone-notch" />
              <div className="x-phone-status">
                <span>9:41</span>
                <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <svg style={{ width: 15, height: 15, fill: "#e7e9ea" }} viewBox="0 0 24 24"><path d="M2 22h20V2L2 22z"/></svg>
                  <svg style={{ width: 15, height: 15, fill: "#e7e9ea" }} viewBox="0 0 24 24"><path d="M1 9c6-6 16-6 22 0l-3 3c-4.5-4.5-11.5-4.5-16 0L1 9zm5 5c3-3 9-3 12 0l-3 3c-1.5-1.5-4.5-1.5-6 0l-3-3zm6 6l1.5-1.5c.8-.8 2.2-.8 3 0L18 20l-3 3-3-3z"/></svg>
                  <svg style={{ width: 20, height: 14, fill: "#e7e9ea" }} viewBox="0 0 24 24"><path d="M2 8h17v8H2V8zm19 1h2v6h-2V9z"/></svg>
                </span>
              </div>
              <div style={{ padding: "8px 14px 20px" }}>
                {/* tweet */}
                <div style={{ display: "flex", gap: 10, padding: "10px 0" }}>
                  <div className="x-avatar" style={{ width: 40, height: 40, fontSize: 16, background: firstSel ? acctColor(firstSel.handle) : "var(--x-bg2)" }}>
                    {firstSel ? firstSel.handle.slice(0, 2) : "?"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                      <b style={{ fontSize: 14.5 }}>{firstSel ? firstSel.handle : "Account name"}</b>
                      <span style={{ color: "var(--x-blue)", fontSize: 13 }}>·</span>
                      <span style={{ color: "var(--x-dim)", fontSize: 13.5 }}>now</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--x-dim)", border: "1px solid var(--x-border)", padding: "1px 5px", borderRadius: 4 }}>Ad</span>
                    </div>
                    <div style={{ fontSize: 14.5, marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {caption || <span style={{ color: "var(--x-dim)" }}>Your post text shows here…</span>}
                    </div>
                  </div>
                </div>
                {/* media */}
                <div style={{ borderRadius: 16, overflow: "hidden", border: "1px solid var(--x-border)", minHeight: 170, background: "var(--x-bg2)" }}>
                  {picked ? (
                    picked.mediaType === "IMAGE"
                      ? <img referrerPolicy="no-referrer" src={prox(picked.url)} style={{ width: "100%", height: 230, objectFit: "cover" }} />
                      : <VideoThumb url={prox(picked.url)} label={picked.name} big />
                  ) : (
                    <div style={{ height: 170, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--x-dim)", fontSize: 13 }}>Video preview</div>
                  )}
                </div>
                {/* card attach */}
                {showCard && (
                  <div className="x-card-attach" style={{ borderTop: "none" }}>
                    <div className="x-card-cta">
                      <div className="d">{domainOf(link)}</div>
                      <div className="t">{title || "Learn more"}</div>
                      <div className="c">Learn more →</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="text-xs mt-3" style={{ color: "var(--x-dim)" }}>
              Live preview — the link rides as a clickable card on the video, never in the caption.
            </div>
          </div>
        </div>
      )}
    </>
  );

  const libraryView = (
    <>
      {notice && <div className="card mb-4" style={{ borderColor: "rgba(0,186,124,.5)" }}><span style={{ color: "var(--x-green)" }} className="text-sm font-semibold">{notice}</span></div>}
      {error && <div className="card mb-4" style={{ borderColor: "rgba(244,33,46,.5)" }}><span style={{ color: "var(--x-red)" }} className="text-sm font-semibold">{error}</span></div>}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2" style={{ padding: "14px 0" }}>
        <span className="x-page-title">Media Library <span className="text-base font-medium" style={{ color: "var(--x-dim)" }}>({mediaTotal})</span></span>
        <div className="flex gap-2">
          <select className="input" aria-label="Media library account" value={libraryAccountId}
            onChange={(e) => setLibraryAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={sync} disabled={syncing}>{syncing ? <><span className="spinner" /> Syncing…</> : "↻ Sync from X"}</button>
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? <><span className="spinner spinner-dark" /> Uploading…</> : "⬆ Upload"}</button>
          <input ref={fileRef} type="file" accept="video/*,image/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
        </div>
      </div>
      {media.length === 0 ? (
        <div className="empty-state">
          <div className="ico">📼</div>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>Your library is empty</div>
          <div className="text-sm" style={{ color: "var(--x-dim)", maxWidth: 420, margin: "0 auto" }}>
            Upload a video, or pull this account's existing X media (videos + photos) with one tap.
          </div>
          <div className="flex gap-2 justify-center" style={{ marginTop: 18 }}>
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? <><span className="spinner spinner-dark" /> Uploading…</> : "⬆ Upload video"}</button>
            <button className="btn btn-ghost" onClick={sync} disabled={syncing}>{syncing ? <><span className="spinner" /> Syncing…</> : "↻ Sync from X"}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {media.map((m) => (
              <div key={m.id} className={`media-thumb ${picked?.id === m.id ? "selected" : ""}`} style={{ height: 150 }}
                onClick={() => { setPicked(m); flash(`Selected: ${m.name.slice(0, 40)}`); }}>
                <LazyMount>
                  {m.mediaType === "IMAGE"
                    ? <img referrerPolicy="no-referrer" loading="lazy" src={prox(m.url)} alt={m.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <VideoThumb url={prox(m.url)} label={m.name} />}
                </LazyMount>
                {m.mediaType !== "IMAGE" && <div style={{ position: "absolute", top: 8, left: 8, zIndex: 2, width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, pointerEvents: "none" }}>▶</div>}
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "18px 8px 6px", background: "linear-gradient(transparent, rgba(0,0,0,.85))", fontSize: 10.5, color: "#e7e9ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {m.name}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );

  const postsView = (
    <>
      <div style={{ padding: "14px 0" }}><span className="x-page-title">Recent posts</span></div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {jobs.length === 0 && <div className="text-center py-8 text-sm" style={{ color: "var(--x-dim)" }}>Nothing posted yet.</div>}
        {jobs.length > 0 && (
          <table>
            <thead><tr><th>When</th><th>Account</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>
              {jobs.slice(0, 25).map((j) => (
                <tr key={j.id}>
                  <td className="text-xs" style={{ color: "var(--x-dim)" }}>{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="font-semibold">@{accounts.find((a) => a.id === j.accountId)?.handle ?? "…"}</td>
                  <td><span className={`badge badge-${j.status}`}>{j.status}</span></td>
                  <td className="text-xs">
                    {j.tweetUrl ? <a className="font-semibold" style={{ color: "var(--x-blue)" }} href={j.tweetUrl} target="_blank">View post ↗</a>
                      : <span style={{ color: "var(--x-red)" }}>{(j.error ?? "").slice(0, 80)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );

  return (
    <div className="x-shell">
      {/* ============ SIDEBAR ============ */}
      <aside className="x-sidebar">
        <div className="x-logo">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>X Panel</div>
            <div style={{ color: "var(--x-dim)", fontSize: 12 }}>Post once · everywhere</div>
          </div>
        </div>

        {!noAccounts && (
          <>
            <div style={{ padding: "6px 12px", color: "var(--x-dim)", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Accounts ({selected.size}/{accounts.length})
            </div>
            {accounts.map((a) => (
              <button key={a.id} className={`x-acct-row ${selected.has(a.id) ? "on" : ""}`} onClick={() => toggleAcct(a.id)}>
                <div className="x-avatar" style={{ width: 30, height: 30, fontSize: 12, background: acctColor(a.handle) }}>{a.handle.slice(0, 2)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>@{a.handle}</div>
                  <div className="h">{a.status === "approved" ? (a.enabled ? "active" : "off") : a.status}</div>
                </div>
                <div className="x-acct-check" />
              </button>
            ))}
            <button className="x-acct-row" style={{ color: "var(--x-blue)" }} onClick={selectAll}>
              <span className="x-nav-ico">⇄</span>{selected.size === accounts.length ? "Clear all" : "Select all"}
            </button>
          </>
        )}

        <nav style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 2 }}>
          <button className={`x-nav-item ${view === "composer" ? "active" : ""}`} onClick={() => setView("composer")}>
            <span className="x-nav-ico"><IcoCompose /></span>Composer
          </button>
          <button className={`x-nav-item ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}>
            <span className="x-nav-ico"><IcoMedia /></span>Media Library
          </button>
          <button className={`x-nav-item ${view === "posts" ? "active" : ""}`} onClick={() => setView("posts")}>
            <span className="x-nav-ico"><IcoPosts /></span>Posts
          </button>
          {me?.role === "admin" && (
            <a className="x-nav-item" href="/admin">
              <span className="x-nav-ico"><IcoAdmin /></span>Admin
            </a>
          )}
        </nav>

        <div className="x-side-footer">
          <div style={{ padding: "4px 12px 8px", color: "var(--x-dim)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me?.email}</div>
          <button className="x-nav-item" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); }}>
            <span className="x-nav-ico"><IcoLogout /></span>Log out
          </button>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main className="x-main">
        <div className="x-main-inner">
          {view === "composer" && (
            <div className="x-page-head">
              <span className="x-page-title">Composer</span>
              <button className="btn btn-primary" disabled={posting || !picked || selected.size === 0 || noAccounts} onClick={postNow}>
                {posting ? <><span className="spinner spinner-dark" /> Posting…</> : <>Post {selected.size > 0 && <span style={{ opacity: 0.6 }}>· {selected.size}</span>}</>}
              </button>
            </div>
          )}
          {view === "composer" && composerForm}
          {view === "library" && libraryView}
          {view === "posts" && postsView}
        </div>
      </main>

      {/* ============ MEDIA PICKER MODAL ============ */}
      {showPicker && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setShowPicker(false)}>
          <div className="modal" style={{ maxWidth: 760 }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-extrabold">Add media</h2>
              <div className="flex gap-2">
                <button className="btn btn-ghost" onClick={sync} disabled={syncing}>{syncing ? <><span className="spinner" /> Syncing…</> : "↻ Sync"}</button>
                <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? <><span className="spinner spinner-dark" /> Uploading…</> : "⬆ Upload"}</button>
                <button className="btn btn-ghost" onClick={() => setShowPicker(false)}>✕</button>
              </div>
            </div>
            {media.length === 0 ? (
              <div className="text-center py-10 text-sm" style={{ color: "var(--x-dim)" }}>Library is empty — upload a video first.</div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                {media.filter((m) => !m.accountId || m.accountId === firstSel?.id).map((m) => (
                  <div key={m.id} className="media-thumb" style={{ height: 130 }}
                    onClick={() => { setPicked(m); setShowPicker(false); flash(`Selected: ${m.name.slice(0, 40)}`); }}>
                    <LazyMount>
                      {m.mediaType === "IMAGE"
                        ? <img referrerPolicy="no-referrer" loading="lazy" src={prox(m.url)} alt={m.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        : <VideoThumb url={prox(m.url)} label={m.name} />}
                    </LazyMount>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function prox(u: string): string {
  return `/api/proxy-media?u=${encodeURIComponent(u)}`;
}

/* Mounts children only when scrolled near the viewport, so a 200+ item
   library renders instantly without fetching every video frame at once. */
function LazyMount({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (show || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } },
      { rootMargin: "600px 0px" }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [show]);
  return <div ref={ref} style={{ width: "100%", height: "100%", background: "#16181c" }}>{show ? children : null}</div>;
}

function VideoThumb({ url, label, big }: { url: string; label: string; big?: boolean }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div style={{ width: "100%", height: big ? 230 : "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--x-dim)", fontSize: 11, textAlign: "center", padding: 8 }}>
        🎬 {label.slice(0, 24)}
      </div>
    );
  }
  return (
    <video
      {...({ referrerPolicy: "no-referrer" } as Record<string, string>)}
      src={url}
      muted
      playsInline
      preload="metadata"
      onError={() => setErr(true)}
      style={{ width: "100%", height: big ? 230 : "100%", objectFit: "cover", background: "#16181c" }}
    />
  );
}

/* ---- X-style icons ---- */
function IcoCompose() {
  return <svg className="x-ico" viewBox="0 0 24 24"><path d="M21.53 3.47a3.28 3.28 0 0 0-4.64 0l-1.6 1.6-1.06 1.06-9.05 9.05a2.5 2.5 0 0 0-.66 1.16L3 21l5.66-1.52a2.5 2.5 0 0 0 1.16-.66l9.05-9.05 1.06-1.06 1.6-1.6a3.28 3.28 0 0 0 0-4.64zM8.4 18.4a1 1 0 0 1-.46.27L5.13 19.6l.93-2.81a1 1 0 0 1 .27-.46l8.77-8.77 2.07 2.07L8.4 18.4z"/></svg>;
}
function IcoMedia() {
  return <svg className="x-ico" viewBox="0 0 24 24"><path d="M19.75 3H4.25C3 3 2 4 2 5.25v13.5C2 20 3 21 4.25 21h15.5c1.25 0 2.25-1 2.25-2.25V5.25C22 4 21 3 19.75 3zM4.25 4.75h15.5c.28 0 .5.22.5.5v8.06l-3.85-3.42a1.25 1.25 0 0 0-1.7.04L8.4 16.16l-2.1-1.8a1.25 1.25 0 0 0-1.65.02L3.75 15.7V5.25c0-.28.22-.5.5-.5zm15.5 14.5H4.25a.5.5 0 0 1-.5-.5v-1.94l3.7-3.2 2.14 1.83c.49.42 1.22.39 1.68-.07l6.35-6.28L21 12.03v6.72c0 .28-.22.5-.5.5zM8 10.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z"/></svg>;
}
function IcoPosts() {
  return <svg className="x-ico" viewBox="0 0 24 24"><path d="M7 4.5C3.74 4.5 1 7.24 1 10.5c0 4.42 4.28 7.63 10.05 12.33l.95.78.95-.78C18.72 18.13 23 14.92 23 10.5c0-3.26-2.74-6-6-6-1.9 0-3.65 1-5 2.5-1.35-1.5-3.1-2.5-5-2.5z"/></svg>;
}
function IcoAdmin() {
  return <svg className="x-ico" viewBox="0 0 24 24"><path d="M22.21 18.31l-1.32-1.32c.26-.7.38-1.44.35-2.19l1.66-.79-1.28-3.11-1.72.62c-.5-.56-1.1-1.02-1.77-1.36l.21-1.82-3.28-.72-.66 1.72c-.74.1-1.45.34-2.1.7l-1.5-1.05L8.7 10.4l1.21 1.35c-.28.67-.44 1.38-.47 2.1l-1.75.55.62 3.28 1.82-.21c.42.63.95 1.18 1.56 1.62l-.53 1.75 3.11 1.28.79-1.66c.75.03 1.49-.09 2.19-.35l1.32 1.32 2.54-2.54zM12.5 15.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>;
}
function IcoLogout() {
  return <svg className="x-ico" viewBox="0 0 24 24"><path d="M16 3h-2v2h2v14h-2v2h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM4 5a2 2 0 0 1 2-2h6v2H6v14h6v2H6a2 2 0 0 1-2-2V5zm8.29 10.29l1.42 1.42L18.41 12l-4.7-4.71-1.42 1.42L14.17 11H7v2h7.17l-1.88 2.29z"/></svg>;
}