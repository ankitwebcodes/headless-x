# DM Backend — cookie-only, no Chrome, no extension

Server-side reimplementation of what the SUPER X extension does with DMs.
Same structure as the existing composer/post system: a stored `sessionJson`
cookie blob → authenticated calls to X's own web endpoints.

Nothing runs in the browser. No local CPU. It works from the panel alone.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/dm` | GET | The console UI |
| `/api/dm/session` | GET / POST / DELETE | Store / list / remove the account session |
| `/api/dm/probe` | POST | Raw endpoint diagnostics (run this first) |
| `/api/dm/scan` | POST | Scan every chat → totals + chat list |
| `/api/dm/run` | POST | Do the work (send the message) |

All four API routes require a panel login (they return `401` otherwise).

## Setup

1. Open **`https://repostops.xyz/dm`** and log in with the panel account.
2. Get the automation account's cookies from a signed-in browser:
   `x.com` → DevTools → **Application** → **Cookies** → `https://x.com`.
   You need at least **`auth_token`** and **`ct0`** (both are httpOnly, so they
   can only be copied from DevTools, not from page JavaScript).
3. Paste them into the **Account session** box. Two formats are accepted:

   ```
   auth_token=…; ct0=…
   ```

   or a JSON export:

   ```json
   [{"name":"auth_token","value":"…"},{"name":"ct0","value":"…"}]
   ```

4. **Save & verify** → the badge turns green and shows `live @handle`.
5. **Probe endpoints** (first time only) → shows the raw status + body for every
   candidate endpoint, so a failing call can be diagnosed exactly.

## Scanning

**Scan inbox** returns:

- **Total chats** — every conversation returned by the inbox
- **Active** — normal (trusted) conversations
- **Inactive** — message requests / suspicious / low-quality
- **Unseen** — the last message came *from the other person*
- **Groups** — group DMs
- **Unread** — sum of per-chat unread counters

## Running the work

Pick a target set (`unseen` / `active` / `inactive` / `all`), write the message,
and press **Start**. `{name}` in the message is replaced with the chat handle.

- **Dry run** (default ON) does everything except actually send — use it first.
- **Delay** is the gap between sends (default 9000 ms) — keep it sane.
- The run is **resumable**: each call works inside a time budget and returns the
  chats it did not reach, which the console automatically feeds back in. Safe on
  serverless hosts.
- Ticking specific rows in the table overrides the mode filter.

## Transports

Every operation tries more than one transport and keeps raw diagnostics:

- **Inbox** — `GET /i/api/1.1/dm/inbox_initial_state.json` → then GraphQL
  `DMInboxTimeline` (queryId scraped live from X's bundle).
- **Send** — GraphQL `useSendMessageMutation` → `POST
  /i/api/1.1/dm/conversation/{id}/send_message.json` (JSON) → the same endpoint
  form-encoded (legacy shape).

GraphQL queryIds rotate, so they are extracted at runtime from the signed-in
bundle (`x.com/home` + `x.com/messages` → entry file → `assets/*.js` chunks)
rather than hard-coded. If a transport fails, the diagnostics panel shows the
exact status and response body.

## Storage

- `DATABASE_URL` / `POSTGRES_URL` set → Postgres table `dm_sessions`.
- Otherwise → `.dm-sessions.json` in the project root (gitignored).

Cookie values are never returned to the browser — only `id`, `label`,
`updatedAt`.
