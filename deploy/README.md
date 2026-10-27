# repostops.xyz — run it with no PC

Hosts the whole DM automation on **Oracle Cloud Always Free (ARM)**. Your PC stops
being involved: the panel and the worker run 24/7 on the server, and you drive
everything from a phone browser.

**Cost: ₹0.** Oracle's Always Free tier gives 4 ARM cores / 24 GB RAM forever.

---

## Why this works with no rewrite

The DM automation was already headless. It never used Chrome:

| Piece | Reality |
|---|---|
| `lib/xdm.ts` | plain `fetch()` → `x.com/i/api/1.1/dm`, `auth_token` cookie + `x-csrf-token` from `ct0` |
| Playwright / Chromium | only in throwaway diag scripts — **not in the run path** |
| Database | Neon Postgres (already cloud) |
| Media | Vercel Blob (already cloud) |
| Worker | `scripts/dm-worker.mjs` — a 2 s loop calling `dispatchDmWorker()` |

The PC was only ever *the machine the process happened to run on*. We just move it.

```
[phone browser] ──┐
[extension → cookies] ──┴─→ panel (:3000) ──→ Neon Postgres ──→ dm-worker ──→ x.com
                             all of this now lives on the Oracle box
```

---

## Step 1 — Create the Oracle instance

1. Sign in at **cloud.oracle.com** → hamburger → **Compute → Instances → Create instance**
2. **Name:** `repostops`
3. **Image:** *Canonical Ubuntu 24.04* — pick the **aarch64** build
   (if it says `x86_64` you picked the wrong one)
4. **Shape:** *Ampere* → **VM.Standard.A1.Flex**
   → **1 OCPU / 6 GB** is plenty (free tier allows up to 4 / 24 GB)
5. **Networking:** default VCN, public subnet, **Assign a public IPv4 address: Yes**
6. **Add SSH keys:** *Paste public key* — paste your `id_rsa.pub`
   (Windows: `cat ~/.ssh/id_rsa.pub`; no key? run `ssh-keygen -t rsa -b 4096`)
7. **Boot volume:** default 47 GB is fine (free tier allows 200 GB)
8. **Create**

> **"Out of host capacity"** is the single most common Oracle error — ARM is popular.
> Fixes, in order: try a different **Availability Domain**; retry every few hours;
> or accept a 1 OCPU / 6 GB shape (smaller asks succeed more often).

Wait ~60 s, then grab the **Public IP address** from the instance page.

---

## Step 2 — Deploy from your PC

In git-bash on the PC:

```bash
cd /c/Users/ankit/x_panel
bash deploy/push-to-server.sh ubuntu@<PUBLIC-IP>
```

That single command packages the code, uploads it, stages the Cloudflare tunnel
token, then runs the installer remotely. It takes ~4–6 minutes (mostly `npm ci`
and `next build` on 1 ARM core).

---

## Step 3 — Verify

```bash
ssh ubuntu@<PUBLIC-IP>
sudo systemctl status xpanel dmworker cloudflared --no-pager
curl -sI http://127.0.0.1:3000/dm | head -1      # expect: HTTP/1.1 200 OK
```

Then open **https://repostops.xyz/dm** on your phone.

---

## Step 4 — Switch over (important)

The Cloudflare tunnel only tolerates one *healthy* origin. If the PC's copy keeps
running, requests round-robin between the server and the dead PC panel → random `502`s.

**On the PC, stop all three:**

```bash
# stop the panel + worker windows, then kill the PC tunnel:
taskkill //F //IM cloudflared.exe
```

Or just **shut the PC down** — the server doesn't need it any more.

The Chrome extension still works unchanged: it already lists `repostops.xyz` in its
host permissions, so cookie ingestion goes straight to the server.

---

## Day-2 operations

| Task | Command |
|---|---|
| Watch the panel | `journalctl -u xpanel -f` |
| Watch the worker | `journalctl -u dmworker -f` |
| Watch the tunnel | `journalctl -u cloudflared -f` |
| Restart everything | `sudo systemctl restart xpanel dmworker cloudflared` |
| Rebuild after a push | `sudo bash /opt/xpanel/deploy/update.sh` |
| Edit secrets | `sudo nano /opt/xpanel/.env.local` then restart |
| Panel log file | `tail -f /var/log/xpanel/panel.log` |

---

## Gotchas — read these

**1. IP change is the real risk.** Today all your X accounts talk to X from your
home IP. On the server they all come from **one datacenter IP**, and X correlates
accounts by IP. Mitigations, cheapest first:
- stagger per-account so no two accounts act in the same second (already partly in `dm-policy.ts`)
- keep volume modest per account per day
- per-account residential proxy (~$2–3/account/mo) if you scale past a few accounts

**2. `344` is X's own daily cap.** No architecture bypasses it. `226` is already
handled: park → jittered backoff → auto-resume.

**3. Oracle idle reclamation.** Always Free instances can be reclaimed if genuinely
idle. Your worker polls every 2 s, so the box is never idle. Keep an eye on it for
the first week.

**4. Oracle's default firewall blocks inbound ports.** We don't need any —
`cloudflared` is outbound-only. That's why this design needs **no open ports** and
**no public web server**.

**5. Never commit `.env.local`.** It holds `DATABASE_URL`, blob tokens and keys.
`push-to-server.sh` uploads it over SSH only; it stays gitignored.

---

## Files in this folder

| File | Runs on | Purpose |
|---|---|---|
| `install.sh` | server (root) | full installer: Node 22, cloudflared, build, 3 services |
| `push-to-server.sh` | PC (git-bash) | package → upload → token → install |
| `update.sh` | server (root) | quick `npm ci` + `next build` + restart |
| `xpanel.service` | server | Next.js panel on `:3000` |
| `dmworker.service` | server | the DM automation worker |
| `cloudflared.service` | server | tunnel `repostops.xyz` → `localhost:3000` |
