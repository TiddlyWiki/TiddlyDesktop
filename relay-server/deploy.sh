#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────
REMOTE_HOST="${RELAY_HOST:-164.92.180.226}"
REMOTE_USER="${RELAY_USER:-root}"
RELAY_DOMAIN="${RELAY_DOMAIN:-relay.tiddlydesktop-rs.com}"
BINARY_NAME="tiddlydesktop-relay"
REMOTE_BIN="/usr/local/bin/$BINARY_NAME"
SERVICE_NAME="relay"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Step 1: Build ────────────────────────────────────────────────────
# Try musl (static binary, portable), fall back to gnu (requires glibc on server)
cd "$SCRIPT_DIR"

if command -v musl-gcc &>/dev/null || command -v x86_64-linux-musl-gcc &>/dev/null; then
    echo "==> Building for x86_64-unknown-linux-musl (static)..."
    rustup target add x86_64-unknown-linux-musl 2>/dev/null || true
    cargo build --release --target x86_64-unknown-linux-musl
    BINARY="target/x86_64-unknown-linux-musl/release/$BINARY_NAME"
else
    echo "==> musl-gcc not found, building for x86_64-unknown-linux-gnu..."
    echo "    (install musl-gcc for a fully static binary)"
    cargo build --release
    BINARY="target/release/$BINARY_NAME"
fi

if [ ! -f "$BINARY" ]; then
    echo "ERROR: Binary not found at $BINARY"
    exit 1
fi

BINARY_SIZE=$(du -h "$BINARY" | cut -f1)
echo "==> Binary: $BINARY ($BINARY_SIZE)"

# ── Step 2: Upload binary ───────────────────────────────────────────
echo "==> Uploading to $REMOTE_USER@$REMOTE_HOST..."
scp "$BINARY" "$REMOTE_USER@$REMOTE_HOST:/tmp/$BINARY_NAME"

# ── Step 3: Upload service file ───────────────────────────────────
echo "==> Uploading service file..."
scp "$SCRIPT_DIR/relay.service" "$REMOTE_USER@$REMOTE_HOST:/tmp/relay.service"

# ── Step 4: Install and restart ─────────────────────────────────────
echo "==> Installing and restarting service..."
ssh "$REMOTE_USER@$REMOTE_HOST" <<REMOTE
set -e
# Stop service (ignore if not running)
systemctl stop $SERVICE_NAME 2>/dev/null || true
# Move binary into place
mv /tmp/$BINARY_NAME $REMOTE_BIN
chmod +x $REMOTE_BIN
# Update service file if changed
if ! diff -q /tmp/relay.service /etc/systemd/system/$SERVICE_NAME.service &>/dev/null 2>&1; then
    echo "Updating service file..."
    mv /tmp/relay.service /etc/systemd/system/$SERVICE_NAME.service
    systemctl daemon-reload
else
    rm /tmp/relay.service
fi
# Ensure env file directory exists
mkdir -p /etc/tiddlydesktop-relay
chmod 700 /etc/tiddlydesktop-relay
# Start service
systemctl start $SERVICE_NAME
echo "Service status:"
systemctl status $SERVICE_NAME --no-pager || true
REMOTE

echo "==> Done! Relay deployed to $REMOTE_HOST"
echo "    Test: curl https://$RELAY_DOMAIN:8443/health"
