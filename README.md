# X Panel — Video-Card Poster (Admin + User)

Web panel to post **any video to any X account** with the *"From \<domain\>"* website-card pattern.
Hosted on **GitHub + Vercel**; the actual posting runs on **your PC worker** (Vercel cannot run
Playwright/X-sessions — the proven pipeline stays local).

```
┌────────────┐  upload video   ┌───────────────────────┐  claim job   ┌─────────────────────────┐
│  BROWSER   │ ──────────────▶ │  PANEL (Vercel)       │ ───────────▶ │  WORKER (your PC)       │
│  user/admin│  connect account│  Postgres + Blob      │  secrets     │  x_poster pipeline      │
└────────────┘                 │  admin approvals      │  + media url │  amplify_video → card   │
      ▲                        │  jobs queue           │              │  → tweet w/ "From ..."  │
      └──────── done + tweet link ─────────────────────┴──────────────┴── report back           │
```

## Features (what you asked for)

| # | Requirement | How it works |
|---|-------------|--------------|
| 1 | **Media library sync** | Upload videos to the panel (Vercel Blob in prod / local `public/uploads` in dev). Listed in dashboard for every user, shared with admin. |
| 2 | **User connects multiple accounts** | Each user can connect many X accounts — paste the account's session cookies JSON + OAuth1 creds JSON + Ads account ID. Stored in DB, never leaked back to browser. |
| 3 | **Admin approval per account** | Every connected account starts `pending` → admin approves/rejects in the Admin panel. Only `approved` accounts can receive jobs. |
| 4 | **Post videos with link from library** | Dashboard: pick video → pick approved account → caption/URL/title → **Queue post**. Worker claims it, runs the proven 3-step recipe (amplify_video upload → VIDEO_WEBSITE card via Ads API v12 → CreateTweet with `card_uri`), posts to X, reports tweet link back. |

**Any account works** — nothing is hard-coded to a specific page. Account credentials live in the
DB row and the worker writes them to a temp pipeline profile per job.

## Project layout

```
x_panel/
├── app/                    # Next.js App Router (panel UI + APIs)
│   ├── dashboard/page.tsx  #   user panel: media library, accounts, post compose
│   ├── admin/page.tsx      #   admin panel: approvals, users, all posts
│   └── api/                #   /api/auth/* /api/media /api/accounts /api/jobs /api/worker/*
├── lib/
│   ├── db.ts               #   SQLite (dev) — swap to Postgres on Vercel
│   ├── schema.ts           #   users, accounts, media, jobs
│   ├── auth.ts             #   JWT sessions (jose) + bcrypt
│   └── storage.ts          #   Vercel Blob when BLOB_READ_WRITE_TOKEN set, else local
├── worker/
│   ├── worker.py           #   poller: claim job → download → run pipeline → report
│   └── config.json         #   {panel_url, worker_token}
└── profiles/               # (optional) pre-seed accounts instead of pasting in UI
```

## Local dev (this machine)

```bash
cd x_panel
npm install
# defaults are fine for local: SQLite file db, local uploads
npm run dev          # http://localhost:3000
```

First login creates the **admin** account (any email/password, min 8 chars).
Create users from Admin panel → Users.

Worker:

```bash
cd worker
# edit config.json -> panel_url, worker_token (match WORKER_TOKEN on server)
python worker.py --once        # claim 1 job, post it, exit
python worker.py --interval 60 # keep polling every 60s
```

## Deploy to GitHub + Vercel

1. **Push to GitHub**
   ```bash
   cd x_panel
   git init && git add -A && git commit -m "x panel"
   git branch -M main
   git remote add origin https://github.com/<you>/x-panel.git
   git push -u origin main
   ```
2. **Vercel** → New Project → import the repo (Vercel auto-detects Next.js).

3. **Set env vars in Vercel** (Project → Settings → Environment Variables):
   | Var | Value |
   |-----|-------|
   | `AUTH_SECRET` | long random string |
   | `WORKER_TOKEN` | long random string (same as worker/config.json) |
   | `DATABASE_URL` | your Postgres URL — add **Vercel Postgres** (Storage tab, free tier), copy its connection string |
   | `BLOB_READ_WRITE_TOKEN` | add **Vercel Blob** (Storage tab) — for the media library |

4. **Vercel Postgres**: Storage → Create → Postgres (Neon, free). After creation Vercel offers
   `DATABASE_URL` — accept it. The schema auto-creates on first API call (`initDb()`).

5. **Worker on your PC** (or any always-on machine with the pipeline):
   ```bash
   cd worker
   # config.json:
   #   "panel_url":      "https://your-app.vercel.app"
   #   "worker_token":   "<same as WORKER_TOKEN env>"
   python worker.py --interval 60
   ```
   Runs forever; leave it on (or wrap in Task Scheduler / a cron).

That's it. Users log in → upload/see media → connect accounts → admin approves →
pick video + account + link → Queue post → worker posts it with the card → link appears in Posts.

## Security notes

- Account secrets (`session_json`, `oauth1_json`) are stored server-side and only returned to
  the authenticated worker (via `x-worker-token` header). Browser APIs strip them.
- Worker token + `AUTH_SECRET` must be strong random strings in prod.
- Media uploads capped at 200 MB.
- For prod Postgres the schema uses the same table names/columns as the SQLite dev schema —
  swap `lib/db.ts` to drizzle-orm/neon-http if you prefer one code path (see comment in file).