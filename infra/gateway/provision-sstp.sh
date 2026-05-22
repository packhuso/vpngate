#!/usr/bin/env bash
# VPN Hub — SSTP node provisioning (Debian 13). Symmetric with WG/OVPN nodes:
# same vpnhub-agent archetype, FRR/BGP, MSS clamp; data plane = SSTP via
# sstp-server (Python frontend, TCP 443 TLS) + pppd (PPP/auth/IP/routes).
#
# accel-ppp isn't packaged on trixie, so we use sstpd (pipx) + native pppd.
# pppd gives us exactly the per-user primitives we need: chap-secrets (fixed IP
# per user) + ip-up.d/ip-down.d hooks (per-user public-/32 routes).
#
# Target client = Mikrotik (verify-server-certificate=no) → self-signed cert ok.
# Run as root on the fresh Debian 13 VM (10.2.1.5 / 185.213.250.92).
#   SSTP_SUBNET=10.99.2   # private /24 (gw .1, clients .2-.254) — differ per node
set -euo pipefail

SSTP_SUBNET="${SSTP_SUBNET:-10.99.2}"
ETC=/etc/vpnhub-sstp
ROUTES_D="$ETC/routes.d"   # agent writes one file per user: public /32s, one per line

echo "== 1. packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ppp pipx nftables frr openssl iproute2
PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install sstp-server || true
# sstp-server 0.7.2 has a logging bug — `logger.info("pppd says", data)` raises
# TypeError on Python 3.13 every time pppd emits diagnostics, which disrupts the
# PPP data forwarding (LCP times out). Fix the format string in-place.
PPP_PY=$(find /opt/pipx/venvs/sstp-server -path '*sstpd/ppp.py' 2>/dev/null | head -1)
[ -n "$PPP_PY" ] && sed -i 's/logger.info("pppd says", data)/logger.info("pppd says: %r", data)/' "$PPP_PY"

echo "== 2. ip forwarding =="
cat > /etc/sysctl.d/99-vpnhub.conf <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
sysctl --system >/dev/null

echo "== 3. self-signed TLS cert (Mikrotik skips verification) =="
install -d -m 750 "$ETC" "$ROUTES_D"
if [ ! -f "$ETC/sstp.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=vpnhub-sstp" \
    -keyout "$ETC/sstp.key" -out "$ETC/sstp.crt"
  chmod 600 "$ETC/sstp.key"
fi
: > /etc/ppp/chap-secrets   # agent populates:  <user>  *  <pass>  <fixed-ip>
chmod 600 /etc/ppp/chap-secrets

echo "== 4. pppd options for SSTP =="
cat > /etc/ppp/options.sstpd <<EOF
require-mschap-v2
refuse-pap
refuse-chap
refuse-mschap
refuse-eap
# No MPPE: SSTP already runs over TLS, so MPPE is redundant double-encryption
# and Mikrotik's SSTP client won't negotiate it (causing "MPPE required" fail).
nomppe
auth
name sstp
nodefaultroute
noipdefault
lcp-echo-interval 30
lcp-echo-failure 4
mtu 1400
mru 1400
# server-side ppp IP; client (remote) IP comes from chap-secrets 4th field
${SSTP_SUBNET}.1:
EOF

echo "== 5. per-user route hooks (pppd ip-up.d / ip-down.d) =="
# pppd runs these on connect/disconnect. PEERNAME = authenticated user, \$1 =
# ppp ifname. Install/remove that user's public /32s (agent maintains routes.d).
cat > /etc/ppp/ip-up.d/vpnhub-routes <<EOF
#!/bin/sh
[ -n "\$PEERNAME" ] || exit 0
f="$ROUTES_D/\$PEERNAME"
[ -f "\$f" ] || exit 0
while read -r cidr; do [ -n "\$cidr" ] && ip route replace "\$cidr" dev "\$1"; done < "\$f"
# speed cap: each ppp iface carries one client, so shape the whole interface.
# kbit lives in the .rate sidecar (agent writes it). Download = HTB on the ppp;
# upload = ingress redirected to a per-ppp ifb then HTB-shaped (queue, not police
# — a policer drops bursts and TCP upload collapses to ~30-50% of the cap).
r="$ROUTES_D/\$PEERNAME.rate"
if [ -f "\$r" ]; then
  kbit=\$(head -n1 "\$r" 2>/dev/null)
  if [ -n "\$kbit" ] && [ "\$kbit" -gt 0 ] 2>/dev/null; then
    ifb="ifb_\$1"
    modprobe ifb 2>/dev/null
    tc qdisc del dev "\$1" root 2>/dev/null
    tc qdisc del dev "\$1" ingress 2>/dev/null
    ip link del "\$ifb" 2>/dev/null
    # download (egress)
    tc qdisc add dev "\$1" root handle 1: htb default 10
    tc class add dev "\$1" parent 1: classid 1:10 htb rate \${kbit}kbit ceil \${kbit}kbit
    tc qdisc add dev "\$1" parent 1:10 handle 10: fq_codel
    # upload (ingress) → per-ppp ifb + HTB
    ip link add "\$ifb" type ifb 2>/dev/null
    ip link set "\$ifb" up
    tc qdisc add dev "\$1" handle ffff: ingress
    tc filter add dev "\$1" parent ffff: protocol all u32 match u32 0 0 \\
      action mirred egress redirect dev "\$ifb"
    tc qdisc add dev "\$ifb" root handle 1: htb default 10
    tc class add dev "\$ifb" parent 1: classid 1:10 htb rate \${kbit}kbit ceil \${kbit}kbit
    tc qdisc add dev "\$ifb" parent 1:10 handle 10: fq_codel
  fi
fi
exit 0
EOF
cat > /etc/ppp/ip-down.d/vpnhub-routes <<EOF
#!/bin/sh
[ -n "\$PEERNAME" ] || exit 0
ip link del "ifb_\$1" 2>/dev/null   # tear down the per-ppp upload-shaping ifb
f="$ROUTES_D/\$PEERNAME"
[ -f "\$f" ] || exit 0
while read -r cidr; do [ -n "\$cidr" ] && ip route del "\$cidr" 2>/dev/null; done < "\$f"
exit 0
EOF
chmod 755 /etc/ppp/ip-up.d/vpnhub-routes /etc/ppp/ip-down.d/vpnhub-routes

echo "== 6. sstpd systemd service =="
cat > /etc/systemd/system/vpnhub-sstpd.service <<EOF
[Unit]
Description=VPN Hub SSTP server (sstp-server + pppd)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/sstpd -l 0.0.0.0 -p 443 -c $ETC/sstp.crt -k $ETC/sstp.key \\
    --local ${SSTP_SUBNET}.1 --pppd-config /etc/ppp/options.sstpd
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now vpnhub-sstpd
sleep 2
systemctl is-active vpnhub-sstpd && echo "SSTPD_ACTIVE"
ss -tlnp | grep ':443 ' && echo "SSTP_LISTENING_443" || echo "WARN: not listening on 443"

echo "SSTP base done — next: vpnhub-agent (backend=sstp) + FRR iBGP (AS 65003) + nft MSS."
