package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"vpnhub.local/gateway-agent/internal/wg"
)

func (s *Server) handleListPeers(w http.ResponseWriter, r *http.Request) {
	peers, err := s.wg.ListPeers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"interface": s.wg.Interface(),
		"peers":     peers,
	})
}

type createPeerReq struct {
	PeerID         string   `json:"peerId"`
	PublicKey      string   `json:"publicKey"`
	PresharedKey   string   `json:"presharedKey"`
	PrivateIP      string   `json:"privateIp"`
	PublicIPs      []string `json:"publicIps"`
	SpeedLimitKbit int      `json:"speedLimitKbit"`
}

func (s *Server) handleCreatePeer(w http.ResponseWriter, r *http.Request) {
	var req createPeerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid JSON body")
		return
	}
	if req.PeerID == "" || req.PublicKey == "" || req.PrivateIP == "" {
		writeErr(w, http.StatusBadRequest, "VALIDATION_ERROR", "peerId, publicKey and privateIp are required")
		return
	}
	p, err := s.wg.CreatePeer(r.Context(), wg.CreatePeerInput{
		PeerID:         req.PeerID,
		PublicKey:      req.PublicKey,
		PresharedKey:   req.PresharedKey,
		PrivateIP:      req.PrivateIP,
		PublicIPs:      req.PublicIPs,
		SpeedLimitKbit: req.SpeedLimitKbit,
	})
	switch {
	case errors.Is(err, wg.ErrConflict):
		writeErr(w, http.StatusConflict, "PEER_CONFLICT", "peer exists with different config")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"peerId":    p.PeerID,
		"interface": s.wg.Interface(),
		"appliedAt": time.Now().UTC().Format(time.RFC3339),
	})
}

func pubKeyParam(r *http.Request) string {
	pk := r.PathValue("publicKey")
	if dec, err := url.PathUnescape(pk); err == nil {
		return dec
	}
	return pk
}

func (s *Server) handleGetPeer(w http.ResponseWriter, r *http.Request) {
	p, err := s.wg.GetPeer(r.Context(), pubKeyParam(r))
	if errors.Is(err, wg.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "peer not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type updatePeerReq struct {
	PrivateIP      string   `json:"privateIp"`
	PublicIPs      []string `json:"publicIps"`
	SpeedLimitKbit int      `json:"speedLimitKbit"`
}

func (s *Server) handleUpdatePeer(w http.ResponseWriter, r *http.Request) {
	var req updatePeerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "VALIDATION_ERROR", "invalid JSON body")
		return
	}
	_, err := s.wg.UpdatePeer(r.Context(), pubKeyParam(r), wg.UpdatePeerInput{
		PrivateIP:      req.PrivateIP,
		PublicIPs:      req.PublicIPs,
		SpeedLimitKbit: req.SpeedLimitKbit,
	})
	if errors.Is(err, wg.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "peer not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok", "appliedAt": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleDeletePeer(w http.ResponseWriter, r *http.Request) {
	if err := s.wg.DeletePeer(r.Context(), pubKeyParam(r)); err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent) // 204 — removed or didn't exist
}

func (s *Server) handleSuspendPeer(w http.ResponseWriter, r *http.Request) {
	s.toggle(w, r, s.wg.SuspendPeer, "suspended")
}

func (s *Server) handleResumePeer(w http.ResponseWriter, r *http.Request) {
	s.toggle(w, r, s.wg.ResumePeer, "resumed")
}

func (s *Server) toggle(w http.ResponseWriter, r *http.Request,
	fn func(ctx context.Context, pk string) error, state string) {
	if err := fn(r.Context(), pubKeyParam(r)); err != nil {
		if errors.Is(err, wg.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "peer not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "state": state})
}

type blackholeReq struct {
	CIDR string `json:"cidr"`
}

// POST /v1/routes/blackhole — install; DELETE — remove. Body: {cidr}.
func (s *Server) handleBlackhole(w http.ResponseWriter, r *http.Request) {
	var req blackholeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.CIDR == "" {
		writeErr(w, http.StatusBadRequest, "VALIDATION_ERROR", "cidr required")
		return
	}
	add := r.Method == http.MethodPost
	if err := s.wg.SetBlackhole(r.Context(), req.CIDR, add); err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok", "cidr": req.CIDR, "blackhole": add,
	})
}

// POST /v1/ovpn/clients/{publicKey}/cert — issue (or reuse) a client cert for
// the CN carried in the publicKey slot. Returns the CA + client cert/key +
// tls-crypt key the control plane assembles into a .ovpn profile.
func (s *Server) handleIssueOvpnCert(w http.ResponseWriter, r *http.Request) {
	cert, err := s.wg.IssueClientCert(r.Context(), pubKeyParam(r))
	switch {
	case errors.Is(err, wg.ErrNotSupported):
		writeErr(w, http.StatusNotImplemented, "NOT_SUPPORTED", "backend does not issue OpenVPN certs")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cert)
}
