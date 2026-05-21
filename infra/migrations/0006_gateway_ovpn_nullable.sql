-- Migration 0006 (2026-05-21): make OpenVPN gateway fields nullable, mirroring
-- 0005 for the WireGuard fields. A protocol-specific gateway should advertise
-- ONLY the protocols it actually serves: a WireGuard-only node must be able to
-- have a NULL ovpn_endpoint so protocol-based gateway selection
-- (ovpn_endpoint IS NOT NULL) never routes an OpenVPN tunnel onto it.
ALTER TABLE vpn_gateways ALTER COLUMN ovpn_endpoint DROP NOT NULL;
ALTER TABLE vpn_gateways ALTER COLUMN ovpn_port     DROP NOT NULL;

-- vpnhub-gw-1 is WireGuard-only — clear its stale placeholder ovpn_endpoint.
UPDATE vpn_gateways SET ovpn_endpoint = NULL, ovpn_port = NULL
WHERE wg_public_key IS NOT NULL AND ovpn_endpoint IS NOT NULL
  AND hostname = 'vpnhub-gw-1';
