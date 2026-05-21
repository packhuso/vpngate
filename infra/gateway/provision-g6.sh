#!/usr/bin/env bash
# VPN Hub gateway — G6: install agent binary + certs + config + systemd.
# Expects in /tmp/agent-deploy/: vpnhub-agent gw.crt gw.key ca.crt gw.token
#                                 vpnhub-agent.service
set -euo pipefail
SRC=/tmp/agent-deploy
DEST=/etc/vpnhub-agent

install -d -m 750 "$DEST"
install -m 755 "$SRC/vpnhub-agent"            /usr/local/bin/vpnhub-agent
install -m 644 "$SRC/ca.crt"                  "$DEST/ca.crt"
install -m 644 "$SRC/gw.crt"                  "$DEST/server.crt"
install -m 600 "$SRC/gw.key"                  "$DEST/server.key"

TOKEN=$(tr -d '\n' < "$SRC/gw.token")
umask 077
cat > "$DEST/agent.env" <<EOF
AGENT_LISTEN_ADDR=:9443
AGENT_WG_INTERFACE=wg0
AGENT_WG_BACKEND=kernel
AGENT_TLS_SERVER_CERT=$DEST/server.crt
AGENT_TLS_SERVER_KEY=$DEST/server.key
AGENT_TLS_CLIENT_CA=$DEST/ca.crt
AGENT_BEARER_TOKEN=$TOKEN
EOF
chmod 600 "$DEST/agent.env"

install -m 644 "$SRC/vpnhub-agent.service" /etc/systemd/system/vpnhub-agent.service
systemctl daemon-reload
systemctl enable vpnhub-agent >/dev/null 2>&1 || true
systemctl restart vpnhub-agent
sleep 2
systemctl is-active vpnhub-agent && echo "AGENT_ACTIVE"
rm -rf "$SRC"
echo "G6 DONE"
