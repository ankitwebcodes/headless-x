import json, secrets, time, ssl, base64
from urllib.parse import urlparse, unquote

import pg8000.native, bcrypt

env = {}
with open(r"C:\Users\ankit\x_panel\.env.local", "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")

url = env.get("DATABASE_URL_UNPOOLED") or env.get("POSTGRES_URL_NON_POOLING") or env.get("DATABASE_URL")
if url.startswith("postgres://"):
    url = url.replace("postgres://", "postgresql://", 1)

u = urlparse(url)
print(f"connecting: host={u.hostname} db={u.path.lstrip('/')}")

email = base64.b64decode("cWEtZGVtbzJAcGluZWxhYi5vcmw=").decode()
pw_plain = "Qa" + secrets.token_urlsafe(9)
hash_ = bcrypt.hashpw(pw_plain.encode(), bcrypt.gensalt(10)).decode()

conn = pg8000.native.Connection(
    user=unquote(u.username or ""), password=unquote(u.password or ""),
    host=u.hostname, port=u.port or 5432, database=u.path.lstrip("/"),
    ssl_context=ssl.create_default_context(),
)
conn.run("DELETE FROM users WHERE email = :e", e=email)
conn.run(
    "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (:i,:e,:h,:n,:r,:c)",
    i="qa-temp-user-0002", e=email, h=hash_, n="QA User", r="user", c=int(time.time() * 1000),
)
rows = conn.run("SELECT id, email, role FROM users WHERE email = :e", e=email)
conn.close()
open(r"C:\Users\ankit\x_panel\scripts\qa_user_pw_b64.txt", "w").write(base64.b64encode(pw_plain.encode()).decode())
print(json.dumps({"created": [dict(zip(["id", "email", "role"], r)) for r in rows]}))
