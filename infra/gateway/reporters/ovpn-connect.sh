#!/bin/sh
# OpenVPN client-connect: push connect event (background curl; ALWAYS exit 0 so
# a slow/failed POST never blocks or rejects the client).
[ -f /etc/vpnhub-events.conf ] && . /etc/vpnhub-events.conf
if [ -n "$INGEST_URL" ] && [ -n "$INGEST_TOKEN" ]; then
  curl -s -m 5 -o /dev/null -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
    -d "{\"events\":[{\"protocol\":\"openvpn\",\"peerKey\":\"$common_name\",\"event\":\"connect\",\"clientIp\":\"$trusted_ip\",\"detail\":\"port $trusted_port\"}]}" >/dev/null 2>&1 &
fi
exit 0
