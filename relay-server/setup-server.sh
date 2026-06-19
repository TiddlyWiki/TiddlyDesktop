#!/usr/bin/env bash
set -euo pipefail

# ── Initial setup for a fresh DigitalOcean Droplet ───────────────────
#
# Prerequisites:
#   - A $6/mo Droplet (1 vCPU, 1GB RAM, 1TB transfer)
#   - Ubuntu 24.04 LTS
#   - SSH access as root
#
# Usage (from your local machine):
#   ssh root@<droplet-ip> 'bash -s' < setup-server.sh

SERVICE_NAME="relay"

echo "==> Setting up TiddlyDesktop Relay on $(hostname)"

# ── 1. System updates ───────────────────────────────────────────────
echo "==> Updating system..."
apt-get update -qq
apt-get upgrade -y -qq

# ── 2. Create relay user (no login, no home) ────────────────────────
echo "==> Creating relay user..."
if ! id relay &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin relay
fi

# ── 3. Create GitHub OAuth environment file directory ─────────────
echo "==> Setting up GitHub OAuth config directory..."
mkdir -p /etc/tiddlydesktop-relay
chmod 700 /etc/tiddlydesktop-relay
if [ ! -f /etc/tiddlydesktop-relay/env ]; then
    cat > /etc/tiddlydesktop-relay/env <<'ENVEOF'
# GitHub OAuth App credentials — fill in after creating OAuth App at
# https://github.com/settings/developers
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
# Admin API token — generate a random string, e.g.: openssl rand -hex 32
ADMIN_TOKEN=
ENVEOF
    chmod 600 /etc/tiddlydesktop-relay/env
    echo "    Created /etc/tiddlydesktop-relay/env — fill in GitHub OAuth credentials"
else
    echo "    /etc/tiddlydesktop-relay/env already exists, skipping"
fi

# ── 4. Install systemd service ──────────────────────────────────────
echo "==> Installing systemd service..."
cat > /etc/systemd/system/$SERVICE_NAME.service <<'EOF'
[Unit]
Description=TiddlyDesktop Relay Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=relay
Group=relay
ExecStart=/usr/local/bin/tiddlydesktop-relay
Restart=always
RestartSec=5

# Persistent state (SQLite database) — creates /var/lib/tiddlydesktop-relay/
StateDirectory=tiddlydesktop-relay

# Relay listens on localhost:8444 — Caddy handles TLS on public :8443 and proxies here
Environment=PORT=8444
Environment=RUST_LOG=tiddlydesktop_relay=info
# Set BIND_PUBLIC=1 to listen on 0.0.0.0 instead of localhost (not recommended with Caddy)
#Environment=BIND_PUBLIC=1

# GitHub OAuth credentials (CLIENT_ID + CLIENT_SECRET)
EnvironmentFile=/etc/tiddlydesktop-relay/env

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
MemoryDenyWriteExecute=true
LockPersonality=true

LimitNOFILE=65536
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME

# ── 5. Install Caddy (TLS reverse proxy) ────────────────────────────
echo "==> Installing Caddy..."
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
apt-get update -qq
apt-get install -y -qq caddy

# Configure Caddy: TLS termination on public :8443, reverse proxy to relay on localhost
RELAY_DOMAIN="${RELAY_DOMAIN:-relay.tiddlydesktop-rs.com}"
echo "==> Configuring Caddy for $RELAY_DOMAIN..."
cat > /etc/caddy/Caddyfile <<CADDYEOF
# TLS WebSocket relay — Let's Encrypt auto-cert
$RELAY_DOMAIN:8443 {
    reverse_proxy localhost:8444
}
CADDYEOF

systemctl enable caddy
systemctl restart caddy

# ── 6. Firewall ─────────────────────────────────────────────────────
echo "==> Configuring firewall..."
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # Let's Encrypt ACME HTTP-01 challenge
ufw allow 8443/tcp # Caddy wss:// (public TLS WebSocket)
ufw --force enable

# ── 7. Kernel tuning for many WebSocket connections ─────────────────
echo "==> Tuning kernel for WebSocket server..."
cat > /etc/sysctl.d/99-relay.conf <<'SYSCTL'
# Allow more open files / sockets
fs.file-max = 131072
# Faster recycling of TIME_WAIT sockets
net.ipv4.tcp_tw_reuse = 1
# Larger connection backlog
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 4096
SYSCTL
sysctl --system > /dev/null 2>&1

# ── 8. Done ─────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo " Server setup complete!"
echo "========================================"
echo ""
echo " Next steps:"
echo "   1. Ensure DNS A record for $RELAY_DOMAIN points to this server's IP"
echo ""
echo "   2. Edit /etc/tiddlydesktop-relay/env with GitHub OAuth credentials"
echo "      (Create OAuth App at https://github.com/settings/developers)"
echo ""
echo "   3. From your dev machine, build and deploy the relay binary:"
echo "      cd relay-server && ./deploy.sh"
echo ""
echo "   4. Test (after deploy and DNS propagation):"
echo "      curl https://$RELAY_DOMAIN:8443/health"
echo "      curl https://$RELAY_DOMAIN:8443/stats"
echo ""
echo "   5. Check logs:"
echo "      journalctl -u $SERVICE_NAME -f   # relay"
echo "      journalctl -u caddy -f           # TLS proxy"
echo ""
