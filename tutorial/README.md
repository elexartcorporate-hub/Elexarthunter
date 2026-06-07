# Tutorial Lengkap: Setup VPS Contabo + SSL + Auto-Deploy dari GitHub

> **Target domain:** `hunter.elexart.com`
> **OS:** Ubuntu 24.04 LTS (rekomendasi) — kompatibel juga dengan 22.04
> **Stack yang diinstal:** Node.js (LTS) · Python 3.12 · PHP 8.3 · MongoDB 7 · PostgreSQL · MySQL · Redis · Nginx · Certbot (Let's Encrypt) · PM2 · Supervisor · Docker · Git
> **Auto-deploy:** GitHub Actions (push ke `main` → SSH ke server → pull & restart)

Setelah selesai mengikuti tutorial ini, alur kerja kamu jadi:
**Coding di lokal → `git push` ke GitHub → server otomatis pull + restart → website live di HTTPS.**

---

## Daftar Isi

1. [Persiapan: Beli VPS Contabo & Arahkan Domain](#1-persiapan-beli-vps-contabo--arahkan-domain)
2. [Login Pertama Kali via SSH](#2-login-pertama-kali-via-ssh)
3. [Hardening Server (Wajib!)](#3-hardening-server-wajib)
4. [Jalankan `setup.sh` — Instalasi Semua Stack](#4-jalankan-setupsh--instalasi-semua-stack)
5. [Setup Domain + SSL Let's Encrypt untuk `hunter.elexart.com`](#5-setup-domain--ssl-lets-encrypt)
6. [Setup User `deploy` + SSH Key untuk GitHub Actions](#6-setup-user-deploy--ssh-key-untuk-github-actions)
7. [Konfigurasi GitHub Actions di Repo Aplikasi](#7-konfigurasi-github-actions-di-repo-aplikasi)
8. [Deploy Aplikasi Pertama (Full-Stack React + FastAPI + MongoDB)](#8-deploy-aplikasi-pertama)
9. [Cheat-sheet Maintenance Harian](#9-cheat-sheet-maintenance-harian)
10. [Troubleshooting Umum](#10-troubleshooting-umum)

---

## 1. Persiapan: Beli VPS Contabo & Arahkan Domain

### 1.1. Pilih paket VPS

| Kebutuhan | Rekomendasi Contabo |
|---|---|
| Hobi / testing | **VPS S** (4 vCPU, 8 GB RAM, 100 GB NVMe) — ~€5/bln |
| Production ringan | **VPS M** (6 vCPU, 16 GB RAM, 200 GB NVMe) |
| Production + DB berat | **VPS L** ke atas |

Saat checkout:
- **Region:** pilih **Singapore** atau **Asia (Tokyo/Sydney)** kalau target user di Indonesia (latency terendah).
- **Image:** `Ubuntu 24.04`
- **Login:** pilih **SSH Key** kalau bisa (lebih aman) — atau password (catat baik-baik).

Setelah pesanan diproses (5–20 menit), Contabo akan kirim email berisi:
```
IP Address  : 123.45.67.89
Username    : root
Password    : XXXXXXXX
```

### 1.2. Arahkan domain `hunter.elexart.com` → IP server

Login ke registrar/DNS panel domain `elexart.com` (Cloudflare/Namecheap/Niagahoster/dll), tambah record:

| Type | Name | Value | TTL | Proxy |
|---|---|---|---|---|
| `A` | `hunter` | `IP_VPS_KAMU` | Auto | **DNS only** (off, karena Let's Encrypt-nya pakai HTTP challenge) |

> Tunggu 1–10 menit, lalu cek dari laptop:
> ```bash
> ping hunter.elexart.com
> # Harus muncul IP VPS Contabo kamu
> ```

---

## 2. Login Pertama Kali via SSH

Dari laptop kamu (Mac/Linux pakai Terminal, Windows pakai PowerShell atau PuTTY):

```bash
ssh root@hunter.elexart.com
# atau pakai IP langsung:
ssh root@123.45.67.89
```

Masukkan password dari email Contabo. Setelah masuk, **ganti password root**:

```bash
passwd
```

---

## 3. Hardening Server (Wajib!)

Jangan pernah deploy aplikasi di server yang root-nya bisa login pakai password dari internet. Jalankan script ini sekali saja:

### 3.1. Upload script ke server

Dari **laptop**:

```bash
# Asumsi kamu sudah clone repo tutorial ini ke laptop
scp -r ./tutorial root@hunter.elexart.com:/root/
```

> Kalau belum punya repo, isi file `secure-server.sh`, `setup.sh`, `setup-site.sh` ada di folder `scripts/`. Bisa juga `wget` langsung dari GitHub kalau sudah di-push.

### 3.2. Jalankan hardening

Di **server**:

```bash
cd /root/tutorial/scripts
chmod +x secure-server.sh
./secure-server.sh
```

Script ini akan:
- Update OS
- Install & enable **UFW** firewall (allow port 22, 80, 443 saja)
- Install **Fail2Ban** (block brute force SSH)
- Disable SSH password login (memaksa pakai SSH key) — **HANYA aktif kalau kamu sudah punya `~/.ssh/authorized_keys`**
- Set timezone Asia/Jakarta
- Install paket dasar: `curl`, `wget`, `git`, `vim`, `htop`, `ufw`, `fail2ban`, `unattended-upgrades`

> ⚠️ **Sebelum logout**, buka terminal kedua dan tes login lagi. Pastikan masih bisa, baru tutup yang pertama.

---

## 4. Jalankan `setup.sh` — Instalasi Semua Stack

```bash
cd /root/tutorial/scripts
chmod +x setup.sh
./setup.sh
```

Script ini install **semua** stack yang kamu butuhkan supaya server tinggal terima deploy apapun:

| Komponen | Versi | Untuk |
|---|---|---|
| **Node.js** | 20 LTS (via NodeSource) | Next.js, React, Express, dll |
| **Yarn** | latest | Frontend Emergent stack |
| **PM2** | global | Process manager Node.js |
| **Python** | 3.12 + `pip`, `venv` | FastAPI, Django, Flask |
| **Supervisor** | latest | Process manager Python |
| **PHP** | 8.3 + `php-fpm` + ekstensi umum | Laravel, native PHP |
| **Composer** | latest | Dependency manager PHP |
| **MongoDB** | 7.0 | DB utama Emergent stack |
| **PostgreSQL** | 16 | DB relasional (opsional) |
| **MySQL** | 8 | DB relasional (opsional) |
| **Redis** | latest | Cache / queue |
| **Nginx** | latest | Reverse proxy + serve static |
| **Certbot** | latest (snap) | SSL Let's Encrypt |
| **Docker + Compose** | latest | Containerized apps |
| **Git** | latest | Versioning |

Total durasi: 5–10 menit tergantung speed VPS.

Verifikasi:

```bash
node -v && yarn -v && pm2 -v
python3 --version && pip3 --version
php -v && composer --version
mongod --version
psql --version && mysql --version && redis-server --version
nginx -v && certbot --version
docker --version && docker compose version
```

---

## 5. Setup Domain + SSL Let's Encrypt

Jalankan script khusus untuk bikin Nginx vhost + auto-generate sertifikat SSL:

```bash
cd /root/tutorial/scripts
chmod +x setup-site.sh

# Format: ./setup-site.sh <domain> <tipe> <port-backend-jika-ada>
# Tipe: 'static' | 'node' | 'fullstack' | 'php'

# Contoh untuk full-stack (frontend di /var/www/hunter/build, backend FastAPI di port 8001):
./setup-site.sh hunter.elexart.com fullstack 8001
```

Yang script lakukan:
1. Buat folder `/var/www/hunter.elexart.com/`
2. Copy template Nginx dari `templates/` → `/etc/nginx/sites-available/hunter.elexart.com`
3. Symlink ke `sites-enabled/`
4. `nginx -t` lalu reload
5. Jalankan `certbot --nginx -d hunter.elexart.com` (auto-pasang sertifikat & redirect HTTP→HTTPS)
6. Cek auto-renew: `systemctl list-timers | grep certbot`

Test:
```bash
curl -I https://hunter.elexart.com
# Harus return: HTTP/2 200 dan ada header `strict-transport-security`
```

---

## 6. Setup User `deploy` + SSH Key untuk GitHub Actions

GitHub Actions akan SSH ke server pakai user khusus (`deploy`), bukan root. Lebih aman.

### 6.1. Buat user `deploy` di server

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
usermod -aG www-data deploy

# Izinkan deploy untuk reload nginx & restart service tanpa password
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/sbin/nginx, /usr/bin/supervisorctl, /usr/local/bin/pm2' \
  | tee /etc/sudoers.d/deploy
chmod 0440 /etc/sudoers.d/deploy

mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

### 6.2. Generate SSH key khusus GitHub Actions (di server)

```bash
sudo -u deploy ssh-keygen -t ed25519 -C "github-actions@hunter" -f /home/deploy/.ssh/gh_actions -N ""

# Daftarkan public key supaya GH Actions bisa login pakai private key-nya
cat /home/deploy/.ssh/gh_actions.pub >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys

# Tampilkan PRIVATE key — copy SEMUA isinya (termasuk baris BEGIN/END)
cat /home/deploy/.ssh/gh_actions
```

### 6.3. Tambah Secrets di GitHub Repo

Di GitHub: **Repo → Settings → Secrets and variables → Actions → New repository secret**:

| Nama Secret | Isi |
|---|---|
| `SSH_HOST` | `hunter.elexart.com` |
| `SSH_USER` | `deploy` |
| `SSH_PORT` | `22` |
| `SSH_PRIVATE_KEY` | Isi penuh dari `cat /home/deploy/.ssh/gh_actions` (termasuk `-----BEGIN...-----` dan `-----END...-----`) |
| `DEPLOY_PATH` | `/var/www/hunter.elexart.com` |

---

## 7. Konfigurasi GitHub Actions di Repo Aplikasi

Di **repo aplikasi kamu** (bukan repo tutorial), buat file:

```
.github/workflows/deploy.yml
```

Isi pakai template `github-actions/deploy.yml` di tutorial ini. Sesuaikan langkah `Build` dan `Restart` sesuai stack:

- **Node/Next.js** → build di runner → upload `dist/` → pm2 restart
- **FastAPI** → push code → server jalankan `pip install` → supervisor restart
- **Full-stack (React + FastAPI)** → build frontend di runner → rsync ke `/var/www/.../build` → backend pull & restart

Setelah file di-push, setiap `git push origin main` akan trigger workflow.

---

## 8. Deploy Aplikasi Pertama

Contoh: deploy aplikasi Emergent stack (React + FastAPI + MongoDB) ke `hunter.elexart.com`.

### 8.1. Clone pertama kali di server (manual, sekali saja)

```bash
sudo -iu deploy
cd /var/www
sudo mkdir hunter.elexart.com && sudo chown deploy:www-data hunter.elexart.com
cd hunter.elexart.com
git clone git@github.com:USERNAME/REPO.git .
# (atau pakai HTTPS + Personal Access Token kalau repo private)
```

### 8.2. Setup backend FastAPI

```bash
cd /var/www/hunter.elexart.com/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit nilainya
deactivate
```

Daftarkan ke Supervisor (template ada di `templates/supervisor-fastapi.conf`):

```bash
sudo cp /root/tutorial/templates/supervisor-fastapi.conf /etc/supervisor/conf.d/hunter-backend.conf
sudo nano /etc/supervisor/conf.d/hunter-backend.conf   # ubah path/domain
sudo supervisorctl reread && sudo supervisorctl update
sudo supervisorctl status hunter-backend
```

### 8.3. Build frontend React

```bash
cd /var/www/hunter.elexart.com/frontend
yarn install
yarn build
# Hasil ada di ./build/
```

> Nginx (dari step 5) sudah otomatis serve `/var/www/hunter.elexart.com/frontend/build` untuk path `/` dan proxy `/api` ke `localhost:8001`.

### 8.4. Test

Buka https://hunter.elexart.com → kelar! 🎉

### 8.5. Selanjutnya semua otomatis

Sekarang tinggal:
```bash
# Di laptop
git add . && git commit -m "feature: ..." && git push origin main
```

GitHub Actions akan SSH ke server, jalankan `git pull`, build, restart service. Buka browser → perubahan live.

---

## 9. Cheat-sheet Maintenance Harian

```bash
# Lihat status semua service
sudo systemctl status nginx mongod postgresql mysql redis-server
sudo supervisorctl status
pm2 status

# Lihat log
sudo journalctl -u nginx -f                    # nginx
sudo tail -f /var/log/supervisor/hunter-backend.err.log
pm2 logs

# Restart manual
sudo systemctl reload nginx
sudo supervisorctl restart hunter-backend
pm2 restart all

# Cek SSL expiry
sudo certbot certificates

# Force renew SSL
sudo certbot renew --force-renewal

# Cek disk & memory
df -h && free -h && htop

# Update OS (rutin tiap minggu)
sudo apt update && sudo apt upgrade -y
```

---

## 10. Troubleshooting Umum

| Masalah | Penyebab umum | Solusi |
|---|---|---|
| `502 Bad Gateway` | Backend mati | `sudo supervisorctl status` → restart |
| SSL gagal di-issue | Domain belum point ke IP | Cek `dig hunter.elexart.com` |
| GitHub Action gagal SSH | Private key salah / port di-block | Cek secrets, cek UFW |
| `Permission denied` saat `git pull` | Folder owner salah | `sudo chown -R deploy:www-data /var/www/...` |
| Disk penuh | Log Docker / Mongo nge-bengkak | `sudo journalctl --vacuum-time=7d`, prune docker |
| MongoDB tidak start | Permission `/var/lib/mongodb` | `sudo chown -R mongodb:mongodb /var/lib/mongodb` |

---

## Struktur Folder Tutorial

```
tutorial/
├── README.md                          ← file ini
├── scripts/
│   ├── secure-server.sh               ← hardening (UFW, fail2ban, SSH)
│   ├── setup.sh                       ← install semua stack
│   └── setup-site.sh                  ← buat vhost + SSL Let's Encrypt
├── templates/
│   ├── nginx-fullstack.conf           ← React build + reverse proxy backend
│   ├── nginx-static.conf              ← serve static / SPA saja
│   ├── nginx-node.conf                ← reverse proxy ke Node app
│   ├── nginx-php.conf                 ← PHP-FPM
│   ├── supervisor-fastapi.conf        ← jalankan uvicorn via supervisor
│   └── ecosystem.config.js            ← PM2 config untuk Node
└── github-actions/
    ├── deploy-fullstack.yml           ← React + FastAPI auto-deploy
    ├── deploy-node.yml                ← Node/Next.js auto-deploy
    └── deploy-static.yml              ← static site auto-deploy
```

---

**Selamat coding! 🚀** Kalau ada pertanyaan / butuh template lain (Laravel, Next.js SSR, Docker Compose, dll), tinggal bilang.
