#!/bin/sh
[ -n "$PEERNAME" ] || exit 0
[ -f /etc/vpnhub-events.conf ] && . /etc/vpnhub-events.conf
if [ -n "$INGEST_URL" ] && [ -n "$INGEST_TOKEN" ]; then
  raw=$(cat "/etc/vpnhub-sstp/routes.d/$PEERNAME.cn" 2>/dev/null)
  [ -n "$raw" ] && curl -s -m 5 -o /dev/null -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
    -d "{\"events\":[{\"protocol\":\"sstp\",\"peerKey\":\"$raw\",\"event\":\"disconnect\",\"detail\":\"$1\"}]}" 2>/dev/null || true
fi
ip link del "ifb_$1" 2>/dev/null
f="/etc/vpnhub-sstp/routes.d/$PEERNAME"
[ -f "$f" ] || exit 0
while read -r cidr; do [ -n "$cidr" ] && ip route del "$cidr" 2>/dev/null; done < "$f"
exit 0
