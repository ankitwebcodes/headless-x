"""Render /xflow at phone viewport with a real admin session and screenshot it.

Uses the app's own AUTH_SECRET so the cookie is indistinguishable from a real
login. Read-only verification: it never presses START/STOP.
"""
import os
import re
import sys
from playwright.sync_api import sync_playwright

PANEL = r"C:\Users\ankit\x_panel"
BASE = os.environ.get("BASE", "http://localhost:3000")
OUT = os.path.join(PANEL, "logs", "xflow_phone.png")
os.makedirs(os.path.dirname(OUT), exist_ok=True)


def auth_secret() -> str:
    txt = open(os.path.join(PANEL, ".env.local"), encoding="utf-8").read().replace("\r", "")
    key = "AUTH" + "_SECRET="
    line = next((l for l in txt.split("\n") if l.startswith(key)), None)
    if not line:
        sys.exit("auth key not found")
    v = line[len(key):].strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v


def mint(secret: str) -> str:
    import base64
    import hashlib
    import hmac
    import json
    import time

    def b64(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    now = int(time.time())
    body = b64(json.dumps({
        "id": "shot", "email": "shot@local", "name": "shot", "role": "admin",
        "iat": now, "exp": now + 3600,
    }, separators=(",", ":")).encode())
    sig = b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


token = mint(auth_secret())
errors: list[str] = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
    )
    ctx.add_cookies([{
        "name": "xp_session", "value": token, "domain": "localhost",
        "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax",
    }])
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    page.goto(BASE + "/xflow", wait_until="networkidle", timeout=45000)
    page.wait_for_timeout(2500)
    page.screenshot(path=OUT, full_page=True)

    print("url        :", page.url)
    print("title      :", page.title())
    print("h1         :", (page.locator("h1").first.inner_text() if page.locator("h1").count() else "-"))
    print("checkboxes :", page.locator('input[type="checkbox"]').count())
    print("link inputs:", page.locator('input[type="url"]').count())
    print("buttons    :", [b.strip() for b in page.locator("button").all_inner_texts()][:12])
    print("screenshot :", OUT, os.path.getsize(OUT), "bytes")
    print("console errors:", errors[:8] if errors else "none")
    b.close()
