package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"vpnhub.local/gateway-agent/internal/config"
	"vpnhub.local/gateway-agent/internal/wg"
)

func newTestServer() http.Handler {
	cfg := &config.Config{WGInterface: "wg0", TLSDisable: true, IdempotencyTTLSeconds: 60}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(cfg, wg.NewMemoryManager("wg0"), log).Handler()
}

func do(t *testing.T, h http.Handler, method, path string, body any, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := map[string]any{}
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec, out
}

func TestPeerLifecycle(t *testing.T) {
	h := newTestServer()
	pk := "NlSqLR7vS8eM3qXY8NaWvE6tZxK2zP4yR3DcF1bGhJ8="
	esc := "NlSqLR7vS8eM3qXY8NaWvE6tZxK2zP4yR3DcF1bGhJ8%3D"

	rec, body := do(t, h, "POST", "/v1/peers", map[string]any{
		"peerId": "11111111-1111-1111-1111-111111111111", "publicKey": pk,
		"privateIp": "10.99.0.5", "publicIps": []string{"203.0.113.50"},
	}, map[string]string{"Idempotency-Key": "k1"})
	if rec.Code != 200 || body["status"] != "ok" {
		t.Fatalf("create: code=%d body=%v", rec.Code, body)
	}

	if rec, _ := do(t, h, "POST", "/v1/peers", map[string]any{
		"peerId": "x", "publicKey": pk, "privateIp": "10.99.0.5",
	}, map[string]string{"Idempotency-Key": "k1"}); rec.Header().Get("Idempotent-Replay") != "true" {
		t.Fatalf("expected idempotent replay, got headers %v", rec.Header())
	}

	if rec, b := do(t, h, "GET", "/v1/peers", nil, nil); rec.Code != 200 || len(b["peers"].([]any)) != 1 {
		t.Fatalf("list: code=%d body=%v", rec.Code, b)
	}
	if rec, b := do(t, h, "GET", "/v1/peers/"+esc, nil, nil); rec.Code != 200 || b["privateIp"] != "10.99.0.5" {
		t.Fatalf("get: code=%d body=%v", rec.Code, b)
	}
	if rec, _ := do(t, h, "PATCH", "/v1/peers/"+esc, map[string]any{
		"privateIp": "10.99.0.5", "publicIps": []string{"203.0.113.51", "203.0.113.52"},
	}, nil); rec.Code != 200 {
		t.Fatalf("patch: code=%d", rec.Code)
	}
	for _, op := range []string{"suspend", "resume"} {
		if rec, _ := do(t, h, "POST", "/v1/peers/"+esc+"/"+op, nil, nil); rec.Code != 200 {
			t.Fatalf("%s: code=%d", op, rec.Code)
		}
	}
	if rec, _ := do(t, h, "DELETE", "/v1/peers/"+esc, nil, nil); rec.Code != 204 {
		t.Fatalf("delete: code=%d", rec.Code)
	}
	if rec, _ := do(t, h, "GET", "/v1/peers/"+esc, nil, nil); rec.Code != 404 {
		t.Fatalf("get after delete: want 404 got %d", rec.Code)
	}
}

func TestHealthEndpoints(t *testing.T) {
	h := newTestServer()
	for _, p := range []string{"/v1/health", "/v1/ready", "/v1/version"} {
		if rec, _ := do(t, h, "GET", p, nil, nil); rec.Code != 200 {
			t.Fatalf("%s: code=%d", p, rec.Code)
		}
	}
}

func TestBearerEnforced(t *testing.T) {
	cfg := &config.Config{WGInterface: "wg0", BearerToken: "secret", IdempotencyTTLSeconds: 60}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := New(cfg, wg.NewMemoryManager("wg0"), log).Handler()

	if rec, _ := do(t, h, "GET", "/v1/peers", nil, nil); rec.Code != 401 {
		t.Fatalf("no token: want 401 got %d", rec.Code)
	}
	if rec, _ := do(t, h, "GET", "/v1/peers", nil, map[string]string{"Authorization": "Bearer secret"}); rec.Code != 200 {
		t.Fatalf("with token: want 200 got %d", rec.Code)
	}
	if rec, _ := do(t, h, "GET", "/v1/health", nil, nil); rec.Code != 200 {
		t.Fatalf("health must be unauthenticated: got %d", rec.Code)
	}
}
