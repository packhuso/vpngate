// Package server wires the agent HTTP API (docs/vpnhub-agent.yaml) onto a
// stdlib mux with the 3-layer security model from design Section 6.1.
package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"log/slog"
	"net/http"
	"os"
	"time"

	"vpnhub.local/gateway-agent/internal/config"
	"vpnhub.local/gateway-agent/internal/wg"
)

type Server struct {
	cfg   *config.Config
	wg    wg.Manager
	log   *slog.Logger
	start time.Time
	idem  *idempotencyCache
}

func New(cfg *config.Config, mgr wg.Manager, log *slog.Logger) *Server {
	return &Server{
		cfg:   cfg,
		wg:    mgr,
		log:   log,
		start: time.Now(),
		idem:  newIdempotencyCache(time.Duration(cfg.IdempotencyTTLSeconds) * time.Second),
	}
}

// idempotent caches a write handler's response by Idempotency-Key (24h).
func (s *Server) idempotent(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			h(w, r)
			return
		}
		if e, ok := s.idem.get(key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Idempotent-Replay", "true")
			w.WriteHeader(e.status)
			_, _ = w.Write(e.body)
			return
		}
		rec := &bufWriter{ResponseWriter: w, status: 200, buf: &bytes.Buffer{}}
		h(rec, r)
		if rec.status < 500 { // don't cache transient failures
			s.idem.put(key, rec.status, rec.buf.Bytes())
		}
	}
}

type bufWriter struct {
	http.ResponseWriter
	status int
	buf    *bytes.Buffer
}

func (b *bufWriter) WriteHeader(c int) { b.status = c; b.ResponseWriter.WriteHeader(c) }
func (b *bufWriter) Write(p []byte) (int, error) {
	b.buf.Write(p)
	return b.ResponseWriter.Write(p)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Peers (design Section 7.1 / 7.5)
	mux.HandleFunc("GET /v1/peers", s.handleListPeers)
	mux.HandleFunc("POST /v1/peers", s.idempotent(s.handleCreatePeer))
	mux.HandleFunc("GET /v1/peers/{publicKey}", s.handleGetPeer)
	mux.HandleFunc("PATCH /v1/peers/{publicKey}", s.idempotent(s.handleUpdatePeer))
	mux.HandleFunc("DELETE /v1/peers/{publicKey}", s.idempotent(s.handleDeletePeer))
	mux.HandleFunc("POST /v1/peers/{publicKey}/suspend", s.idempotent(s.handleSuspendPeer))
	mux.HandleFunc("POST /v1/peers/{publicKey}/resume", s.idempotent(s.handleResumePeer))

	// Routes (blackhole for unallocated pool CIDRs)
	mux.HandleFunc("POST /v1/routes/blackhole", s.idempotent(s.handleBlackhole))
	mux.HandleFunc("DELETE /v1/routes/blackhole", s.idempotent(s.handleBlackhole))

	// OpenVPN client-cert issuance (OpenVPN backend only)
	mux.HandleFunc("POST /v1/ovpn/clients/{publicKey}/cert", s.idempotent(s.handleIssueOvpnCert))

	// Ping — control-plane requests this gateway ICMP-ping a peer's tunnel IP
	mux.HandleFunc("POST /v1/ping", s.handlePing)

	// Stats (polled by worker every 30s)
	mux.HandleFunc("GET /v1/stats", s.handleStats)
	mux.HandleFunc("GET /v1/stats/peers", s.handlePeerStats)

	// Health (unauthenticated per spec)
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("GET /v1/ready", s.handleReady)
	mux.HandleFunc("GET /v1/version", s.handleVersion)

	return chain(mux,
		recoverMW(s.log),
		logMW(s.log),
		bearerMW(s.cfg.BearerToken),
	)
}

// tlsConfig builds the mTLS config (design Section 6.1 layer 2): TLS 1.3,
// require + verify a client cert signed by our private CA.
func (s *Server) tlsConfig() (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(s.cfg.ServerCert, s.cfg.ServerKey)
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(s.cfg.ClientCA)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errInvalidCA
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		MinVersion:   tls.VersionTLS13,
	}, nil
}

// Run starts the agent and blocks until ctx is cancelled, then drains.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.cfg.ListenAddr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if s.cfg.TLSDisable {
			s.log.Warn("TLS DISABLED — dev mode only, never use in production",
				"addr", s.cfg.ListenAddr)
			errCh <- srv.ListenAndServe()
			return
		}
		tc, err := s.tlsConfig()
		if err != nil {
			errCh <- err
			return
		}
		srv.TLSConfig = tc
		s.log.Info("agent listening (mTLS)", "addr", s.cfg.ListenAddr,
			"interface", s.wg.Interface())
		errCh <- srv.ListenAndServeTLS("", "")
	}()

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}
