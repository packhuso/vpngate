#!/usr/bin/env bash
# VPN Hub gateway — G3: WireGuard interface wg0 (pure-routing, design 3.2).
# Gateway holds 10.99.0.1/24; customer peers get 10.99.0.x/32 added by the
# agent at runtime. Idempotent: keeps existing server key if present.
set -euo pipefail

WG_DIR=/etc/wireguard
WG_IF=wg0
WG_ADDR=10.99.0.1/24
WG_PORT=51820

install -d -m 700 "$WG_DIR"

if [[ ! -f "$WG_DIR/server_private.key" ]]; then
  umask 077
  wg genkey > "$WG_DIR/server_private.key"
  wg pubkey < "$WG_DIR/server_private.key" > "$WG_DIR/server_public.key"
  chmod 600 "$WG_DIR/server_private.key"
  chmod 644 "$WG_DIR/server_public.key"
fi
PRIV=$(cat "$WG_DIR/server_private.key")

# wg0.conf has NO [Peer] blocks — the agent manages peers dynamically via
# wgctrl/netlink. Address/ListenPort only.
cat > "$WG_DIR/$WG_IF.conf" <<EOF
# Managed by VPN Hub. Peers are added at runtime by vpnhub-agent.
[Interface]
Address = $WG_ADDR
ListenPort = $WG_PORT
PrivateKey = $PRIV
EOF
chmod 600 "$WG_DIR/$WG_IF.conf"

systemctl enable "wg-quick@$WG_IF" >/dev/null 2>&1 || true
systemctl restart "wg-quick@$WG_IF"

echo "== status =="
ip -br addr show "$WG_IF"
wg show "$WG_IF"
echo "SERVER_PUBLIC_KEY=$(cat "$WG_DIR/server_public.key")"
echo "WG_LISTEN_PORT=$WG_PORT"
echo "G3 DONE"
