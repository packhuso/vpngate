-- Migration 0004 (2026-05-21): iBGP foundation for symmetric multi-server
-- routing (WireGuard + future OpenVPN nodes are the same archetype — each
-- iBGP-peers with the Mikrotik gateway and redistributes its /32 customer
-- routes). Schema only; bgp_enabled defaults false so the running WireGuard
-- gateway keeps its current static-route behaviour until FRR is rolled out.
-- See docs/IBGP_MULTISERVER_TODO.md.

BEGIN;

ALTER TABLE vpn_gateways
  ADD COLUMN IF NOT EXISTS local_asn     integer,   -- per-node AS, e.g. 65001
  ADD COLUMN IF NOT EXISTS bgp_router_id inet,      -- node's own IP (router-id)
  ADD COLUMN IF NOT EXISTS bgp_peer_ip   inet,      -- Mikrotik side (shared)
  ADD COLUMN IF NOT EXISTS bgp_enabled   boolean NOT NULL DEFAULT false;

COMMIT;
