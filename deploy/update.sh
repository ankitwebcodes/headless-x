#!/usr/bin/env bash
# ============================================================================
#  repostops.xyz  ::  quick rebuild + restart (server side)
#
#  Use after deploy/push-to-server.sh has uploaded new source, when you only
#  want to rebuild rather than re-run the whole installer.
#
#      sudo bash /opt/xpanel/deploy/update.sh
# ============================================================================
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/xpanel}"
APP_USER="${APP_USER:-xpanel}"

[[ $EUID -eq 0 ]] || exec sudo bash "$0" "$@"
[[ -f "$APP_DIR/package.json" ]] || { echo "no $APP_DIR/package.json"; exit 1; }

echo "==> npm ci"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && npm ci --include=dev"
echo "==> next build"
sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && npm run build"
echo "==> restart"
systemctl restart xpanel.service dmworker.service
sleep 4
systemctl --no-pager --lines=0 status xpanel.service dmworker.service || true
echo
echo "==> tail of panel log"
tail -n 15 /var/log/xpanel/panel.log 2>/dev/null || true
