#!/bin/sh
[ -n "$PEERNAME" ] || exit 0
f="/etc/vpnhub-sstp/routes.d/$PEERNAME"
[ -f "$f" ] || exit 0
while read -r cidr; do [ -n "$cidr" ] && ip route replace "$cidr" dev "$1"; done < "$f"
r="/etc/vpnhub-sstp/routes.d/$PEERNAME.rate"
if [ -f "$r" ]; then
  kbit=$(head -n1 "$r" 2>/dev/null)
  if [ -n "$kbit" ] && [ "$kbit" -gt 0 ] 2>/dev/null; then
    ifb="ifb_$1"
    modprobe ifb 2>/dev/null
    tc qdisc del dev "$1" root 2>/dev/null
    tc qdisc del dev "$1" ingress 2>/dev/null
    ip link del "$ifb" 2>/dev/null
    tc qdisc add dev "$1" root handle 1: htb default 10
    tc class add dev "$1" parent 1: classid 1:10 htb rate ${kbit}kbit ceil ${kbit}kbit
    tc qdisc add dev "$1" parent 1:10 handle 10: fq_codel
    ip link add "$ifb" type ifb 2>/dev/null
    ip link set "$ifb" up
    tc qdisc add dev "$1" handle ffff: ingress
    tc filter add dev "$1" parent ffff: protocol all u32 match u32 0 0 \
      action mirred egress redirect dev "$ifb"
    tc qdisc add dev "$ifb" root handle 1: htb default 10
    tc class add dev "$ifb" parent 1: classid 1:10 htb rate ${kbit}kbit ceil ${kbit}kbit
    tc qdisc add dev "$ifb" parent 1:10 handle 10: fq_codel
  fi
fi
[ -f /etc/vpnhub-events.conf ] && . /etc/vpnhub-events.conf
if [ -n "$INGEST_URL" ] && [ -n "$INGEST_TOKEN" ]; then
  raw=$(cat "/etc/vpnhub-sstp/routes.d/$PEERNAME.cn" 2>/dev/null)
  [ -n "$raw" ] && curl -s -m 5 -o /dev/null -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
    -d "{\"events\":[{\"protocol\":\"sstp\",\"peerKey\":\"$raw\",\"event\":\"connect\",\"detail\":\"$1\"}]}" 2>/dev/null || true
fi
exit 0
