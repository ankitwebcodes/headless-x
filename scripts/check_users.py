"""Read .env.local, query Neon users table via Neon SQL-over-HTTP, print emails+roles only."""
import base64, json, os, re, sys, urllib.request

env_path = os.path.expanduser("~/x_panel/.env.local")
dsn = ""
with open(env_path, encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if line.startswith("DATABASE_URL=") or line.startswith("POSTGRES_URL=") or line.startswith("DATABASE_URL\""):
            dsn = line.split("=", 1)[1].strip().strip('"')
            break
if not dsn:
    print("NO_DB_URL_FOUND")
    sys.exit(1)

# postgres://user:pass@host/dbname?sslmode=require  -> https://host/sql with basic auth
m = re.match(r"postgres(?:ql)?://([^:]+):([^@]+)@([^/:]+)(?::\d+)?/([^?]+)", dsn)
if not m:
    print("UNPARSEABLE_DSN")
    sys.exit(1)
user, pw, host, db = m.groups()
url = f"https://{host}/sql"

req = urllib.request.Request(
    url,
    data=json.dumps({"query": "SELECT email, role FROM users ORDER BY created_at ASC"}).encode(),
    headers={
        "Content-Type": "application/json",
        "Neon-Connection-String": dsn,
        "Neon-Headers": "x-neon-json=true",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode())
    rows = data if isinstance(data, list) else data.get("rows", data)
    if not rows:
        print("NO_USERS")
    else:
        for row in rows:
            if isinstance(row, dict):
                print(f"{row.get('email')} | role={row.get('role')}")
            else:
                print(row)
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", "replace")[:2000]
    print(f"HTTP_ERROR {e.code}: {body}")
    sys.exit(1)
except Exception as e:
    print(f"QUERY_ERROR: {e}")
    sys.exit(1)