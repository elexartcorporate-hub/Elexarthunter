#!/usr/bin/env bash
#
# setup.sh — Instalasi semua stack di VPS Contabo Ubuntu 22.04/24.04
# Jalankan sebagai root: ./setup.sh
#
# Stack yang diinstal:
#   Node.js 20 LTS · Yarn · PM2
#   Python 3 (default OS) + pip + venv + Supervisor
#   PHP 8.3 + php-fpm + Composer
#   MongoDB 7 · PostgreSQL 16 · MySQL 8 · Redis
#   Nginx · Certbot (snap) · Docker + Docker Compose · Git
#
set -euo pipefail

C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
log()  { echo -e "\n${C_GREEN}[OK]${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}[!]${C_RESET}  $*"; }
err()  { echo -e "${C_RED}[X]${C_RESET}  $*"; exit 1; }

[[ $EUID -eq 0 ]] || err "Harus root. Coba: sudo $0"

export DEBIAN_FRONTEND=noninteractive
UBUNTU_CODENAME="$(lsb_release -cs)"

log "Update apt cache..."
apt-get update -y

# ──────────────────────────────────────────────────────────
# 1. Node.js 20 LTS + Yarn + PM2
# ──────────────────────────────────────────────────────────
log "Install Node.js 20 LTS (NodeSource)..."
if ! command -v node >/dev/null || [[ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

log "Install Yarn (classic)..."
npm install -g yarn
yarn -v

log "Install PM2 (global)..."
npm install -g pm2
pm2 -v
# Auto-start PM2 saat reboot (untuk root; nanti diset ulang per-user)
pm2 startup systemd -u root --hp /root | tail -n1 | bash || true

# ──────────────────────────────────────────────────────────
# 2. Python + pip + venv + Supervisor
# ──────────────────────────────────────────────────────────
log "Install Python 3, pip, venv, Supervisor..."
apt-get install -y python3 python3-pip python3-venv python3-dev supervisor
systemctl enable --now supervisor
python3 --version

# ──────────────────────────────────────────────────────────
# 3. PHP 8.3 + ekstensi umum + Composer
# ──────────────────────────────────────────────────────────
log "Install PHP 8.3 + ekstensi umum (Laravel-ready)..."
add-apt-repository -y ppa:ondrej/php || true
apt-get update -y
apt-get install -y \
  php8.3 php8.3-fpm php8.3-cli php8.3-common \
  php8.3-mysql php8.3-pgsql php8.3-sqlite3 \
  php8.3-mbstring php8.3-xml php8.3-curl php8.3-zip php8.3-gd php8.3-bcmath \
  php8.3-intl php8.3-redis php8.3-imagick
systemctl enable --now php8.3-fpm
php -v

log "Install Composer..."
if ! command -v composer >/dev/null; then
  curl -sS https://getcomposer.org/installer | php
  mv composer.phar /usr/local/bin/composer
  chmod +x /usr/local/bin/composer
fi
composer --version

# ──────────────────────────────────────────────────────────
# 4. MongoDB 7
# ──────────────────────────────────────────────────────────
log "Install MongoDB 7.0..."
if ! command -v mongod >/dev/null; then
  # MongoDB 7 official repo (works on 22.04 jammy; 24.04 pakai jammy juga di repo resmi sampai noble keluar)
  MONGO_CODENAME="jammy"
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
    gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${MONGO_CODENAME}/mongodb-org/7.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list
  apt-get update -y
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod
sleep 2
mongod --version | head -n1

# ──────────────────────────────────────────────────────────
# 5. PostgreSQL 16
# ──────────────────────────────────────────────────────────
log "Install PostgreSQL 16..."
if ! command -v psql >/dev/null; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${UBUNTU_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-16 postgresql-contrib-16
fi
systemctl enable --now postgresql
psql --version

# ──────────────────────────────────────────────────────────
# 6. MySQL 8
# ──────────────────────────────────────────────────────────
log "Install MySQL 8..."
apt-get install -y mysql-server
systemctl enable --now mysql
mysql --version
warn "Setelah selesai, jalankan manual: sudo mysql_secure_installation"

# ──────────────────────────────────────────────────────────
# 7. Redis
# ──────────────────────────────────────────────────────────
log "Install Redis..."
apt-get install -y redis-server
sed -ri 's/^supervised .*/supervised systemd/' /etc/redis/redis.conf
systemctl enable --now redis-server
redis-server --version | head -n1

# ──────────────────────────────────────────────────────────
# 8. Nginx
# ──────────────────────────────────────────────────────────
log "Install Nginx..."
apt-get install -y nginx
systemctl enable --now nginx
nginx -v

# ──────────────────────────────────────────────────────────
# 9. Certbot via snap (cara resmi Let's Encrypt)
# ──────────────────────────────────────────────────────────
log "Install Certbot (snap)..."
apt-get install -y snapd
snap install core 2>/dev/null && snap refresh core || true
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot
certbot --version

# ──────────────────────────────────────────────────────────
# 10. Docker + Docker Compose plugin
# ──────────────────────────────────────────────────────────
log "Install Docker + Compose plugin..."
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker --version
docker compose version

# ──────────────────────────────────────────────────────────
# 11. Tambahan: swap file (kalau RAM <= 4 GB)
# ──────────────────────────────────────────────────────────
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ "$RAM_MB" -le 4096 ]] && ! swapon --show | grep -q swap; then
  log "RAM ${RAM_MB}MB <= 4GB — buat swap 2 GB..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ──────────────────────────────────────────────────────────
# Ringkasan versi
# ──────────────────────────────────────────────────────────
echo
log "==============================================="
log " Instalasi semua stack SELESAI. Ringkasan:"
log "==============================================="
printf "  %-12s : %s\n" "Node"        "$(node -v)"
printf "  %-12s : %s\n" "Yarn"        "$(yarn -v)"
printf "  %-12s : %s\n" "PM2"         "$(pm2 -v 2>/dev/null | head -n1)"
printf "  %-12s : %s\n" "Python"      "$(python3 --version)"
printf "  %-12s : %s\n" "Supervisor"  "$(supervisorctl version)"
printf "  %-12s : %s\n" "PHP"         "$(php -v | head -n1)"
printf "  %-12s : %s\n" "Composer"    "$(composer --version | head -n1)"
printf "  %-12s : %s\n" "MongoDB"     "$(mongod --version | head -n1)"
printf "  %-12s : %s\n" "PostgreSQL"  "$(psql --version)"
printf "  %-12s : %s\n" "MySQL"       "$(mysql --version)"
printf "  %-12s : %s\n" "Redis"       "$(redis-server --version | head -n1)"
printf "  %-12s : %s\n" "Nginx"       "$(nginx -v 2>&1)"
printf "  %-12s : %s\n" "Certbot"     "$(certbot --version)"
printf "  %-12s : %s\n" "Docker"      "$(docker --version)"

log "Langkah selanjutnya:"
echo "  1) Pastikan DNS hunter.elexart.com sudah point ke IP server ini"
echo "  2) Jalankan: ./setup-site.sh hunter.elexart.com fullstack 8001"
echo "  3) Setup user 'deploy' + SSH key untuk GitHub Actions (lihat README.md bagian 6)"
