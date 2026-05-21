package server

import (
	"net/http"
	"time"
)

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	st, err := s.wg.Stats(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handlePeerStats(w http.ResponseWriter, r *http.Request) {
	peers, err := s.wg.ListPeers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	type peerStat struct {
		PublicKey     string  `json:"publicKey"`
		BytesRx       int64   `json:"bytesRx"`
		BytesTx       int64   `json:"bytesTx"`
		LastHandshake *string `json:"lastHandshake"`
		LastEndpoint  *string `json:"lastEndpoint"`
	}
	out := make([]peerStat, 0, len(peers))
	for _, p := range peers {
		var hs *string
		if p.LastHandshake != nil {
			v := p.LastHandshake.UTC().Format(time.RFC3339)
			hs = &v
		}
		out = append(out, peerStat{
			PublicKey:     p.PublicKey,
			BytesRx:       p.BytesRx,
			BytesTx:       p.BytesTx,
			LastHandshake: hs,
			LastEndpoint:  p.LastEndpoint,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"collectedAt": time.Now().UTC().Format(time.RFC3339),
		"peers":       out,
	})
}
