#!/usr/bin/env bash
#
# deploy.sh — Manual deploy script untuk Contabo VPS
#
# Cara pakai (jalankan di SERVER, bukan di Emergent):
#   1. SSH ke VPS:    ssh deploy@your-vps-ip
#   2. cd /var/www/your-domain
#   3. bash deploy.sh
#
# ATAU set alias `deploy` di ~/.bashrc:
#   alias deploy='cd /var/www/hunter.elexart.com && bash deploy.sh'
#   Lalu cukup ketik `deploy` di mana saja.
#
set -euo pipefail

# ─── Config ────────────────────────────────────────────────────────────────
# Ganti dengan domain Anda yang sesungguhnya:
DOMAIN="${DOMAIN:-hunter.elexart.com}"
SUPERVISOR_BACKEND="${SUPERVISOR_BACKEND:-hunter-backend}"
REACT_APP_BACKEND_URL="${REACT_APP_BACKEND_URL:-https://$DOMAIN}"
BRANCH="${BRANCH:-main}"
# ───────────────────────────────────────────────────────────────────────────

START_TIME=$(date +%s)
log() { echo -e "\033[1;34m[deploy]\033[0m $*"; }
ok()  { echo -e "\033[1;32m[ ok ]\033[0m $*"; }
err() { echo -e "\033[1;31m[fail]\033[0m $*" >&2; }

# ─── 1. Pull terbaru dari GitHub ───────────────────────────────────────────
log "Pull latest dari origin/$BRANCH …"
git fetch --all --prune
git reset --hard "origin/$BRANCH"
COMMIT=$(git log -1 --pretty=format:'%h %s' | head -c 80)
ok "On $COMMIT"

# ─── 2. Backend: install deps + restart ────────────────────────────────────
log "Backend: pip install …"
cd backend
if [[ ! -d venv ]]; then
  python3 -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
deactivate
cd ..

log "Restart backend (supervisor: $SUPERVISOR_BACKEND) …"
sudo supervisorctl restart "$SUPERVISOR_BACKEND"
ok "Backend up"

# ─── 3. Frontend: build production ─────────────────────────────────────────
log "Frontend: yarn install + build (REACT_APP_BACKEND_URL=$REACT_APP_BACKEND_URL) …"
cd frontend
yarn install --frozen-lockfile --silent
REACT_APP_BACKEND_URL="$REACT_APP_BACKEND_URL" yarn build
cd ..
ok "Frontend built (frontend/build)"

# ─── 4. Reload Nginx (serve frontend/build statis) ─────────────────────────
log "Reload Nginx …"
sudo nginx -t
sudo systemctl reload nginx
ok "Nginx reloaded"

# ─── 5. Health check ───────────────────────────────────────────────────────
log "Health check https://$DOMAIN …"
sleep 3
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN" || echo "000")
API=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN/api/" || echo "000")
ELAPSED=$(($(date +%s) - START_TIME))

echo
echo "════════════════════════════════════════════════"
if [[ "$HTTP" =~ ^(200|301|302)$ && "$API" =~ ^(200|301|302)$ ]]; then
  ok "Deploy SUKSES dalam ${ELAPSED}s"
  echo "    https://$DOMAIN  →  HTTP $HTTP"
  echo "    https://$DOMAIN/api/  →  HTTP $API"
else
  err "Deploy SELESAI tapi health check gagal"
  echo "    https://$DOMAIN  →  HTTP $HTTP"
  echo "    https://$DOMAIN/api/  →  HTTP $API"
  echo "    Cek log: sudo tail -f /var/log/supervisor/${SUPERVISOR_BACKEND}.err.log"
  exit 1
fi
echo "════════════════════════════════════════════════"
