-- GRE tunnel support alongside WireGuard. Plain GRE (no IPsec) — auth is
-- source-IP pinning + GRE key. Customer's remote endpoint is stored as a
-- hostname so we can re-resolve DNS when the tunnel goes down (dynamic ISP).
--
-- Design decisions:
-- - Separate private subnet (10.100.0.0/24 for GRE vs 10.99.0.0/24 for WG)
--   so a single tunnel row's private_ip unambiguously identifies protocol.
-- - GRE key (32-bit) is unique per gateway so two customers behind the same
--   ISP CGNAT can still be told apart. Nullable for WG rows.
-- - remote_endpoint_host is the domain the customer gives us; _ip is the
--   most recent resolution + _resolved_at is when we cached it. The worker
--   re-resolves on ping-fail and updates the gateway via `ip tunnel change`.

ALTER TYPE vpn_protocol ADD VALUE IF NOT EXISTS 'gre';

ALTER TABLE tunnels
  ADD COLUMN IF NOT EXISTS remote_endpoint_host        TEXT,
  ADD COLUMN IF NOT EXISTS remote_endpoint_ip          INET,
  ADD COLUMN IF NOT EXISTS remote_endpoint_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gre_key                     BIGINT;

-- GRE key is only meaningful when scoped to a gateway; partial unique index
-- so multiple gateways can independently issue the same key value.
CREATE UNIQUE INDEX IF NOT EXISTS tunnels_gre_key_per_gateway
  ON tunnels (gateway_id, gre_key)
  WHERE gre_key IS NOT NULL AND deleted_at IS NULL;

-- Fast lookup for the worker's re-resolve loop: only GRE tunnels currently
-- online-or-not-yet-checked, ordered by staleness.
CREATE INDEX IF NOT EXISTS tunnels_gre_resolve_idx
  ON tunnels (protocol, remote_endpoint_resolved_at NULLS FIRST)
  WHERE protocol = 'gre' AND deleted_at IS NULL AND status = 'active';

-- vpn_gateways: which protocols each node speaks. Provisioning uses this to
-- pick a gateway when creating a tunnel. Existing rows default to wireguard.
ALTER TABLE vpn_gateways
  ADD COLUMN IF NOT EXISTS supported_protocols TEXT[] NOT NULL
  DEFAULT ARRAY['wireguard'];
