#!/usr/bin/env bash
#
# secure-server.sh — Hardening dasar Ubuntu 22.04 / 24.04 untuk VPS Contabo
# Jalankan sebagai root: ./secure-server.sh
#
# Yang dilakukan:
#   1. Update OS + install paket dasar
#   2. Set timezone Asia/Jakarta
#   3. Setup UFW firewall (allow 22, 80, 443)
#   4. Install Fail2Ban (proteksi brute-force SSH)
#   5. Enable auto-security-updates
#   6. Disable SSH password login HANYA jika ~/.ssh/authorized_keys sudah berisi key
#
set -euo pipefail

C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_RESET='\033[0m'
log()  { echo -e "${C_GREEN}[OK]${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}[!]${C_RESET}  $*"; }
err()  { echo -e "${C_RED}[X]${C_RESET}  $*"; exit 1; }

[[ $EUID -eq 0 ]] || err "Harus dijalankan sebagai root. Coba: sudo $0"

log "1/6  Update OS + install paket dasar..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y \
  curl wget git vim nano htop ncdu net-tools \
  unzip zip tar build-essential software-properties-common \
  ca-certificates gnupg lsb-release apt-transport-https \
  ufw fail2ban unattended-upgrades

log "2/6  Set timezone Asia/Jakarta..."
timedatectl set-timezone Asia/Jakarta || warn "Gagal set timezone (lanjut)"

log "3/6  Setup UFW firewall..."
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
ufw status verbose

log "4/6  Setup Fail2Ban..."
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = ssh
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

log "5/6  Enable auto-security-updates..."
dpkg-reconfigure -plow unattended-upgrades || true

log "6/6  Cek SSH key untuk root..."
if [[ -s /root/.ssh/authorized_keys ]]; then
  warn "authorized_keys ditemukan — mendisable login password SSH..."
  sed -ri 's/^#?PasswordAuthentication\s+.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -ri 's/^#?PermitRootLogin\s+.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  sed -ri 's/^#?ChallengeResponseAuthentication\s+.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
  systemctl restart ssh
  log "Login SSH password sudah di-disable. Pastikan kamu masih bisa login dari terminal lain!"
else
  warn "Belum ada SSH key di /root/.ssh/authorized_keys."
  warn "Tutorial sangat menyarankan kamu copy public key laptop ke server dulu:"
  warn "  Dari laptop:  ssh-copy-id root@$(hostname -I | awk '{print $1}')"
  warn "Lalu jalankan script ini lagi supaya password login di-disable."
fi

echo
log "Hardening selesai. Ringkasan status:"
echo "----------------------------------------"
ufw status | head -n 20
echo "----------------------------------------"
fail2ban-client status sshd 2>/dev/null || true
echo "----------------------------------------"
log "Lanjut ke: ./setup.sh untuk install stack aplikasi."
