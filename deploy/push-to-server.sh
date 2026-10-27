#!/usr/bin/env bash
# ============================================================================
#  repostops.xyz  ::  PC  ->  Oracle box   deployer
#
#  Run this FROM THE PC (git-bash). It:
#     1. packages x_panel (no node_modules / .next / logs)
#     2. uploads it to the server
#     3. stages the Cloudflare tunnel token (value is never printed)
#     4. extracts, then runs deploy/install.sh on the server over SSH
#
#  Usage:
#      bash deploy/push-to-server.sh ubuntu@<public-ip>
#      bash deploy/push-to-server.sh ubuntu@<public-ip> ~/.ssh/oracle.key
#
#  Re-running is safe: it stops the services, swaps the tree, reinstalls.
# ============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

SERVER="${1:-}"
KEY="${2:-}"
if [[ -z "$SERVER" ]]; then
  echo "usage: bash deploy/push-to-server.sh ubuntu@<public-ip> [ssh-key-path]"
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"          # .../x_panel
PARENT="$(cd "$SRC/.." && pwd)"        # .../ankit
CFG="/c/Users/ankit/.cloudflared"
TARBALL="/tmp/xpanel-deploy.tar.gz"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ConnectTimeout=20)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

echo "==> packaging $SRC"
rm -f "$TARBALL"
tar czf "$TARBALL" -C "$PARENT" \
  --exclude='x_panel/node_modules' \
  --exclude='x_panel/.next' \
  --exclude='x_panel/.git' \
  --exclude='x_panel/backups' \
  --exclude='x_panel/diag' \
  --exclude='x_panel/diag_ud' \
  --exclude='x_panel/*.log' \
  --exclude='x_panel/*.tsbuildinfo' \
  --exclude='x_panel/.env*.bak' \
  x_panel
du -h "$TARBALL"

echo "==> uploading to $SERVER"
scp "${SSH_OPTS[@]}" "$TARBALL" "$SERVER:/tmp/xpanel-deploy.tar.gz"

TOKEN_SRC=""
for f in "$CFG/tunnel-token.txt" "$CFG/token.txt"; do
  if [[ -f "$f" ]]; then TOKEN_SRC="$f"; break; fi
done
if [[ -n "$TOKEN_SRC" ]]; then
  TMPTOK="$(mktemp)"
  printf 'TUNNEL_TOKEN=%s\n' "$(tr -d '\r\n' < "$TOKEN_SRC")" > "$TMPTOK"
  scp "${SSH_OPTS[@]}" "$TMPTOK" "$SERVER:/tmp/token.env"
  rm -f "$TMPTOK"
  echo "==> tunnel token staged (value never printed)"
else
  echo "!!  no tunnel token found in $CFG — the tunnel will NOT start"
fi

echo "==> installing on the server (this takes a few minutes: npm ci + next build)"
ssh "${SSH_OPTS[@]}" "$SERVER" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo systemctl stop xpanel dmworker 2>/dev/null || true

sudo tar xzf /tmp/xpanel-deploy.tar.gz -C /opt --no-same-owner
if [ -d /opt/x_panel ]; then
  sudo rm -rf /opt/xpanel
  sudo mv /opt/x_panel /opt/xpanel
fi

sudo mkdir -p /etc/cloudflared
if [ -f /tmp/token.env ]; then
  sudo mv /tmp/token.env /etc/cloudflared/token.env
  sudo chmod 600 /etc/cloudflared/token.env
  echo "    tunnel token in place"
fi

sudo bash /opt/xpanel/deploy/install.sh
REMOTE

echo
echo "==> done.  Panel:  https://repostops.xyz/dm"
echo "    NOTE: stop the PC copies so they stop competing for the tunnel:"
echo "        cloudflared on the PC  +  start-panel.bat  +  start-dm-worker.bat"
