import pathlib

css_old = """.media-thumb {
  position: relative; border-radius: 12px; overflow: hidden;
  background: var(--x-bg2); border: 1px solid var(--x-border);
  cursor: pointer; transition: border-color 0.13s;
}
.media-thumb:hover { border-color: #3e4144; }
.media-thumb.selected { border: 2px solid var(--x-blue); }"""

css_new = """.media-thumb {
  position: relative; border-radius: 14px; overflow: hidden;
  background: var(--x-bg2); border: 1px solid var(--x-border);
  cursor: pointer; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.media-thumb:hover { border-color: #536471; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.5); }
.media-thumb.selected { border: 2px solid var(--x-blue); box-shadow: 0 0 0 3px rgba(29,155,240,.25); }
.media-thumb.selected::after {
  content: "\\2713"; position: absolute; top: 8px; right: 8px; z-index: 2;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--x-blue); color: #fff; font-size: 13px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.6);
}
.media-thumb video, .media-thumb img { transition: opacity 0.2s; }
.media-thumb:hover video, .media-thumb:hover img { opacity: 0.85; }

/* empty state */
.empty-state {
  border: 1px dashed var(--x-border); border-radius: 18px;
  padding: 56px 24px; text-align: center; background: rgba(22,24,28,.5);
}
.empty-state .ico {
  width: 56px; height: 56px; margin: 0 auto 14px; border-radius: 50%;
  background: var(--x-blue-dim); display: flex; align-items: center; justify-content: center;
  color: var(--x-blue); font-size: 24px;
}"""

for base in ["x_panel", "xp_deploy_copy"]:
    p = pathlib.Path(r"C:\Users\ankit") / base / "app" / "globals.css"
    s = p.read_text(encoding="utf-8")
    assert css_old in s, base + ": old block not found"
    p.write_text(s.replace(css_old, css_new), encoding="utf-8")
    print(base, "css updated")
