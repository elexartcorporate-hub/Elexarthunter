#!/usr/bin/env bash
#
# wa-setup.sh — Truly all-in-one WhatsApp setup for VPS.
# Idempotent. Aman dijalankan berulang.
#
# Auto-detects:
#   - APP_DIR (current dir or BASH_SOURCE)
#   - Backend supervisor program name (any 'backend' program)
#   - Git repo (auto pulls latest)
#   - Python venv (auto pip install)
#
# Steps:
#   1. git pull (kalau ada .git)
#   2. Backend: pip install -r requirements.txt + restart
#   3. WA Service: generate secret, supervisor config, yarn install, start
#   4. Verify: backend /api/whatsapp/health + wa-service /health
#
# Usage:
#   sudo bash wa-setup.sh
#
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLU}▶${NC} $*"; }
ok()   { echo -e "${GRN}✓${NC} $*"; }
warn() { echo -e "${YEL}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }

# ─── Config (auto-detect) ─────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR_NAME="${SUPERVISOR_NAME:-hunter-wa-service}"
SUPERVISOR_CONF="/etc/supervisor/conf.d/${SUPERVISOR_NAME}.conf"
WA_DIR="$APP_DIR/wa-service"
BACKEND_DIR="$APP_DIR/backend"
BACKEND_ENV="$BACKEND_DIR/.env"

# ─── Pre-flight ───────────────────────────────────────────────────────────
log "WA-Service Setup • APP_DIR = $APP_DIR"
[[ -d "$WA_DIR"      ]] || { err "wa-service/ folder tidak ada di $APP_DIR"; exit 1; }
[[ -f "$BACKEND_ENV" ]] || { err "backend/.env tidak ada di $BACKEND_ENV"; exit 1; }

for bin in node yarn supervisorctl curl openssl; do
  command -v "$bin" >/dev/null 2>&1 || { err "$bin tidak terinstall"; exit 1; }
done
NODE_BIN="$(command -v node)"

# ─── 0. Git pull (kalau di git repo) ─────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  log "Git: pull latest …"
  if git -C "$APP_DIR" diff --quiet 2>/dev/null && git -C "$APP_DIR" diff --cached --quiet 2>/dev/null; then
    git -C "$APP_DIR" pull --ff-only 2>&1 | tail -3 || warn "git pull gagal (lanjut)"
    ok "Code latest"
  else
    warn "Ada uncommitted changes — skip git pull (commit/stash dulu)"
  fi
fi

# ─── 1. Secret ────────────────────────────────────────────────────────────
if grep -q "^WA_SERVICE_SECRET=" "$BACKEND_ENV" 2>/dev/null; then
  SECRET="$(grep '^WA_SERVICE_SECRET=' "$BACKEND_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [[ -z "$SECRET" ]]; then
    SECRET="$(openssl rand -hex 32)"
    sed -i "s|^WA_SERVICE_SECRET=.*|WA_SERVICE_SECRET=$SECRET|" "$BACKEND_ENV"
    ok "Secret regenerated (was empty)"
  else
    ok "Reusing WA_SERVICE_SECRET dari backend/.env"
  fi
else
  SECRET="$(openssl rand -hex 32)"
  echo "WA_SERVICE_SECRET=$SECRET" >> "$BACKEND_ENV"
  ok "Generated new WA_SERVICE_SECRET"
fi

if ! grep -q "^WA_SERVICE_URL=" "$BACKEND_ENV" 2>/dev/null; then
  echo "WA_SERVICE_URL=http://localhost:3002" >> "$BACKEND_ENV"
  ok "Added WA_SERVICE_URL"
fi

# ─── 2. Backend: pip install + restart ────────────────────────────────────
# Find any supervisor program with 'backend' in the name (auto-detect)
BACKEND_PROGRAMS="$(sudo supervisorctl status 2>&1 | awk '{print $1}' | grep -i backend | grep -v "^$SUPERVISOR_NAME$" || true)"

if [[ -f "$BACKEND_DIR/requirements.txt" ]]; then
  log "Backend: pip install -r requirements.txt …"
  # Try venv first, fallback to system pip
  if [[ -d "$BACKEND_DIR/venv" ]]; then
    "$BACKEND_DIR/venv/bin/pip" install -q -r "$BACKEND_DIR/requirements.txt" 2>&1 | tail -5 || warn "pip install warnings"
  elif [[ -d "$APP_DIR/venv" ]]; then
    "$APP_DIR/venv/bin/pip" install -q -r "$BACKEND_DIR/requirements.txt" 2>&1 | tail -5 || warn "pip install warnings"
  else
    pip install -q -r "$BACKEND_DIR/requirements.txt" 2>&1 | tail -5 || pip3 install -q -r "$BACKEND_DIR/requirements.txt" 2>&1 | tail -5 || warn "pip not found"
  fi
  ok "Backend deps installed"
fi

if [[ -n "$BACKEND_PROGRAMS" ]]; then
  for prog in $BACKEND_PROGRAMS; do
    log "Restarting backend program: $prog …"
    sudo supervisorctl restart "$prog" 2>&1 | tail -2 || true
  done
  sleep 3
  # Check status
  for prog in $BACKEND_PROGRAMS; do
    STATUS="$(sudo supervisorctl status "$prog" 2>&1 || true)"
    if echo "$STATUS" | grep -q "RUNNING"; then
      ok "Backend '$prog' RUNNING"
    else
      err "Backend '$prog' GAGAL START: $STATUS"
      warn "Cek log: sudo tail -n 50 /var/log/supervisor/${prog}.err.log"
      echo ""
      echo "── Last 30 lines of ${prog} error log ──"
      sudo tail -n 30 "/var/log/supervisor/${prog}.err.log" 2>/dev/null || echo "(log tidak bisa dibaca)"
      echo "─────────────────────────────────────────"
    fi
  done
else
  warn "Tidak ada supervisor program dengan 'backend' di namanya — skip backend restart"
  warn "Restart manual: sudo supervisorctl restart <nama-backend-anda>"
fi

# ─── 3. WA Service supervisor config ──────────────────────────────────────
log "Writing supervisor config → $SUPERVISOR_CONF"
sudo tee "$SUPERVISOR_CONF" > /dev/null <<EOF
[program:${SUPERVISOR_NAME}]
command=${NODE_BIN} ${WA_DIR}/src/index.js
directory=${WA_DIR}
autostart=true
autorestart=true
environment=NODE_ENV="production",MONGO_URL="mongodb://localhost:27017",DB_NAME="lead_hunter_db",WA_SERVICE_PORT="3002",WA_SERVICE_SECRET="${SECRET}"
stderr_logfile=/var/log/supervisor/${SUPERVISOR_NAME}.err.log
stdout_logfile=/var/log/supervisor/${SUPERVISOR_NAME}.out.log
stopsignal=TERM
stopwaitsecs=15
stopasgroup=true
killasgroup=true
EOF
ok "Supervisor config written"

# ─── 4. WA Service yarn install + start ──────────────────────────────────
log "WA Service: yarn install …"
cd "$WA_DIR"
yarn install --silent 2>&1 | tail -3 || yarn install 2>&1 | tail -3
cd "$APP_DIR"
ok "Node deps installed"

log "Starting wa-service …"
sudo supervisorctl reread > /dev/null
sudo supervisorctl update > /dev/null
sudo supervisorctl restart "$SUPERVISOR_NAME" > /dev/null 2>&1 || sudo supervisorctl start "$SUPERVISOR_NAME" > /dev/null 2>&1 || true
sleep 3
WA_STATUS="$(sudo supervisorctl status "$SUPERVISOR_NAME" 2>&1)"
if echo "$WA_STATUS" | grep -q "RUNNING"; then
  ok "wa-service RUNNING"
else
  err "wa-service GAGAL: $WA_STATUS"
  echo ""
  echo "── Last 30 lines of $SUPERVISOR_NAME error log ──"
  sudo tail -n 30 "/var/log/supervisor/${SUPERVISOR_NAME}.err.log" 2>/dev/null || echo "(log not accessible)"
  echo "─────────────────────────────────────────────────"
  exit 1
fi

# ─── 5. Verify ───────────────────────────────────────────────────────────
log "Verifying …"
sleep 2

# A. WA service local health
WA_HEALTH="$(curl -fsS --max-time 5 http://localhost:3002/health 2>&1 || true)"
if echo "$WA_HEALTH" | grep -q '"ok":true'; then
  ok "wa-service /health OK (port 3002)"
else
  err "wa-service /health GAGAL: $WA_HEALTH"
  exit 1
fi

# B. Backend /api/whatsapp/health (full stack test)
BACKEND_HEALTH="$(curl -fsS --max-time 5 http://localhost:8001/api/whatsapp/health 2>&1 || true)"
if echo "$BACKEND_HEALTH" | grep -q '"wa_service":"ok"'; then
  ok "Backend /api/whatsapp/health OK"
elif echo "$BACKEND_HEALTH" | grep -q '"detail":"Not Found"'; then
  err "Backend masih return 'Not Found' untuk /api/whatsapp/health"
  err "Artinya: backend code di VPS BELUM yang terbaru."
  warn "Coba fix:"
  warn "  1. cd $APP_DIR && git pull"
  warn "  2. Restart backend: sudo supervisorctl restart <nama-backend>"
  warn "  3. Atau pakai 'deploy' command (kalau ada)"
  warn "  4. Lalu cek: curl http://localhost:8001/api/whatsapp/health"
  exit 1
else
  warn "Backend tidak respond di port 8001 (mungkin port lain)"
  warn "Test manual: curl https://hunter.elexart.com/api/whatsapp/health"
fi

echo
ok "═══════════════════════════════════════════════"
ok " SELESAI! WA Service SIAP. Buka /whatsapp di browser."
ok "═══════════════════════════════════════════════"
echo
echo "Status   : sudo supervisorctl status $SUPERVISOR_NAME"
echo "Logs     : sudo tail -f /var/log/supervisor/${SUPERVISOR_NAME}.err.log"
echo "Health   : curl http://localhost:3002/health"
echo "Endpoint : curl https://hunter.elexart.com/api/whatsapp/health"
