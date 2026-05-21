package server

import (
	"net/http"
	"time"

	"vpnhub.local/gateway-agent/internal/version"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"uptime":  int(time.Since(s.start).Seconds()),
		"version": version.Version,
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	checks, ok := s.wg.Ready(r.Context())
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "degraded", "checks": checks,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ready", "checks": checks,
	})
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":   version.Version,
		"commit":    version.Commit,
		"buildTime": version.BuildTime,
		"goVersion": version.GoVersion(),
	})
}
