// Command agent is the VPN Hub gateway agent (design Section 3.1 / 12.2).
// It runs on each gateway VM and exposes the API in docs/vpnhub-agent.yaml
// to the control-plane worker over mTLS + Bearer (port 9443).
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"vpnhub.local/gateway-agent/internal/config"
	"vpnhub.local/gateway-agent/internal/server"
	"vpnhub.local/gateway-agent/internal/version"
	"vpnhub.local/gateway-agent/internal/wg"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("config error", "err", err)
		os.Exit(1)
	}

	// Backend selection. "kernel" drives real WireGuard (wgctrl+netlink) and
	// is the default on the gateway VM. "memory" has no kernel side effects
	// (dev box / contract tests).
	var mgr wg.Manager
	switch cfg.WGBackend {
	case "memory":
		mgr = wg.NewMemoryManager(cfg.WGInterface)
	case "kernel":
		km, err := wg.NewKernelManager(cfg.WGInterface)
		if err != nil {
			log.Error("kernel WireGuard backend init failed", "err", err,
				"hint", "is wg0 up? run as root? or set AGENT_WG_BACKEND=memory")
			os.Exit(1)
		}
		mgr = km
	case "openvpn":
		om, err := wg.NewOpenVPNManager(cfg.WGInterface, cfg.OVPNCcdDir, cfg.OVPNPkiDir, cfg.OVPNMgmtAddr)
		if err != nil {
			log.Error("openvpn backend init failed", "err", err,
				"hint", "is tun0 up? CCD dir writable? AGENT_WG_INTERFACE=tun0")
			os.Exit(1)
		}
		mgr = om
	default:
		log.Error("invalid AGENT_WG_BACKEND", "value", cfg.WGBackend)
		os.Exit(1)
	}

	log.Info("starting vpnhub gateway-agent",
		"version", version.Version, "go", version.GoVersion(),
		"backend", cfg.WGBackend, "interface", cfg.WGInterface,
		"tlsDisabled", cfg.TLSDisable)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := server.New(cfg, mgr, log).Run(ctx); err != nil {
		log.Error("agent exited with error", "err", err)
		os.Exit(1)
	}
	log.Info("agent stopped cleanly")
}
