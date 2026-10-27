import json, secrets, time

import pg8000.native, bcrypt

env = {}
with open(r"C:\Users\ankit\x_panel\.env.local", "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")

url = env.get("DATABASE_URL") or env.get("POSTGRES_URL")
if url.startswith("postgres://"):
    url = url.replace("postgres://", "postgresql://", 1)

email = "hermes.qa@xpanel.local"
pw_plain = "Qa" + secrets.token_urlsafe(9)
hash_ = bcrypt.hashpw(pw_plain.encode(), bcrypt.gensalt(10)).decode()

conn = pg8000.native.Connection(url)
conn.run("DELETE FROM users WHERE email = :e", e=email)
conn.run(
    "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (:i,:e,:h,:n,:r,:c)",
    i="qa-temp-admin-0001", e=email, h=hash_, n="QA Admin", r="admin", c=time.time() * 1000,
)
rows = conn.run("SELECT id, email, role FROM users WHERE email = :e", e=email)
conn.close()
print(json.dumps({"created": [dict(zip(["id", "email", "role"], r)) for r in rows], "password": pw_plain}))
