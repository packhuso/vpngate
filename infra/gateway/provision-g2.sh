#!/usr/bin/env bash
# VPN Hub gateway — G2: base stack (WireGuard, nftables, FRR) + forwarding.
# Run on the gateway VM as root. Idempotent.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "== apt update + install =="
apt-get update -qq
apt-get install -y -qq wireguard-tools nftables frr frr-pythontools

echo "== WireGuard kernel module =="
if ! modprobe wireguard 2>/dev/null; then
  echo "modprobe failed; installing wireguard meta + headers"
  apt-get install -y -qq wireguard "linux-headers-$(uname -r)" || true
  modprobe wireguard
fi
echo "wireguard: $(cat /sys/module/wireguard/version 2>/dev/null || echo loaded)"
# load on boot
echo wireguard > /etc/modules-load.d/wireguard.conf

echo "== IP forwarding (gateway routes customer traffic) =="
cat > /etc/sysctl.d/99-vpnhub-gw.conf <<'SYS'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.conf.all.rp_filter = 2
SYS
sysctl --system >/dev/null

echo "== enable services (config added in later steps) =="
systemctl enable nftables >/dev/null 2>&1 || true

echo "== versions =="
wg --version
nft --version
vtysh -c 'show version' 2>/dev/null | head -1 || echo "frr installed"
echo "ip_forward=$(cat /proc/sys/net/ipv4/ip_forward)"
echo "G2 DONE"
