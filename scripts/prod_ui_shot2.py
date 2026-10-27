import json, subprocess, time, base64, urllib.request, sys
import websocket

PORT = 9226
UD = r"C:\Users\ankit\chrome-cdp-prod-visual"
chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE = "https://x-panel-six.vercel.app"

proc = subprocess.Popen([
    chrome, f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
    f"--user-data-dir={UD}", "--no-first-run", "--no-default-browser-check",
    "--headless=new", "--window-size=1500,900", "about:blank"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def ev(cmd, expr):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("result", {}).get("value")

def shot(cmd, name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    with open(name, "wb") as f:
        f.write(base64.b64decode(r["result"]["data"]))
    print("saved", name)

try:
    for _ in range(30):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read().decode())
            if tabs: break
        except Exception:
            time.sleep(1)
    else:
        print("CDP never came up"); sys.exit(1)

    ws = websocket.create_connection(tabs[0]["webSocketDebuggerUrl"], timeout=120)
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
    ev(cmd, """
      (async () => {
        const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value'); p.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
        const email=[...document.querySelectorAll('input')].find(i=>i.type==='email');
        const pw=[...document.querySelectorAll('input')].find(i=>i.type==='password');
        set(email,'qa-e2e-admin@pinelab.org'); set(pw,'qa-visual-2026');
        await new Promise(r=>setTimeout(r,300));
        [...document.querySelectorAll('button')].find(b=>/sign in|log ?in/i.test(b.innerText)).click();
      })()
    """)
    time.sleep(6)
    print("path:", ev(cmd, "location.pathname"))

    print("NAV:", ev(cmd, "JSON.stringify([...document.querySelectorAll('a,button')].map(a=>a.innerText.trim()).filter(t=>t&&t.length<30))"))

    # click Composer (case-insensitive contains)
    print("click composer:", ev(cmd, """
      (async () => {
        const el=[...document.querySelectorAll('a,button')].find(x=>/composer/i.test(x.innerText));
        if(!el) return 'nf';
        el.click(); await new Promise(r=>setTimeout(r,4000));
        return location.pathname;
      })()
    """))
    shot(cmd, r"C:\Users\ankit\x_panel\scripts\prod_composer.png")

    print("click library:", ev(cmd, """
      (async () => {
        const el=[...document.querySelectorAll('a,button')].find(x=>/media|library/i.test(x.innerText));
        if(!el) return 'nf';
        el.click(); await new Promise(r=>setTimeout(r,4000));
        return location.pathname;
      })()
    """))
    shot(cmd, r"C:\Users\ankit\x_panel\scripts\prod_library.png")
    print("media count:", ev(cmd, "document.querySelectorAll('[data-media-id],img[src*=media],img[src*=twimg]').length"))

    ws.close()
    print("DONE")
finally:
    try: proc.terminate()
    except Exception: pass
