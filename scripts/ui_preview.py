import json, subprocess, time, base64, urllib.request, os, signal, sys
import websocket

PORT = 9224
UD = r"C:\Users\ankit\chrome-cdp-ui-test"

chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
proc = subprocess.Popen([
    chrome, f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
    f"--user-data-dir={UD}", "--no-first-run", "--no-default-browser-check",
    "--headless=new", "--window-size=1500,900", "about:blank"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json") as r:
                tabs = json.loads(r.read().decode())
            if tabs: break
        except Exception:
            time.sleep(1)
    else:
        print("CDP never came up"); sys.exit(1)

    ws_url = tabs[0]["webSocketDebuggerUrl"]
    ws = websocket.create_connection(ws_url, timeout=60)
    mid = [0]
    def cmd(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r

    stub = """
    (function(){
      const RESP = {
        '/api/auth/me': {user:{id:'qa', email:'qa-demo2@pinelab.org', name:'QA', role:'admin'}},
        '/api/accounts': {accounts:[
          {id:'a1', handle:'fantasysoulmate', status:'approved', enabled:1, hasSession:true, defaultUrl:'', defaultTitle:''},
          {id:'a2', handle:'manxbonners', status:'approved', enabled:1, hasSession:true, defaultUrl:'', defaultTitle:''},
          {id:'a3', handle:'guysexhibition', status:'approved', enabled:1, hasSession:true, defaultUrl:'', defaultTitle:''}
        ]},
        '/api/jobs': {jobs:[
          {id:'j1', accountId:'a1', caption:'test', status:'done', tweetUrl:'https://x.com/x/status/1', error:null, createdAt: Date.now()-3600000},
          {id:'j2', accountId:'a2', caption:'test', status:'done', tweetUrl:'https://x.com/x/status/2', error:null, createdAt: Date.now()-7200000}
        ]},
        '/api/media': {media:[
          {id:'m1', name:'video_a.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:1},
          {id:'m2', name:'video_b.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:2},
          {id:'m3', name:'photo_c.jpg', url:'', mediaType:'IMAGE', mediaKey:null, accountId:null, createdAt:3},
          {id:'m4', name:'video_d.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:4},
          {id:'m5', name:'video_e.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:5},
          {id:'m6', name:'video_f.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:6},
          {id:'m7', name:'video_g.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:7},
          {id:'m8', name:'video_h.mp4', url:'', mediaType:null, mediaKey:null, accountId:null, createdAt:8}
        ]}
      };
      const of = window.fetch;
      window.fetch = function(u, o){
        const path = (typeof u === 'string' ? u : u.url).split('?')[0];
        if (RESP[path]) return Promise.resolve(new Response(JSON.stringify(RESP[path]), {status:200, headers:{'Content-Type':'application/json'}}));
        return of.apply(this, arguments);
      };
    })();
    """
    cmd("Page.enable")
    cmd("Page.addScriptToEvaluateOnNewDocument", {"source": stub})
    cmd("Page.navigate", {"url": "http://localhost:3111/dashboard"})
    time.sleep(7)

    def shot(name):
        r = cmd("Page.captureScreenshot", {"format": "png"})
        with open(name, "wb") as f:
            f.write(base64.b64decode(r["result"]["data"]))
        print("saved", name)

    shot(r"C:\Users\ankit\x_panel\scripts\ui_composer.png")

    # click Media Library nav
    cmd("Runtime.evaluate", {"expression": """
      (() => { const b=[...document.querySelectorAll('.x-nav-item')].find(x=>x.innerText.includes('Media Library')); if(b){b.click(); return 'ok';} return 'nf'; })()
    """, "returnByValue": True})
    time.sleep(2)
    shot(r"C:\Users\ankit\x_panel\scripts\ui_library.png")

    # back to composer, fill fields for preview check
    cmd("Runtime.evaluate", {"expression": """
      (() => { const b=[...document.querySelectorAll('.x-nav-item')].find(x=>x.innerText.includes('Composer')); if(b){b.click(); return 'ok';} return 'nf'; })()
    """, "returnByValue": True})
    time.sleep(1)
    cmd("Runtime.evaluate", {"expression": """
      (() => {
        const set=(el,v)=>{const proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const p=Object.getOwnPropertyDescriptor(proto,'value'); p.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
        const ta=document.querySelector('textarea'); if(ta) set(ta,"Check the link inside 👇 it rides on the video");
        const urlIn = document.querySelector('.x-url-wrap input[placeholder]'); if(urlIn) set(urlIn,'ourdreamersai13.com/48X5HCL/NFC9H/?uid=193');
        const head=[...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('headline')); if(head) set(head,'Unlock Your AI Girlfriend');
        return 'filled';
      })()
    """, "returnByValue": True})
    time.sleep(1.5)
    chk = cmd("Runtime.evaluate", {"expression": "document.querySelector('.x-card-attach') ? 'CARD OK' : 'NO CARD'", "returnByValue": True})
    print('assert:', chk.get("result",{}).get("result",{}).get("value"))
    shot(r"C:\Users\ankit\x_panel\scripts\ui_filled.png")
    ws.close()
    print("DONE")
finally:
    try: proc.terminate()
    except Exception: pass
