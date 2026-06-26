#!/usr/bin/env bash
#
# wa-doctor.sh — Pure diagnostic. Tidak modify apa-apa.
# Tujuan: kasih full picture ke main agent untuk diagnose remote issue.
# Jalankan di VPS lalu kirim screenshot output-nya.
#
# Usage:
#   bash wa-doctor.sh                    # output ke stdout
#   bash wa-doctor.sh > diagnostic.txt   # save ke file
#
set +e  # JANGAN exit on error — kita mau collect semuanya

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "════════════════════════════════════════════════"
echo " WA DOCTOR — $(date)"
echo " APP_DIR: $APP_DIR"
echo " HOST:    $(hostname) ($(uname -m))"
echo "════════════════════════════════════════════════"

echo
echo "── 1. Git status ──"
if [[ -d "$APP_DIR/.git" ]]; then
  echo "Branch:  $(git -C "$APP_DIR" branch --show-current 2>/dev/null)"
  echo "HEAD:    $(git -C "$APP_DIR" log -1 --oneline 2>/dev/null)"
  echo "Status:  $(git -C "$APP_DIR" status -s 2>/dev/null | wc -l) uncommitted change(s)"
else
  echo "(bukan git repo)"
fi

echo
echo "── 2. Supervisor status (ALL programs) ──"
sudo supervisorctl status 2>&1 || true

echo
echo "── 3. Backend /.env (secret di-mask) ──"
if [[ -f "$APP_DIR/backend/.env" ]]; then
  sed -E 's/(SECRET|PASSWORD|TOKEN|KEY)=.*/\1=***MASKED***/' "$APP_DIR/backend/.env" 2>&1 || true
else
  echo "($APP_DIR/backend/.env tidak ada)"
fi

echo
echo "── 4. Backend supervisor config (cari program *backend*) ──"
shopt -s nullglob
for f in /etc/supervisor/conf.d/*backend*.conf; do
  if [[ -f "$f" ]]; then
    echo "── $f ──"
    cat "$f"
    echo
  fi
done
shopt -u nullglob

echo
echo "── 5. WA Service supervisor config ──"
shopt -s nullglob
for f in /etc/supervisor/conf.d/*wa-service*.conf; do
  if [[ -f "$f" ]]; then
    echo "── $f ──"
    cat "$f"
    echo
  fi
done
shopt -u nullglob

echo
echo "── 6. Backend latest 30 lines err log ──"
for log in /var/log/supervisor/*backend*.err.log; do
  if [[ -f "$log" ]]; then
    echo "── $log ──"
    sudo tail -n 30 "$log" 2>&1 || true
    echo
  fi
done

echo
echo "── 7. WA Service latest 30 lines err log ──"
for log in /var/log/supervisor/*wa-service*.err.log; do
  if [[ -f "$log" ]]; then
    echo "── $log ──"
    sudo tail -n 30 "$log" 2>&1 || true
    echo
  fi
done

echo
echo "── 8. Port checks ──"
echo "Port 8001 (backend):"
ss -tlnp 2>/dev/null | grep -E ':8001\b' || lsof -i :8001 2>/dev/null || echo "  (port not listening)"
echo "Port 3002 (wa-service):"
ss -tlnp 2>/dev/null | grep -E ':3002\b' || lsof -i :3002 2>/dev/null || echo "  (port not listening)"
echo "Port 27017 (mongodb):"
ss -tlnp 2>/dev/null | grep -E ':27017\b' || lsof -i :27017 2>/dev/null || echo "  (port not listening)"

echo
echo "── 9. Health endpoint tests ──"
echo "Backend localhost /api/whatsapp/health:"
curl -s --max-time 5 http://localhost:8001/api/whatsapp/health 2>&1 || true
echo
echo "WA Service localhost /health:"
curl -s --max-time 5 http://localhost:3002/health 2>&1 || true
echo
echo "Backend public domain (kalau ada nginx):"
DOMAIN="${DOMAIN:-$(grep -oP 'server_name\s+\K[^\s;]+' /etc/nginx/sites-enabled/* 2>/dev/null | head -1)}"
if [[ -n "$DOMAIN" ]]; then
  echo "Domain detected: $DOMAIN"
  curl -s --max-time 5 "https://$DOMAIN/api/whatsapp/health" 2>&1 || true
fi

echo
echo "── 10. Python venv check ──"
for venv in "$APP_DIR/backend/venv" "$APP_DIR/venv"; do
  if [[ -d "$venv" ]]; then
    echo "Venv: $venv"
    echo "  Python:  $("$venv/bin/python" --version 2>&1 || echo 'BROKEN')"
    echo "  httpx:   $("$venv/bin/pip" show httpx 2>/dev/null | grep -i version || echo 'NOT INSTALLED')"
    echo "  fastapi: $("$venv/bin/pip" show fastapi 2>/dev/null | grep -i version || echo 'NOT INSTALLED')"
  fi
done

echo
echo "── 11. Node version ──"
echo "node:  $(node --version 2>&1)"
echo "yarn:  $(yarn --version 2>&1)"

echo
echo "── 12. Code freshness check (key files) ──"
echo "server.py has /api/whatsapp/health endpoint? $(grep -l '/whatsapp/health' "$APP_DIR/backend/server.py" 2>/dev/null && echo YES || echo NO)"
echo "server.py has recover-orphans endpoint?      $(grep -l 'recover-orphans' "$APP_DIR/backend/server.py" 2>/dev/null && echo YES || echo NO)"
echo "wa-service/ exists?                          $([[ -d "$APP_DIR/wa-service" ]] && echo YES || echo NO)"
echo "wa-setup.sh exists?                          $([[ -f "$APP_DIR/wa-setup.sh" ]] && echo YES || echo NO)"

echo
echo "════════════════════════════════════════════════"
echo " SELESAI. Screenshot atau copy-paste output ini."
echo "════════════════════════════════════════════════"
