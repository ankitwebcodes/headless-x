import json, urllib.request

cfg = json.load(open(r"C:\Users\ankit\x_panel\worker\config.json"))
tok = cfg["worker_token"]
base = cfg["panel_url"]

for path in ["/api/worker/claim", "/api/worker/pending-uploads"]:
    req = urllib.request.Request(base + path, headers={"x-worker-token": tok})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            print("==", path, "->", r.status, r.read()[:300].decode("utf-8", "replace"))
    except Exception as e:
        body = ""
        try:
            body = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            pass
        print("==", path, "-> HTTP", getattr(e, "code", None), "|", str(e)[:150], "|", body)
