package server

import (
	"encoding/json"
	"errors"
	"net/http"
)

var errInvalidCA = errors.New("client CA PEM could not be parsed")

// AgentError mirrors components.schemas.AgentError in vpnhub-agent.yaml.
type AgentError struct {
	Status  string         `json:"status"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, AgentError{Status: "error", Code: code, Message: msg})
}
