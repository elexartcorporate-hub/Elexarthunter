#!/usr/bin/env bash
#
# setup-site.sh — Buat Nginx vhost + auto-pasang SSL Let's Encrypt
#
# Usage:
#   ./setup-site.sh <domain> <type> [backend_port]
#
#   type:
#     static      → SPA / static HTML (root: /var/www/<domain>)
#     node        → reverse proxy ke Node app di port (default 3000)
#     php         → PHP-FPM site (root: /var/www/<domain>)
#     fullstack   → React build di /frontend/build + proxy /api → backend_port
#
# Contoh:
#   ./setup-site.sh hunter.elexart.com fullstack 8001
#   ./setup-site.sh blog.elexart.com php
#   ./setup-site.sh app.elexart.com node 3000
#
set -euo pipefail

DOMAIN="${1:-}"
TYPE="${2:-}"
PORT="${3:-3000}"

[[ -z "$DOMAIN" || -z "$TYPE" ]] && {
  echo "Usage: $0 <domain> <static|node|php|fullstack> [backend_port]"
  exit 1
}
[[ $EUID -eq 0 ]] || { echo "Harus root."; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TPL_DIR="$(cd "$SCRIPT_DIR/../templates" && pwd)"
WEB_ROOT="/var/www/$DOMAIN"
NGINX_AVAIL="/etc/nginx/sites-available/$DOMAIN"
NGINX_ENABLED="/etc/nginx/sites-enabled/$DOMAIN"

echo "[*] Domain      : $DOMAIN"
echo "[*] Type        : $TYPE"
echo "[*] Backend port: $PORT"
echo "[*] Web root    : $WEB_ROOT"

# Cek DNS
echo "[*] Cek DNS..."
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)
SERVER_IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')
if [[ "$RESOLVED" != "$SERVER_IP" ]]; then
  echo "    [!] DNS $DOMAIN -> $RESOLVED (server: $SERVER_IP) — belum match."
  echo "    [!] Pastikan A record sudah point ke $SERVER_IP, lalu lanjutkan (y/n)?"
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

# Buat folder
mkdir -p "$WEB_ROOT"
case "$TYPE" in
  fullstack)
    mkdir -p "$WEB_ROOT/frontend/build" "$WEB_ROOT/backend"
    cat > "$WEB_ROOT/frontend/build/index.html" <<EOF
<!doctype html><html><head><title>$DOMAIN</title></head>
<body><h1>$DOMAIN ready ✅</h1><p>Frontend slot. Deploy via GitHub Actions.</p></body></html>
EOF
    TPL="$TPL_DIR/nginx-fullstack.conf"
    ;;
  static)
    cat > "$WEB_ROOT/index.html" <<EOF
<!doctype html><html><head><title>$DOMAIN</title></head>
<body><h1>$DOMAIN ready ✅</h1></body></html>
EOF
    TPL="$TPL_DIR/nginx-static.conf"
    ;;
  node)
    TPL="$TPL_DIR/nginx-node.conf"
    ;;
  php)
    cat > "$WEB_ROOT/index.php" <<'EOF'
<?php phpinfo(); ?>
EOF
    TPL="$TPL_DIR/nginx-php.conf"
    ;;
  *)
    echo "Type tidak dikenal: $TYPE"; exit 1 ;;
esac

chown -R www-data:www-data "$WEB_ROOT"

# Render template
echo "[*] Render template Nginx -> $NGINX_AVAIL"
sed -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__WEBROOT__|$WEB_ROOT|g" \
    "$TPL" > "$NGINX_AVAIL"

ln -sf "$NGINX_AVAIL" "$NGINX_ENABLED"
rm -f /etc/nginx/sites-enabled/default

echo "[*] Test konfigurasi Nginx..."
nginx -t
systemctl reload nginx

echo "[*] Jalankan Certbot untuk SSL..."
certbot --nginx -d "$DOMAIN" \
  --non-interactive --agree-tos \
  --redirect \
  --register-unsafely-without-email || {
    echo "[!] Certbot gagal. Cek DNS & port 80 terbuka."
    exit 1
  }

systemctl reload nginx

echo
echo "================================================"
echo "  ✅  $DOMAIN aktif dengan HTTPS!"
echo "      Buka:  https://$DOMAIN"
echo "================================================"
echo "  Renewal otomatis (cek timer): systemctl list-timers | grep certbot"
echo "  Web root:  $WEB_ROOT"
echo "  Nginx vhost: $NGINX_AVAIL"
