package server

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

type middleware func(http.Handler) http.Handler

func chain(h http.Handler, mws ...middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// recoverMW turns panics into a 500 AgentError instead of crashing the agent.
func recoverMW(log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic recovered", "panic", rec, "path", r.URL.Path)
					writeErr(w, http.StatusInternalServerError, "INTERNAL", "internal agent error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func logMW(log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w, status: 200}
			next.ServeHTTP(sw, r)
			log.Info("request",
				"method", r.Method, "path", r.URL.Path,
				"status", sw.status, "dur_ms", time.Since(start).Milliseconds())
		})
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(c int) {
	s.status = c
	s.ResponseWriter.WriteHeader(c)
}

// bearerMW enforces the per-gateway Bearer token (design Section 6.1 layer 3).
// mTLS (layer 2) is enforced at the TLS listener; the host firewall is layer 1.
// Health/ready/version are exempt (security: [] in the spec).
func bearerMW(token string) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/v1/health", "/v1/ready", "/v1/version":
				next.ServeHTTP(w, r)
				return
			}
			if token == "" { // dev mode (AGENT_TLS_DISABLE) — no token configured
				next.ServeHTTP(w, r)
				return
			}
			const p = "Bearer "
			got := r.Header.Get("Authorization")
			if len(got) <= len(p) || subtle.ConstantTimeCompare([]byte(got[len(p):]), []byte(token)) != 1 {
				writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or missing bearer token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// idempotencyCache caches write-op responses by Idempotency-Key for 24h
// (design Section: "Same key within 24h returns cached result").
type idempotencyCache struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[string]idemEntry
}

type idemEntry struct {
	status int
	body   []byte
	exp    time.Time
}

func newIdempotencyCache(ttl time.Duration) *idempotencyCache {
	return &idempotencyCache{ttl: ttl, m: make(map[string]idemEntry)}
}

func (c *idempotencyCache) get(key string) (idemEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || time.Now().After(e.exp) {
		delete(c.m, key)
		return idemEntry{}, false
	}
	return e, true
}

func (c *idempotencyCache) put(key string, status int, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = idemEntry{status: status, body: body, exp: time.Now().Add(c.ttl)}
}
