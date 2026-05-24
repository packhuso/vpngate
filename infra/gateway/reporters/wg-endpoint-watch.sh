#!/bin/sh
# Log WG peer endpoint changes + push ip_change events to the control plane.
IFACE=wg0; STATE=/run/wg-endpoint.state; LOG=/var/log/wg-endpoint.log
CONF=/etc/vpnhub-events.conf; [ -f "$CONF" ] && . "$CONF"
cur=$(wg show "$IFACE" endpoints 2>/dev/null) || exit 0
[ -n "$cur" ] || exit 0
old=""; [ -f "$STATE" ] && old=$(cat "$STATE")
printf '%s\n' "$cur" | while read -r pk ep; do
  [ -n "$pk" ] || continue
  case "$ep" in ""|"(none)") continue;; esac
  prev=$(printf '%s\n' "$old" | awk -v k="$pk" '$1==k{print $2}')
  if [ -n "$prev" ] && [ "$prev" != "$ep" ]; then
    printf '%s peer %s  %s -> %s\n' "$(date '+%F %T')" "$(printf %s "$pk" | cut -c1-10)" "$prev" "$ep" >> "$LOG"
    if [ -n "$INGEST_URL" ] && [ -n "$INGEST_TOKEN" ]; then
      ip=$(printf %s "$ep" | sed 's/:[0-9]*$//')
      curl -s -m 5 -o /dev/null -X POST "$INGEST_URL" \
        -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
        -d "{\"events\":[{\"protocol\":\"wireguard\",\"peerKey\":\"$pk\",\"event\":\"ip_change\",\"clientIp\":\"$ip\",\"detail\":\"$prev -> $ep\"}]}" 2>/dev/null || true
    fi
  fi
done
printf '%s\n' "$cur" > "$STATE"
