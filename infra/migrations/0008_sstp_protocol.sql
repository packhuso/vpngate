-- Migration 0008 (2026-05-22): add SSTP as a third VPN protocol.
-- A gateway is SSTP-capable when it has an sstp_endpoint (mirrors ovpn_endpoint).
ALTER TYPE vpn_protocol ADD VALUE IF NOT EXISTS 'sstp';
ALTER TABLE vpn_gateways ADD COLUMN IF NOT EXISTS sstp_endpoint varchar(255);
