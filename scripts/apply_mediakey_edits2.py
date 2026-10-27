# Phase 2: postOne.ts + worker.py edits with CRLF normalization
import sys

def rd(p):
    with open(p, "r", encoding="utf-8") as f: return f.read()

def wr(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f: f.write(s)
    print("wrote", p)

ROOT = r"C:/Users/ankit/x_panel"

# ---------- 5. postOne.ts ----------
p = ROOT + "/lib/postOne.ts"
s = rd(p).replace("\r\n", "\n")
if "FINAL fallback: queue for the background worker" in s:
    print("postOne already patched")
else:
    old = """  // No mediaKey → needs upload into the real X library first → queue for worker
  if (!m.mediaKey) {
    const now = Date.now();
    const jobId = uid();
    const jobRow = {
      id: jobId,
      userId,
      accountId: acct.id,
      mediaId: m.id,
      caption: captionTxt,
      url: urlTxt,
      title: titleTxt,
      status: "queued" as const,
      tweetUrl: null,
      error: null,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(jobs).values(jobRow);
    return { ...base, status: "queued", tweetUrl: null, error: null, jobId, path: "worker-upload" };
  }

  // Optional OAuth1 (parsed BEFORE the probe — the fallback path needs it)
  let creds: OAuth1Creds | null = null;
  try {
    const parsed = JSON.parse(acct.oauth1Json);
    if (parsed?.consumer_key && parsed?.access_token) {
      creds = {
        consumer_key: String(parsed.consumer_key),
        consumer_secret: String(parsed.consumer_secret ?? ""),
        access_token: String(parsed.access_token),
        access_token_secret: String(parsed.access_token_secret ?? ""),
      };
    }
  } catch {
    /* no oauth1 */
  }
"""
    new = """  // Optional OAuth1 (parsed BEFORE everything — the instant-upload path needs it)
  let creds: OAuth1Creds | null = null;
  try {
    const parsed = JSON.parse(acct.oauth1Json);
    if (parsed?.consumer_key && parsed?.access_token) {
      creds = {
        consumer_key: String(parsed.consumer_key),
        consumer_secret: String(parsed.consumer_secret ?? ""),
        access_token: String(parsed.access_token),
        access_token_secret: String(parsed.access_token_secret ?? ""),
      };
    }
  } catch {
    /* no oauth1 */
  }

  // Per-account mediaKey first (panel uploads push per-account; ads-synced
  // keys live on the media row itself).
  try {
    const r = await db.execute(
      sql`select media_key from account_media where media_id = ${m.id} and account_id = ${acct.id} limit 1`
    );
    const row = (r as { rows?: Array<{ media_key?: unknown }> }).rows?.[0];
    if (row?.media_key) m.mediaKey = String(row.media_key);
  } catch {
    /* table may not exist yet — fall through */
  }

  // Still no key → INSTANT path: upload straight into THIS account's X media
  // library (worker may not have pre-warmed yet). Only queue as a last resort.
  if (!m.mediaKey && creds) {
    try {
      const upId = await uploadMediaOAuth1(creds, m.url);
      if (upId) {
        m.mediaKey = `13_${upId}`;
        try {
          await db.execute(
            sql`insert into account_media (id, media_id, account_id, media_key, created_at)
                values (${randomUUID()}, ${m.id}, ${acct.id}, ${m.mediaKey}, ${Date.now()})
                on conflict (account_id, media_id) do update set media_key = ${m.mediaKey}`
          );
        } catch { /* best-effort cache */ }
      }
    } catch {
      /* fall through to worker queue */
    }
  }

  // FINAL fallback: queue for the background worker (worker-upload path).
  if (!m.mediaKey) {
    const now = Date.now();
    const jobId = uid();
    const jobRow = {
      id: jobId,
      userId,
      accountId: acct.id,
      mediaId: m.id,
      caption: captionTxt,
      url: urlTxt,
      title: titleTxt,
      status: "queued" as const,
      tweetUrl: null,
      error: null,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(jobs).values(jobRow);
    return { ...base, status: "queued", tweetUrl: null, error: null, jobId, path: "worker-upload" };
  }
"""
    assert old in s, "postOne old block still not found"
    s = s.replace(old, new)
    wr(p, s)

# imports for postOne: sql + randomUUID
s = rd(p).replace("\r\n", "\n")
assert "FINAL fallback" in s
if 'import { sql } from "drizzle-orm"' not in s:
    # find existing drizzle import line
    import re
    m = re.search(r'^import .*drizzle-orm.*$', s, re.M)
    print("drizzle import line:", m.group(0) if m else "NONE")
    if m:
        if "{" in m.group(0):
            s = s.replace(m.group(0), m.group(0).replace("{ ", "{ sql, ", 1))
        else:
            s = s.replace(m.group(0), m.group(0) + '\nimport { sql } from "drizzle-orm";')
    else:
        s = s.replace('import { db', 'import { sql } from "drizzle-orm";\nimport { db', 1)
if "from \"crypto\"" not in s and "import { randomUUID" not in s:
    m = re.search(r'^import .*drizzle-orm.*$', s, re.M)
    drizzle_line = m.group(0) if m else 'import { sql } from "drizzle-orm";'
    s = s.replace(drizzle_line, drizzle_line + '\nimport { randomUUID } from "crypto";', 1)
wr(p, s)

# ---------- 6. worker.py fail-soft ----------
p = ROOT + "/worker/worker.py"
s = rd(p).replace("\r\n", "\n")
if "sys.path.insert(0, PIPELINE)\n        import config as pcfg" in s and "media_path = os.path.join(HERE, \"tmp\", \"up_\"" in s:
    # check if already reordered
    i_path = s.find("media_path = os.path.join(HERE, \"tmp\", \"up_\"")
    i_syspath = s.find("sys.path.insert(0, PIPELINE)")
    if i_path != -1 and i_syspath != -1 and i_path < i_syspath:
        print("worker.py already fail-soft")
    else:
        old = """    for u in up.get("uploads", []):
        log(f"[worker] uploading {u['name']} -> X library of @{u['handle']}")
        sys.path.insert(0, PIPELINE)
        import config as pcfg
        import prep, upload
        tmp_profile = os.path.join(pcfg.PROFILES, f"_panel_{u['handle']}")
        session_file, _ = write_profile(tmp_profile, u["sessionJson"], {}, u["handle"],
                                        u["adsAccountId"], "", "")
        media_path = os.path.join(HERE, "tmp", "up_" + u["id"] + ".mp4")
        os.makedirs(os.path.dirname(media_path), exist_ok=True)
        try:
"""
        new = """    for u in up.get("uploads", []):
        log(f"[worker] uploading {u['name']} -> X library of @{u['handle']}")
        media_path = os.path.join(HERE, "tmp", "up_" + u["id"] + ".mp4")
        os.makedirs(os.path.dirname(media_path), exist_ok=True)
        try:
            sys.path.insert(0, PIPELINE)
            import config as pcfg
            import prep, upload
            tmp_profile = os.path.join(pcfg.PROFILES, f"_panel_{u['handle']}")
            session_file, _ = write_profile(tmp_profile, u["sessionJson"], {}, u["handle"],
                                            u["adsAccountId"], "", "")
"""
        assert old in s, "worker old block not found"
        s = s.replace(old, new)
        wr(p, s)
print("PHASE2 OK")
