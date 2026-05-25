#!/bin/sh
# WireGuard reporter: emit connect/disconnect (handshake age) + ip_change.
# State file lines: "<pubkey> <endpoint> <fresh:0|1>". Pushes events to the
# control plane and logs endpoint changes locally.
IFACE=wg0; STATE=/run/wg-endpoint.state; LOG=/var/log/wg-endpoint.log
CONF=/etc/vpnhub-events.conf; [ -f "$CONF" ] && . "$CONF"
FRESH_SECS=180
now=$(date +%s)
eps=$(wg show "$IFACE" endpoints 2>/dev/null) || exit 0
[ -n "$eps" ] || exit 0
hs=$(wg show "$IFACE" latest-handshakes 2>/dev/null)
old=""; [ -f "$STATE" ] && old=$(cat "$STATE")

post() { # $1=pk $2=event $3=ip $4=detail
  [ -n "$INGEST_URL" ] && [ -n "$INGEST_TOKEN" ] || return 0
  curl -s -m 5 -o /dev/null -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
    -d "{\"events\":[{\"protocol\":\"wireguard\",\"peerKey\":\"$1\",\"event\":\"$2\",\"clientIp\":\"$3\",\"detail\":\"$4\"}]}" 2>/dev/null &
}

printf '%s\n' "$eps" | while read -r pk ep; do
  [ -n "$pk" ] || continue
  case "$ep" in ""|"(none)") continue;; esac
  he=$(printf '%s\n' "$hs" | awk -v k="$pk" '$1==k{print $2}'); [ -z "$he" ] && he=0
  fresh=0; [ "$he" -gt 0 ] 2>/dev/null && [ $((now - he)) -lt $FRESH_SECS ] && fresh=1
  prev=$(printf '%s\n' "$old" | awk -v k="$pk" '$1==k{print $2" "$3}')
  pep=$(printf '%s' "$prev" | awk '{print $1}'); pf=$(printf '%s' "$prev" | awk '{print $2}')
  ip=$(printf %s "$ep" | sed 's/:[0-9]*$//')
  # connect: fresh now and was NOT fresh before (covers unknown/upgrade/reboot =
  # seeds currently-online peers). disconnect: was fresh, now stale.
  if [ "$fresh" = "1" ] && [ "$pf" != "1" ]; then
    printf '%s peer %s  connect %s\n' "$(date '+%F %T')" "$(printf %s "$pk"|cut -c1-10)" "$ep" >> "$LOG"
    post "$pk" connect "$ip" ""
  elif [ "$fresh" = "0" ] && [ "$pf" = "1" ]; then
    printf '%s peer %s  disconnect\n' "$(date '+%F %T')" "$(printf %s "$pk"|cut -c1-10)" >> "$LOG"
    post "$pk" disconnect "" ""
  elif [ "$fresh" = "1" ] && [ -n "$pep" ] && [ "$pep" != "$ep" ]; then
    printf '%s peer %s  %s -> %s\n' "$(date '+%F %T')" "$(printf %s "$pk"|cut -c1-10)" "$pep" "$ep" >> "$LOG"
    post "$pk" ip_change "$ip" "$pep -> $ep"
  fi
done
{
  printf '%s\n' "$eps" | while read -r pk ep; do
    [ -n "$pk" ] || continue
    he=$(printf '%s\n' "$hs" | awk -v k="$pk" '$1==k{print $2}'); [ -z "$he" ] && he=0
    fresh=0; [ "$he" -gt 0 ] 2>/dev/null && [ $((now - he)) -lt $FRESH_SECS ] && fresh=1
    printf '%s %s %s\n' "$pk" "$ep" "$fresh"
  done
} > "$STATE"
