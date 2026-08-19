-- Migration 0012 (2026-05-24): centralized VPN connection events.
-- Gateways (WG/OpenVPN/SSTP) push connect/disconnect/ip_change events to the
-- control plane; stored here for the admin connection-history view. High-volume
-- + append-only → kept bounded by a 90-day retention prune (worker job) and by
-- only recording real state changes (debounced upstream).

BEGIN;

CREATE TABLE IF NOT EXISTS connection_events (
  id          BIGSERIAL PRIMARY KEY,
  tunnel_id   UUID,                       -- mapped from the peer key; NULL = orphan
  protocol    TEXT NOT NULL,              -- wireguard | openvpn | sstp
  event       TEXT NOT NULL,              -- connect | disconnect | ip_change
  client_ip   INET,                       -- real source IP of the client (if known)
  detail      TEXT,                       -- e.g. "58.x -> 171.x", duration
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-tunnel history (admin view) + prune scan
CREATE INDEX IF NOT EXISTS idx_conn_events_tunnel  ON connection_events (tunnel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conn_events_created ON connection_events (created_at);

COMMIT;
