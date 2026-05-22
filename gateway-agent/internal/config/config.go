// Package config loads agent configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	ListenAddr  string // host:port the agent binds (design: :9443)
	WGInterface string // VPN interface name (wg0 for WireGuard, tun0 for OpenVPN)
	WGBackend   string // "kernel" (WireGuard) | "openvpn" | "memory" (dev/test)

	// OpenVPN backend only
	OVPNCcdDir   string // client-config-dir, e.g. /etc/openvpn/ccd
	OVPNPkiDir   string // PKI dir for client-cert issuance (ca.crt, ca.key, tc.key)
	OVPNMgmtAddr string // management iface: "127.0.0.1:7505" or "unix:/run/openvpn/mgmt.sock"

	// SSTP backend only (sstp-server + pppd)
	SSTPChapPath  string // pppd chap-secrets, e.g. /etc/ppp/chap-secrets
	SSTPRoutesDir string // per-user public-/32 routes for ip-up.d, e.g. /etc/vpnhub-sstp/routes.d

	// Security (design Section 6.1 — mTLS + Bearer; firewall is host-level)
	TLSDisable  bool   // dev only: serve plain HTTP (NEVER in production)
	ServerCert  string // PEM path — agent server cert
	ServerKey   string // PEM path — agent server key
	ClientCA    string // PEM path — private CA that signed worker client certs
	BearerToken string // per-gateway token (stored encrypted in vpn_gateways.agent_token)

	IdempotencyTTLSeconds int
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load reads config from env, applying design-sane defaults.
func Load() (*Config, error) {
	c := &Config{
		ListenAddr:            env("AGENT_LISTEN_ADDR", ":9443"),
		WGInterface:           env("AGENT_WG_INTERFACE", "wg0"),
		WGBackend:             env("AGENT_WG_BACKEND", "kernel"),
		OVPNCcdDir:            env("AGENT_OVPN_CCD_DIR", "/etc/openvpn/ccd"),
		OVPNPkiDir:            env("AGENT_OVPN_PKI_DIR", "/etc/openvpn/pki"),
		OVPNMgmtAddr:          env("AGENT_OVPN_MGMT_ADDR", "127.0.0.1:7505"),
		SSTPChapPath:          env("AGENT_SSTP_CHAP_SECRETS", "/etc/ppp/chap-secrets"),
		SSTPRoutesDir:         env("AGENT_SSTP_ROUTES_DIR", "/etc/vpnhub-sstp/routes.d"),
		TLSDisable:            envBool("AGENT_TLS_DISABLE", false),
		ServerCert:            env("AGENT_TLS_SERVER_CERT", ""),
		ServerKey:             env("AGENT_TLS_SERVER_KEY", ""),
		ClientCA:              env("AGENT_TLS_CLIENT_CA", ""),
		BearerToken:           env("AGENT_BEARER_TOKEN", ""),
		IdempotencyTTLSeconds: envInt("AGENT_IDEMPOTENCY_TTL", 86400),
	}

	if c.TLSDisable {
		return c, nil // dev mode: skip cert/token validation
	}
	missing := []string{}
	if c.ServerCert == "" {
		missing = append(missing, "AGENT_TLS_SERVER_CERT")
	}
	if c.ServerKey == "" {
		missing = append(missing, "AGENT_TLS_SERVER_KEY")
	}
	if c.ClientCA == "" {
		missing = append(missing, "AGENT_TLS_CLIENT_CA")
	}
	if c.BearerToken == "" {
		missing = append(missing, "AGENT_BEARER_TOKEN")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required config (or set AGENT_TLS_DISABLE=true for dev): %v", missing)
	}
	return c, nil
}
