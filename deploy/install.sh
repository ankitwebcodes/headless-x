#!/usr/bin/env bash
# ============================================================================
#  repostops.xyz  ::  Oracle Cloud Always Free (ARM / aarch64) installer
#
#  Installs Node 22 + cloudflared, builds the Next.js panel, installs three
#  systemd services (panel, DM worker, tunnel) and starts them.
#
#  Run as root ON THE SERVER, with the code already at /opt/xpanel.
#      sudo bash /opt/xpanel/deploy/install.sh
#
#  Safe to re-run: it is idempotent.
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/xpanel}"
APP_USER="${APP_USER:-xpanel}"
LOG_DIR="/var/log/xpanel"
CFG_DIR="/etc/cloudflared"
NODE_MAJOR="${NODE_MAJOR:-22}"

say()  { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ok\033[0m  %s\n" "$*"; }
warn() { printf "\033[1;33m  !!  %s\033[0m\n" "$*"; }
die()  { printf "\n\033[1;31m!! %s\033[0m\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
say "Pre-flight"
[[ $EUID -eq 0 ]] || die "Must run as root.  Try:  sudo bash $0"
[[ -f "$APP_DIR/package.json" ]] || die "No package.json at $APP_DIR — upload the code first (deploy/push-to-server.sh)."
[[ -f "$APP_DIR/.env.local"   ]] || die "Missing $APP_DIR/.env.local — the panel needs DATABASE_URL etc."
[[ -f "$APP_DIR/deploy/xpanel.service" ]] || die "deploy/*.service missing — did the whole folder upload?"
ok "architecture $(uname -m)   (ARM = aarch64)"
ok "app dir      $APP_DIR"

# ---------------------------------------------------------------------------
say "1/6  Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git rsync build-essential
ok "base packages installed"

# ---------------------------------------------------------------------------
say "2/6  Node $NODE_MAJOR (arm64)"
CUR_MAJOR="$( (node -v 2>/dev/null || echo v0) | sed 's/^v//' | cut -d. -f1 )"
if [[ "$CUR_MAJOR" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
ok "node $(node -v)   npm $(npm -v)"

# ---------------------------------------------------------------------------
say "3/6  cloudflared (arm64)"
if ! command -v cloudflared >/dev/null 2>&1; then
  case "$(uname -m)" in
    aarch64|arm64) CF_ARCH=arm64 ;;
    x86_64)        CF_ARCH=amd64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"
  dpkg -i /tmp/cloudflared.deb >/dev/null
  rm -f /tmp/cloudflared.deb
fi
ok "cloudflared $(cloudflared --version 2>&1 | head -1)"

# ---------------------------------------------------------------------------
say "4/6  Service user + directories"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "created user $APP_USER"
else
  ok "user $APP_USER already exists"
fi
mkdir -p "$LOG_DIR" "$CFG_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
chmod 600 "$APP_DIR/.env.local" 2>/dev/null || true
chmod 600 "$CFG_DIR/token.env"  2>/dev/null || true
ok "logs at $LOG_DIR"

# ---------------------------------------------------------------------------
say "5/6  Build the panel"
cd "$APP_DIR"
# --include=dev: next/typescript/tailwind are needed to BUILD, even though the
# runtime only needs the production tree.
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && npm ci --include=dev"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && npm run build"
ok "next build finished"

# ---------------------------------------------------------------------------
say "6/6  systemd services"
install -m 644 "$APP_DIR/deploy/xpanel.service"      /etc/systemd/system/xpanel.service
install -m 644 "$APP_DIR/deploy/dmworker.service"    /etc/systemd/system/dmworker.service
install -m 644 "$APP_DIR/deploy/cloudflared.service" /etc/systemd/system/cloudflared.service
systemctl daemon-reload
systemctl enable --now xpanel.service
systemctl enable --now dmworker.service
ok "panel + dm worker enabled and started"

if [[ -f "$CFG_DIR/token.env" ]]; then
  systemctl enable --now cloudflared.service
  ok "cloudflared tunnel enabled and started"
else
  warn "No $CFG_DIR/token.env yet — tunnel NOT started."
  warn "Copy it from the PC (deploy/push-to-server.sh does this), then:"
  warn "    sudo systemctl enable --now cloudflared"
fi

# ---------------------------------------------------------------------------
say "Health check"
sleep 6
for svc in xpanel dmworker cloudflared; do
  if systemctl is-active --quiet "$svc"; then
    printf "\033[1;32m  ok\033[0m  %-12s %s\n" "$svc" "$(systemctl show -p ActiveState --value "$svc")"
  else
    printf "\033[1;33m  ??\033[0m  %-12s %s   (journalctl -u %s -n 50)\n" "$svc" "$(systemctl show -p ActiveState --value "$svc")" "$svc"
  fi
done

if curl -fsS -o /dev/null -m 10 http://127.0.0.1:3000/dm; then
  ok "panel answering on 127.0.0.1:3000"
else
  warn "panel not answering on :3000 yet — give it a few seconds, then: journalctl -u xpanel -n 80"
fi

printf "\n\033[1;32mDone.\033[0m  Logs: journalctl -u xpanel -f  |  journalctl -u dmworker -f\n\n"
