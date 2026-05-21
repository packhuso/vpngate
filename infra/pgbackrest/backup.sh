#!/usr/bin/env bash
# VPN Hub — pgBackRest scheduled backup wrapper (design Section 4.5 Layer 2)
# Usage: backup.sh <full|incr>
set -euo pipefail

TYPE="${1:-incr}"
CONTAINER="vpnhub-postgres"
STANZA="vpnhub"
LOG="/var/log/vpnhub-backup.log"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) [$TYPE] $*" >> "$LOG"; }

if [[ "$TYPE" != "full" && "$TYPE" != "incr" && "$TYPE" != "diff" ]]; then
  echo "usage: $0 <full|incr|diff>" >&2
  exit 2
fi

log "backup start"
if docker exec -u postgres "$CONTAINER" \
     pgbackrest --stanza="$STANZA" --type="$TYPE" backup >> "$LOG" 2>&1; then
  log "backup OK"
else
  rc=$?
  log "backup FAILED rc=$rc"
  exit $rc
fi

# Layer 3 (offsite) — uncomment once R2 repo2 configured in pgbackrest.conf:
# docker exec -u postgres "$CONTAINER" \
#   pgbackrest --stanza="$STANZA" --repo=2 --type="$TYPE" backup >> "$LOG" 2>&1 \
#   && log "R2 offsite OK" || log "R2 offsite FAILED"

log "done"
