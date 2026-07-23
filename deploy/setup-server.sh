#!/usr/bin/env bash
# One-time preparation for a fresh Ubuntu 24.04 server. Run as root.
# Idempotent: safe to re-run after a failure or to pick up package updates.
set -euo pipefail

USERNAME="${1:-sanad}"

if [ "$(id -u)" -ne 0 ]; then
  echo "must be run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> updating packages"
apt-get update -y
apt-get upgrade -y

echo "==> installing base packages"
apt-get install -y ca-certificates curl gnupg git ufw fail2ban unattended-upgrades jq

echo "==> swap"
# A 2GB box running Postgres alongside the Kafka JVM hits the OOM killer
# without swap, and OOM kills present as random application crashes.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '^/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
else
  echo "swapfile already exists, skipping"
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl -p /etc/sysctl.d/99-swappiness.conf

echo "==> docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
else
  echo "docker already installed, skipping"
fi
systemctl enable --now docker

echo "==> user"
if ! id "$USERNAME" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$USERNAME"
else
  echo "user $USERNAME already exists, skipping creation"
fi
usermod -aG docker "$USERNAME"
usermod -aG sudo "$USERNAME"

if [ -s /root/.ssh/authorized_keys ]; then
  mkdir -p "/home/$USERNAME/.ssh"
  cp /root/.ssh/authorized_keys "/home/$USERNAME/.ssh/authorized_keys"
  chown -R "$USERNAME:$USERNAME" "/home/$USERNAME/.ssh"
  chmod 0700 "/home/$USERNAME/.ssh"
  chmod 0600 "/home/$USERNAME/.ssh/authorized_keys"
else
  echo "WARNING: /root/.ssh/authorized_keys is missing or empty." >&2
  echo "WARNING: SSH hardening later disables password auth. Without a key" >&2
  echo "WARNING: for $USERNAME, you will be locked out permanently." >&2
fi

echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$USERNAME"
chmod 0440 "/etc/sudoers.d/90-$USERNAME"

echo "==> firewall"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
# Everything else the stack uses (Postgres, Redis, Kafka, the app ports)
# stays on the internal Docker network and is never routable from here.
ufw --force enable
ufw status verbose

echo "==> fail2ban"
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo "==> ssh hardening"
cat > /etc/ssh/sshd_config.d/99-hardening.conf.tmp <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
MaxAuthTries 3
EOF
mv /etc/ssh/sshd_config.d/99-hardening.conf.tmp /etc/ssh/sshd_config.d/99-hardening.conf
if sshd -t; then
  systemctl reload ssh
else
  echo "sshd config test failed, reverting hardening to avoid lockout" >&2
  rm -f /etc/ssh/sshd_config.d/99-hardening.conf
  exit 1
fi

echo "==> unattended upgrades"
systemctl enable --now unattended-upgrades

echo ""
echo "==> summary"
echo "Docker:  $(docker --version)"
echo "Compose: $(docker compose version)"
echo "User:    $USERNAME"
echo "Swap:    $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
echo "Firewall:"
ufw status | sed 's/^/  /'
echo ""
echo "Next steps:"
echo "  1. Log out, then log back in as $USERNAME (do not close this session first)"
echo "  2. As $USERNAME: git clone the repository and continue with deploy/DEPLOY.md"
