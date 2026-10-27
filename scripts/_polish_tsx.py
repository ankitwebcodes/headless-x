import pathlib, re

old_empty = """      {media.length === 0 ? (
        <div className="card text-center py-12 text-sm" style={{ color: "var(--x-dim)" }}>
          Empty — hit ↻ Sync from X to pull this account's own X media library (videos + photos), or upload a video.
        </div>
      ) : ("""
new_empty = """      {media.length === 0 ? (
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
      ) : ("""

old_thumb = """                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "6px 8px", background: "linear-gradient(transparent, rgba(0,0,0,.85))", fontSize: 10.5, color: "#e7e9ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {m.name}
                </div>"""
new_thumb = """                {m.mediaType !== "IMAGE" && <div style={{ position: "absolute", top: 8, left: 8, zIndex: 2, width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, pointerEvents: "none" }}>▶</div>}
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "18px 8px 6px", background: "linear-gradient(transparent, rgba(0,0,0,.85))", fontSize: 10.5, color: "#e7e9ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {m.name}
                </div>"""

for base in ["x_panel", "xp_deploy_copy"]:
    p = pathlib.Path(r"C:\Users\ankit") / base / "app" / "dashboard" / "page.tsx"
    s = p.read_text(encoding="utf-8")
    ok1 = old_empty in s; ok2 = old_thumb in s
    assert ok1 and ok2, f"{base}: empty={ok1} thumb={ok2}"
    s = s.replace(old_empty, new_empty).replace(old_thumb, new_thumb)
    p.write_text(s, encoding="utf-8")
    print(base, "tsx updated")
