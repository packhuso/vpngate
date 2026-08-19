# Connection-event reporters (migration 0012)

Each gateway pushes connect/disconnect/ip_change events to the control plane
(`POST /v1/ingest/connection-events`, bearer = `EVENTS_INGEST_TOKEN`). Config in
`/etc/vpnhub-events.conf` (see `.example`). Reporters per protocol:

- **WireGuard** (`wg-endpoint-watch.sh`): systemd timer polls `wg show endpoints`
  every 15s; on a peer endpoint change logs to `/var/log/wg-endpoint.log` and
  POSTs an `ip_change` event.
- **OpenVPN** (`ovpn-connect.sh` / `ovpn-disconnect.sh`): wired via
  `script-security 2` + `client-connect`/`client-disconnect` in `server.conf`.
  Background curl + always `exit 0` so a slow POST never blocks/rejects a client.
- **SSTP** (`sstp-ip-up.d` / `sstp-ip-down.d`): the pppd ip-up/down hooks (which
  also install routes + shaping) read the raw key from the `.cn` sidecar and POST
  connect/disconnect.

peerKey = the client identifier (WG pubkey / OpenVPN CN / SSTP raw key). The
ingest maps it to a tunnel by `wg_public_key`, falling back to a sanitized-CN
match (OpenVPN/SSTP CNs are a lossy-sanitized form of the key).
