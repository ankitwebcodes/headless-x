import re
from urllib.parse import urlparse

env = {}
with open(r"C:\Users\ankit\x_panel\.env.local", "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v

for k in sorted(env):
    if re.search(r"DATABASE|POSTGRES|^PG", k) and k in (
        "DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL",
        "POSTGRES_URL_NON_POOLING", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NO_SSL",
    ):
        v = env[k]
        try:
            u = urlparse(v)
            print(f"{k}: host={u.hostname} port={u.port} db={u.path.lstrip('/')} ssl={u.query[:40]}")
        except Exception as e:
            print(f"{k}: unparsable ({e})")