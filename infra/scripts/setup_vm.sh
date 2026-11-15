#!/usr/bin/env bash
# CodeScout - Oracle Cloud Always Free Ubuntu ARM (aarch64) Setup Script
# Run as root or with sudo: sudo bash setup_vm.sh

set -euo pipefail

echo "=========================================================="
echo " Starting CodeScout Ubuntu ARM VM Configuration"
echo "=========================================================="

if [[ $EUID -ne 0 ]]; then
   echo "[ERROR] This script must be run as root (use sudo)" >&2
   exit 1
fi

TARGET_USER="${SUDO_USER:-ubuntu}"
APP_DIR="/opt/code-scout"

echo "[1/6] Updating apt packages and installing base dependencies..."
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  jq \
  iptables-persistent \
  netfilter-persistent \
  cron

echo "[2/6] Configuring Oracle Cloud host firewall (iptables)..."
# Oracle Cloud Ubuntu images have aggressive default iptables rules with REJECT at line 6.
# We insert ACCEPT rules at the top of the INPUT chain for HTTP (80) and HTTPS (443).
if iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null; then
  echo "Firewall rules for ports 80 and 443 already present."
else
  echo "Inserting ACCEPT rule for ports 80 and 443 at the top of INPUT chain..."
  iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
fi

if iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null; then
  echo "Firewall rule for port 22 already present."
else
  iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
fi

# Persist iptables rules across reboots
netfilter-persistent save

echo "[3/6] Installing Docker Engine and Docker Compose plugin (ARM64)..."
if ! command -v docker &> /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  
  systemctl enable docker
  systemctl start docker
  echo "Docker successfully installed."
else
  echo "Docker is already installed."
fi

# Add user to docker group
usermod -aG docker "$TARGET_USER"
echo "Added user $TARGET_USER to docker group."

echo "[4/6] Setting up project directory at ${APP_DIR}..."
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/secrets"
mkdir -p "${APP_DIR}/data/repos"
chown -R "${TARGET_USER}:${TARGET_USER}" "${APP_DIR}"

echo "[5/6] Setting up DuckDNS update cron job..."
SCRIPT_PATH="${APP_DIR}/infra/scripts/duckdns_update.sh"
if [[ -f "$SCRIPT_PATH" ]]; then
  chmod +x "$SCRIPT_PATH"
  CRON_JOB="*/5 * * * * ${SCRIPT_PATH} >/dev/null 2>&1"
  ( crontab -u "$TARGET_USER" -l 2>/dev/null | grep -F -v "duckdns_update.sh" ; echo "$CRON_JOB" ) | crontab -u "$TARGET_USER" -
  echo "DuckDNS cron job registered for user $TARGET_USER (runs every 5 minutes)."
fi

echo "[6/6] Verifying firewall and Docker status..."
iptables -L INPUT -n --line-numbers | head -n 15
docker --version
docker compose version

echo "=========================================================="
echo " VM Setup Complete!"
echo " Remember to:"
echo " 1. Ensure Oracle VCN Ingress Rules allow TCP 80 and 443 from 0.0.0.0/0."
echo " 2. Log out and back in as $TARGET_USER for docker group membership to take effect."
echo " 3. Copy your .env.prod to ${APP_DIR}/.env and secrets to ${APP_DIR}/secrets."
echo "=========================================================="
