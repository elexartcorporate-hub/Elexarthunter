#!/usr/bin/env bash
#
# wa-setup.sh — All-in-one WhatsApp (Baileys) sidecar service installer.
# Auto-detect APP_DIR, generate secret, write supervisor config, install
# Node deps, restart everything, verify. Idempotent — aman dijalankan ulang.
#
# Usage:
#   sudo bash wa-setup.sh              # interactive
#   sudo bash wa-setup.sh --quiet      # no prompts
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
SUPERVISOR_BACKEND="${SUPERVISOR_BACKEND:-hunter-backend}"
SUPERVISOR_CONF="/etc/supervisor/conf.d/${SUPERVISOR_NAME}.conf"
WA_DIR="$APP_DIR/wa-service"
BACKEND_ENV="$APP_DIR/backend/.env"

# ─── Pre-flight checks ────────────────────────────────────────────────────
log "WA-Service Setup • APP_DIR = $APP_DIR"

if [[ ! -d "$WA_DIR" ]]; then
  err "wa-service folder tidak ditemukan di $WA_DIR"
  err "Pastikan kamu di dalam folder app (yang ada wa-service/), lalu jalankan ulang."
  exit 1
fi

if [[ ! -f "$BACKEND_ENV" ]]; then
  err "backend/.env tidak ditemukan di $BACKEND_ENV"
  exit 1
fi

# Need node, yarn, sudo, supervisor
for bin in node yarn supervisorctl curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "$bin tidak terinstall — install dulu sebelum lanjut"
    exit 1
  fi
done
NODE_BIN="$(command -v node)"

# ─── 1. Secret: reuse existing OR generate new ───────────────────────────
if grep -q "^WA_SERVICE_SECRET=" "$BACKEND_ENV" 2>/dev/null; then
  SECRET="$(grep '^WA_SERVICE_SECRET=' "$BACKEND_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [[ -z "$SECRET" ]]; then
    SECRET="$(openssl rand -hex 32)"
    sed -i "s|^WA_SERVICE_SECRET=.*|WA_SERVICE_SECRET=$SECRET|" "$BACKEND_ENV"
    ok "Generated new secret (was empty in .env)"
  else
    ok "Reusing existing WA_SERVICE_SECRET from $BACKEND_ENV"
  fi
else
  SECRET="$(openssl rand -hex 32)"
  echo "WA_SERVICE_SECRET=$SECRET" >> "$BACKEND_ENV"
  ok "Generated new WA_SERVICE_SECRET"
fi

# Ensure WA_SERVICE_URL is set
if ! grep -q "^WA_SERVICE_URL=" "$BACKEND_ENV" 2>/dev/null; then
  echo "WA_SERVICE_URL=http://localhost:3002" >> "$BACKEND_ENV"
  ok "Added WA_SERVICE_URL=http://localhost:3002 to backend/.env"
else
  ok "WA_SERVICE_URL already set"
fi

# ─── 2. Supervisor config (auto-generated with correct paths) ────────────
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

# ─── 3. Install Node deps ────────────────────────────────────────────────
log "Installing Node deps (yarn install) …"
cd "$WA_DIR"
if [[ -f yarn.lock ]]; then
  yarn install --frozen-lockfile --silent || yarn install --silent
else
  yarn install --silent
fi
cd "$APP_DIR"
ok "Node deps installed"

# ─── 4. Reload supervisor + start ────────────────────────────────────────
log "Reloading supervisor …"
sudo supervisorctl reread > /dev/null
sudo supervisorctl update > /dev/null
sudo supervisorctl restart "$SUPERVISOR_NAME" > /dev/null
ok "wa-service started"

# Restart backend so it picks up new .env vars
if sudo supervisorctl status "$SUPERVISOR_BACKEND" >/dev/null 2>&1; then
  log "Restarting backend ($SUPERVISOR_BACKEND) to load new env …"
  sudo supervisorctl restart "$SUPERVISOR_BACKEND" > /dev/null
  ok "Backend restarted"
else
  warn "Backend supervisor program '$SUPERVISOR_BACKEND' tidak ditemukan — skip restart"
  warn "Restart manual jika perlu: sudo supervisorctl restart <nama-backend-anda>"
fi

# ─── 5. Verify ───────────────────────────────────────────────────────────
log "Verifying …"
sleep 3
HEALTH="$(curl -fsS http://localhost:3002/health 2>&1 || true)"
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo
  ok "═══════════════════════════════════════════════"
  ok " WA Service SIAP! Buka /whatsapp di browser."
  ok "═══════════════════════════════════════════════"
  echo
  echo "Status:    sudo supervisorctl status $SUPERVISOR_NAME"
  echo "Logs:      tail -f /var/log/supervisor/${SUPERVISOR_NAME}.err.log"
  echo "Health:    curl http://localhost:3002/health"
else
  err "Health check gagal. Cek log:"
  err "  tail -n 50 /var/log/supervisor/${SUPERVISOR_NAME}.err.log"
  exit 1
fi
