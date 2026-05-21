-- Migration 0005 (2026-05-21): allow protocol-specific gateways. An OpenVPN-only
-- node has no WireGuard endpoint/key, so these columns must be nullable. The
-- availableProtocols query keys WG-capability off wg_public_key IS NOT NULL.
ALTER TABLE vpn_gateways ALTER COLUMN wg_endpoint DROP NOT NULL;
ALTER TABLE vpn_gateways ALTER COLUMN wg_public_key DROP NOT NULL;
