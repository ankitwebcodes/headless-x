# repostops.xyz/dm — source bundle

Everything that serves **repostops.xyz/dm** — the cookie-driven DM automation panel.
Zipped 2026-10-27.

## ⚠️ Secrets are deliberately NOT in this zip

Removed before packaging:

| Removed | Why |
|---|---|
| `.env.local`, `.env.prod` | live `DATABASE_URL`, `X_AUTH_*`, `AUTH_SECRET` |
| `.vercel/.env.production.local` | live Postgres URL + Vercel tokens |
| `.automation-auth.json` | bcrypt hash for the `/automation` door |
| `.tok.tmp` | a signed JWT |
| `xgrab-extension/` | `popup.js` contains a hardcoded bearer |
| `node_modules/`, `.next/`, `.git/`, `backups/`, `*.log` | regenerable / local state |

`.env.example` **is** included — it is all placeholders, copy it to `.env.local`
and fill in your own values.

## How to run it

```bash
npm ci
cp .env.example .env.local     # then fill in real values
npm run build
npm run start                  # panel on :3000
node --experimental-strip-types scripts/dm-worker.mjs   # the DM worker
```

Requires **Node 22** (the worker uses `--experimental-strip-types`).

## Where things live

| Path | What it is |
|---|---|
| `app/dm/page.tsx` + `stages.module.css` | the panel UI — 4 stages: accounts → scan → message/start → logs |
| `app/api/dm/{session,probe,scan,run,history,report}/` | the API the panel calls |
| `lib/xdm.ts` | X DM client — plain `fetch()`, cookie auth. **No browser.** |
| `lib/dm-run.ts` | the run engine: read → repost → reply, pacing, park/revive |
| `lib/dm-store.ts` | durable state (Neon Postgres, or local files in dev) |
| `lib/dm-policy.ts` | scan scope, wave size, jitter, strict mode |
| `lib/dm-history.ts` | the "Clear data" reset |
| `scripts/dm-worker.mjs` | the 2s polling loop that dispatches runs |
| `deploy/` | Oracle Cloud Always Free (ARM) installer — **not used yet** |

## Key facts

- **No Chrome anywhere in this path.** `lib/xdm.ts` talks to `x.com/i/api/1.1/dm`
  directly with the account's `auth_token` cookie + `x-csrf-token` from `ct0`.
  Only `lib/xflow.ts` (the `/automation` section) drives Chrome — that part is
  PC-bound and stays separate, which is what was asked for.
- **`/dm` is fully separable from `/automation`.** `/dm` can run headless on a server;
  `/automation` cannot, because it spawns `controller.py` and drives Chrome profiles.

## Fix included in this build

`lib/dm-store.ts` — Windows atomic-write race.

The store wrote state by writing `<file>.<uuid>.tmp` then `rename()`-ing it over the
target. On Windows, `rename`-over-existing throws **`EPERM`** whenever any other
handle still has the destination open — which happens routinely because
`listDmDocs()` reads files while `updateDmDoc()` is renaming over them, and because
the panel and the worker are separate processes writing the same store.

A failed rename **silently lost the whole write**: the run's state dropped a chat and
the run parked as `needs_attention` instead of `finished`.

Fixed with `renameWithRetry()` — retries `EPERM`/`EACCES`/`EBUSY` with a 5→60 ms
backoff (~330 ms total) instead of throwing.

**Verified:** before, 2 of 4 suite runs failed (3 distinct tests, 50% failure rate).
After, **7 of 7 consecutive runs pass 69/69** with zero cancellations.
