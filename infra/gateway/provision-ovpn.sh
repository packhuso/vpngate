#!/usr/bin/env bash
# VPN Hub — OpenVPN node provisioning (Debian 13). Symmetric with the WireGuard
# node: same vpnhub-agent binary, same mTLS, same tc shaping + blackhole + iBGP;
# only the data plane differs (OpenVPN tun0 + DCO instead of wg0).
#
# Run as root on the fresh Debian 13 VM. Expects the agent bundle in
# /tmp/agent-deploy/: vpnhub-agent gw.crt gw.key ca.crt gw.token vpnhub-agent.service
#
# Env you SHOULD set before running (defaults shown):
#   OVPN_SUBNET=10.99.1.0          # private /24 for this node (MUST differ per node)
#   OVPN_PORT=1194
#   OVPN_PROTO=udp
set -euo pipefail

OVPN_SUBNET="${OVPN_SUBNET:-10.99.1.0}"
OVPN_PORT="${OVPN_PORT:-1194}"
OVPN_PROTO="${OVPN_PROTO:-udp}"
SRC=/tmp/agent-deploy
DEST=/etc/vpnhub-agent
OVPN=/etc/openvpn
CCD=$OVPN/ccd

echo "== 1. packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# openvpn 2.6+ (DCO-capable), DCO kernel module (dkms), easy-rsa for PKI,
# iproute2/tc, FRR for iBGP (configured separately per docs/IBGP_MULTISERVER_TODO.md).
# linux-headers are REQUIRED for dkms to actually BUILD the ovpn-dco module —
# without them openvpn-dco-dkms installs but the module is never compiled, so
# DCO silently stays off ("DCO version: N/A").
apt-get install -y openvpn openvpn-dco-dkms easy-rsa iproute2 frr \
  "linux-headers-$(uname -r)" || \
  apt-get install -y openvpn easy-rsa iproute2 frr   # DCO optional if dkms unavailable

echo "== 1b. build + load DCO kernel module =="
# openvpn-dco-dkms only ADDS the module to dkms; force the build, then load it.
dkms autoinstall 2>/dev/null || true
if modprobe ovpn_dco_v2 2>/dev/null || modprobe ovpn-dco 2>/dev/null; then
  # persist across reboots
  echo "ovpn_dco_v2" > /etc/modules-load.d/ovpn-dco.conf
  echo "DCO module loaded"
else
  echo "WARN: ovpn-dco module not loaded — OpenVPN will run without DCO (slower)"
fi

echo "== 2. ip forwarding =="
cat > /etc/sysctl.d/99-vpnhub.conf <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
sysctl --system >/dev/null

echo "== 3. OpenVPN PKI (easy-rsa) =="
if [ ! -d "$OVPN/pki" ]; then
  make-cadir /root/easy-rsa
  cd /root/easy-rsa
  ./easyrsa init-pki
  EASYRSA_BATCH=1 EASYRSA_REQ_CN="VPNHub-OVPN-CA" ./easyrsa build-ca nopass
  EASYRSA_BATCH=1 ./easyrsa gen-req server nopass
  EASYRSA_BATCH=1 ./easyrsa sign-req server server
  ./easyrsa gen-dh
  openvpn --genkey secret pki/tc.key   # tls-crypt key
  install -d -m 700 "$OVPN/pki"
  cp pki/ca.crt           "$OVPN/pki/ca.crt"
  cp pki/private/ca.key   "$OVPN/pki/ca.key"   # agent signs client certs in-process
  cp pki/issued/server.crt "$OVPN/pki/server.crt"
  cp pki/private/server.key "$OVPN/pki/server.key"
  cp pki/dh.pem           "$OVPN/pki/dh.pem"
  cp pki/tc.key           "$OVPN/pki/tc.key"
  chmod 600 "$OVPN/pki/server.key" "$OVPN/pki/ca.key" "$OVPN/pki/tc.key"
fi
install -d -m 755 "$CCD"

echo "== 4. server.conf =="
cat > "$OVPN/server.conf" <<EOF
# VPN Hub OpenVPN node — pure routing, customer gets a real public IP.
dev tun0
dev-type tun
proto $OVPN_PROTO
port $OVPN_PORT
topology subnet

# private subnet for tunnel endpoints (MUST differ per node)
server ${OVPN_SUBNET} 255.255.255.0

# only clients with a CCD file may connect; per-client iroute pins their public
# IPs to their tunnel (the vpnhub-agent writes these files).
client-config-dir $CCD
ccd-exclusive

# isolation: customers must NOT reach each other on the private subnet
# (public-IP traffic is routed per /32 by the agent; no client-to-client).
# (client-to-client is OFF by default — do not enable it.)

ca   $OVPN/pki/ca.crt
cert $OVPN/pki/server.crt
key  $OVPN/pki/server.key
dh   $OVPN/pki/dh.pem
# NOTE: tls-crypt intentionally OMITTED — it breaks Mikrotik RouterOS clients
# (fragile/7.17+ only). Mutual TLS (client+server certs) already secures and
# authenticates the control channel. Re-add "tls-crypt \$OVPN/pki/tc.key" only if
# every client is known to support it.

cipher AES-256-GCM
data-ciphers AES-256-GCM:CHACHA20-POLY1305
auth SHA256
persist-key
persist-tun
keepalive 10 60
verb 3

# management interface — vpnhub-agent uses this for status + client-kill
management 127.0.0.1 7505

# DCO is auto-selected by OpenVPN 2.6+ when the ovpn-dco module is present.
# Force off with: disable-dco
EOF

echo "== 5. openvpn systemd =="
# Use the legacy openvpn@server unit (reads /etc/openvpn/server.conf). The
# modern openvpn-server@server unit expects /etc/openvpn/server/server.conf and
# does NOT pick up this layout — the agent unit also Requires=openvpn@server.
systemctl enable --now openvpn@server
sleep 2
ip link show tun0 >/dev/null 2>&1 && echo "TUN0_UP" || echo "WARN: tun0 not up — check 'journalctl -u openvpn@server'"

echo "== 6. vpnhub-agent (OpenVPN backend) =="
install -d -m 750 "$DEST"
install -m 755 "$SRC/vpnhub-agent" /usr/local/bin/vpnhub-agent
install -m 644 "$SRC/ca.crt"  "$DEST/ca.crt"
install -m 644 "$SRC/gw.crt"  "$DEST/server.crt"
install -m 600 "$SRC/gw.key"  "$DEST/server.key"
TOKEN=$(tr -d '\n' < "$SRC/gw.token")
umask 077
cat > "$DEST/agent.env" <<EOF
AGENT_LISTEN_ADDR=:9443
AGENT_WG_INTERFACE=tun0
AGENT_WG_BACKEND=openvpn
AGENT_OVPN_CCD_DIR=$CCD
AGENT_OVPN_PKI_DIR=$OVPN/pki
AGENT_OVPN_MGMT_ADDR=127.0.0.1:7505
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
echo "OVPN NODE DONE — next: configure FRR iBGP (docs/IBGP_MULTISERVER_TODO.md),"
echo "  then register row in vpn_gateways with protocol='openvpn', ovpn_endpoint/port,"
echo "  local_asn/bgp_router_id/bgp_peer_ip."
