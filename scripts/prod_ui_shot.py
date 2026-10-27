import json, subprocess, time, base64, urllib.request, sys
import websocket

PORT = 9225
UD = r"C:\Users\ankit\chrome-cdp-prod-visual"
chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE = "https://x-panel-six.vercel.app"

proc = subprocess.Popen([
    chrome, f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
    f"--user-data-dir={UD}", "--no-first-run", "--no-default-browser-check",
    "--headless=new", "--window-size=1500,900", "about:blank"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def shot(cmd, name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    with open(name, "wb") as f:
        f.write(base64.b64decode(r["result"]["data"]))
    print("saved", name)

def ev(cmd, expr):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("result", {}).get("value")

try:
    for _ in range(30):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read().decode())
            if tabs: break
        except Exception:
            time.sleep(1)
    else:
        print("CDP never came up"); sys.exit(1)

    ws = websocket.create_connection(tabs[0]["webSocketDebuggerUrl"], timeout=60)
    mid = [0]
    def cmd(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r

    cmd("Page.enable")
    cmd("Page.navigate", {"url": BASE + "/login"})
    time.sleep(6)

    ok = ev(cmd, """
      (async () => {
        const set=(el,v)=>{const proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const p=Object.getOwnPropertyDescriptor(proto,'value'); p.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
        const email=[...document.querySelectorAll('input')].find(i=>i.type==='email'||(i.placeholder||'').toLowerCase().includes('email'));
        const pw=[...document.querySelectorAll('input')].find(i=>i.type==='password');
        if(!email||!pw) return 'fields nf';
        set(email,'qa-e2e-admin@pinelab.org'); set(pw,'qa-visual-2026');
        await new Promise(r=>setTimeout(r,300));
        const btn=[...document.querySelectorAll('button')].find(b=>/sign in|log ?in/i.test(b.innerText));
        if(!btn) return 'btn nf';
        btn.click();
        return 'submitted';
      })()
    """)
    print("login:", ok)
    time.sleep(6)
    print("url now:", ev(cmd, "location.pathname"))

    shot(cmd, r"C:\Users\ankit\x_panel\scripts\prod_dashboard.png")
    print("dash text:", ev(cmd, "document.body.innerText.slice(0,400)"))

    # Composer view
    ev(cmd, "[...document.querySelectorAll('.x-nav-item,nav a,button')].find(x=>x.innerText.trim()==='Composer')?.click()")
    time.sleep(3)
    shot(cmd, r"C:\Users\ankit\x_panel\scripts\prod_composer.png")

    # Media Library
    ev(cmd, "[...document.querySelectorAll('.x-nav-item,nav a,button')].find(x=>x.innerText.trim()==='Media Library')?.click()")
    time.sleep(3)
    shot(cmd, r"C:\Users\ankit\x_panel\scripts\prod_library.png")
    print("media count:", ev(cmd, "document.querySelectorAll('.x-media-item,[data-media-id]').length"))

    ws.close()
    print("DONE")
finally:
    try: proc.terminate()
    except Exception: pass
