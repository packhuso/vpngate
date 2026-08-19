#!/bin/sh
[ -f /etc/vpnhub-events.conf ] && . /etc/vpnhub-events.conf
if [ -n "$INGEST_URL" ] && [ -n "$INGEST_TOKEN" ]; then
  curl -s -m 5 -o /dev/null -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
    -d "{\"events\":[{\"protocol\":\"openvpn\",\"peerKey\":\"$common_name\",\"event\":\"disconnect\",\"clientIp\":\"$trusted_ip\",\"detail\":\"dur ${time_duration}s\"}]}" >/dev/null 2>&1 &
fi
exit 0
