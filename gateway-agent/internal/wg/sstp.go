//go:build linux

// SSTP backend — implements the same Manager contract as the WireGuard/OpenVPN
// backends so the control plane stays protocol-agnostic. Data plane:
//   - sstp-server (TLS:443 frontend) + pppd. Each tunnel is a PPP user.
//   - chap-secrets line per tunnel: "<user> sstp <password> <fixed-ip>", where
//     fixed-ip = the tunnel's private IP (so we always know the client's PPP IP).
//   - routes.d/<user>: the public /32s; pppd's ip-up.d installs them on connect.
//   - live IP moves: the client's PPP iface is found via `ip route get <fixed-ip>`
//     (→ pppN), and routes are added/removed directly — no reconnect needed
//     (the fixed IP is the big advantage over OpenVPN's CCD-reconnect model).
//
// The control plane's "publicKey" slot is reused as the SSTP username; the agent
// generates the password and returns both via IssueClientCert (ClientCert=user,
// ClientKey=password) so the portal can show credentials + build the .rsc.
package wg

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type sstpPeer struct {
	peerID    string
	rawKey    string // the control plane's publicKey slot (verbatim) — returned in
	          // peerView so drift can match against the DB; sanitize is lossy.
	user      string // chap-secrets username (sanitized publicKey)
	password  string
	privateIP string // fixed PPP IP
	publicIPs []string
	status    PeerStatus
	createdAt time.Time
}

type SSTPManager struct {
	chapPath  string // /etc/ppp/chap-secrets
	routesDir string // /etc/vpnhub-sstp/routes.d
	mu        sync.Mutex
	meta      map[string]*sstpPeer // keyed by username
}

func NewSSTPManager(chapPath, routesDir string) (*SSTPManager, error) {
	if chapPath == "" {
		chapPath = "/etc/ppp/chap-secrets"
	}
	if routesDir == "" {
		routesDir = "/etc/vpnhub-sstp/routes.d"
	}
	if err := os.MkdirAll(routesDir, 0o750); err != nil {
		return nil, fmt.Errorf("routes dir %s: %w", routesDir, err)
	}
	m := &SSTPManager{chapPath: chapPath, routesDir: routesDir, meta: map[string]*sstpPeer{}}
	m.loadChapSecrets() // rebuild meta from disk after a restart
	return m, nil
}

func (m *SSTPManager) Interface() string { return "ppp" }

// ── helpers ────────────────────────────────────────────────────────────────

func genPassword() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	// URL-safe, no padding — valid in chap-secrets (whitespace-delimited)
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "=")
}

// sstpUser sanitizes the publicKey slot into a chap-secrets-safe username.
func sstpUser(cn string) string { return sanitizeCN(cn) }

func (m *SSTPManager) routeFile(user string) string {
	return filepath.Join(m.routesDir, user)
}

// cnFile stores the raw publicKey alongside the user (sanitize is lossy, so we
// can't recover it from chap-secrets after a restart).
func (m *SSTPManager) cnFile(user string) string {
	return filepath.Join(m.routesDir, user+".cn")
}

func (m *SSTPManager) writeCnFile(p *sstpPeer) {
	if p.rawKey != "" {
		_ = os.WriteFile(m.cnFile(p.user), []byte(p.rawKey), 0o600)
	}
}

// pppIface returns the ppp interface currently carrying the fixed IP (i.e. the
// user is connected), or "" if the route can't be resolved (user offline).
func pppIface(fixedIP string) string {
	out, err := exec.Command("ip", "-o", "route", "get", fixedIP).CombinedOutput()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	for i, f := range fields {
		if f == "dev" && i+1 < len(fields) {
			if strings.HasPrefix(fields[i+1], "ppp") {
				return fields[i+1]
			}
		}
	}
	return ""
}

// writeRoutesFile writes the user's public /32s (expanded), used by ip-up.d.
func (m *SSTPManager) writeRoutesFile(p *sstpPeer) error {
	var b strings.Builder
	if p.status != StatusSuspended {
		for _, ip := range expandToHost32(p.publicIPs) {
			b.WriteString(ip + "/32\n")
		}
	}
	tmp := m.routeFile(p.user) + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, m.routeFile(p.user))
}

// applyRoutesLive installs/removes the user's /32s on the live ppp iface (if
// connected). diff is computed by the caller; this just (re)applies the full
// desired set and removes the given stale ones.
func (m *SSTPManager) applyRoutesLive(p *sstpPeer, stale []string) {
	iface := pppIface(p.privateIP)
	for _, ip := range stale {
		runOK("ip", "route", "del", host32(ip))
	}
	if iface == "" || p.status == StatusSuspended {
		return // offline or suspended → ip-up.d will install on (re)connect
	}
	for _, ip := range expandToHost32(p.publicIPs) {
		runOK("ip", "route", "replace", host32(ip), "dev", iface)
	}
}

// ── chap-secrets (atomic rewrite from meta) ─────────────────────────────────

func (m *SSTPManager) rewriteChapSecrets() error {
	var b strings.Builder
	b.WriteString("# client\tserver\tsecret\tIP  (managed by vpnhub-agent)\n")
	for _, p := range m.meta {
		if p.status == StatusSuspended {
			continue // suspended users can't authenticate
		}
		fmt.Fprintf(&b, "%s\tsstp\t%s\t%s\n", p.user, p.password, p.privateIP)
	}
	tmp := m.chapPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.chapPath)
}

// loadChapSecrets rebuilds meta from disk on startup (passwords survive restart).
func (m *SSTPManager) loadChapSecrets() {
	f, err := os.Open(m.chapPath)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		user := f[0]
		p := &sstpPeer{user: user, password: f[2], privateIP: f[3], status: StatusActive, createdAt: time.Now().UTC()}
		if raw, err := os.ReadFile(m.cnFile(user)); err == nil {
			p.rawKey = strings.TrimSpace(string(raw))
		}
		// recover public IPs from the routes file
		if data, err := os.ReadFile(m.routeFile(user)); err == nil {
			for _, ln := range strings.Split(string(data), "\n") {
				if ln = strings.TrimSpace(ln); ln != "" {
					p.publicIPs = append(p.publicIPs, ln)
				}
			}
		}
		m.meta[user] = p
	}
}

// killSession terminates the user's pppd so a suspend/delete takes effect now.
func killSession(fixedIP string) {
	if iface := pppIface(fixedIP); iface != "" {
		// the pppd owning this iface; SIGTERM by matching the ifname in cmdline
		out, _ := exec.Command("pgrep", "-f", "pppd.*"+iface).Output()
		for _, pid := range strings.Fields(string(out)) {
			_ = exec.Command("kill", pid).Run()
		}
	}
}

// ── Manager interface ───────────────────────────────────────────────────────

func (m *SSTPManager) CreatePeer(_ context.Context, in CreatePeerInput) (*Peer, error) {
	user := sstpUser(in.PublicKey)
	if user == "" || in.PrivateIP == "" {
		return nil, fmt.Errorf("publicKey (user) and privateIp required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[user]
	if ok && p.privateIP != in.PrivateIP {
		return nil, ErrConflict
	}
	if !ok {
		p = &sstpPeer{user: user, password: genPassword(), createdAt: time.Now().UTC()}
		m.meta[user] = p
	}
	p.rawKey = in.PublicKey
	p.peerID = in.PeerID
	p.privateIP = in.PrivateIP
	p.publicIPs = in.PublicIPs
	p.status = StatusActive
	if err := m.rewriteChapSecrets(); err != nil {
		return nil, fmt.Errorf("chap-secrets: %w", err)
	}
	if err := m.writeRoutesFile(p); err != nil {
		return nil, fmt.Errorf("routes file: %w", err)
	}
	m.writeCnFile(p)
	m.applyRoutesLive(p, nil)
	return m.peerView(p), nil
}

func (m *SSTPManager) UpdatePeer(_ context.Context, cn string, in UpdatePeerInput) (*Peer, error) {
	user := sstpUser(cn)
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[user]
	if !ok {
		p = &sstpPeer{user: user, password: genPassword(), status: StatusActive, createdAt: time.Now().UTC()}
		m.meta[user] = p
	}
	p.rawKey = cn
	old := expandToHost32(p.publicIPs)
	p.privateIP = in.PrivateIP
	p.publicIPs = in.PublicIPs
	if err := m.rewriteChapSecrets(); err != nil {
		return nil, err
	}
	if err := m.writeRoutesFile(p); err != nil {
		return nil, err
	}
	m.writeCnFile(p)
	// fixed IP → apply live without forcing a reconnect: drop removed /32s,
	// (re)install the current set on the user's ppp iface.
	m.applyRoutesLive(p, diff(old, expandToHost32(in.PublicIPs)))
	return m.peerView(p), nil
}

func (m *SSTPManager) DeletePeer(_ context.Context, cn string) error {
	user := sstpUser(cn)
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[user]
	if ok {
		for _, ip := range expandToHost32(p.publicIPs) {
			runOK("ip", "route", "del", host32(ip))
		}
		killSession(p.privateIP)
	}
	_ = os.Remove(m.routeFile(user))
	_ = os.Remove(m.cnFile(user))
	delete(m.meta, user)
	return m.rewriteChapSecrets()
}

func (m *SSTPManager) SuspendPeer(_ context.Context, cn string) error {
	user := sstpUser(cn)
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[user]
	if !ok {
		return ErrNotFound
	}
	p.status = StatusSuspended
	_ = m.writeRoutesFile(p) // drops routes
	for _, ip := range expandToHost32(p.publicIPs) {
		runOK("ip", "route", "del", host32(ip))
	}
	_ = m.rewriteChapSecrets() // removes the auth line
	killSession(p.privateIP)   // disconnect now
	return nil
}

func (m *SSTPManager) ResumePeer(_ context.Context, cn string) error {
	user := sstpUser(cn)
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[user]
	if !ok {
		return ErrNotFound
	}
	p.status = StatusActive
	if err := m.rewriteChapSecrets(); err != nil {
		return err
	}
	return m.writeRoutesFile(p)
}

func (m *SSTPManager) GetPeer(_ context.Context, cn string) (*Peer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[sstpUser(cn)]
	if !ok {
		return nil, ErrNotFound
	}
	return m.peerView(p), nil
}

func (m *SSTPManager) ListPeers(_ context.Context) ([]Peer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Peer, 0, len(m.meta))
	for _, p := range m.meta {
		out = append(out, *m.peerView(p))
	}
	return out, nil
}

func (m *SSTPManager) Stats(_ context.Context) (*GatewayStats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := 0
	for _, p := range m.meta {
		if p.status == StatusActive {
			active++
		}
	}
	return &GatewayStats{CollectedAt: time.Now().UTC(), PeerCount: len(m.meta), ActivePeerCount: active}, nil
}

func (m *SSTPManager) Ready(_ context.Context) (ReadyChecks, bool) {
	checks := ReadyChecks{WireGuard: "n/a", FRR: "unknown", NFTables: "unknown"}
	// SSTP is healthy if sstpd is listening; approximate by chap-secrets writable.
	if f, err := os.OpenFile(m.chapPath, os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		_ = f.Close()
		checks.WireGuard = "up"
		return checks, true
	}
	checks.WireGuard = "down"
	return checks, false
}

func (m *SSTPManager) SetBlackhole(_ context.Context, cidr string, add bool) error {
	return applyBlackhole(cidr, add)
}

// IssueClientCert returns the SSTP credentials (NOT a cert): ClientCert holds the
// username, ClientKey holds the password. The control plane caches these and
// shows them to the customer + embeds them in the Mikrotik .rsc.
func (m *SSTPManager) IssueClientCert(_ context.Context, cn string) (*ClientCert, error) {
	user := sstpUser(cn)
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[user]
	if !ok {
		return nil, ErrNotFound
	}
	return &ClientCert{ClientCert: p.user, ClientKey: p.password}, nil
}

func (m *SSTPManager) peerView(p *sstpPeer) *Peer {
	pk := p.rawKey
	if pk == "" {
		pk = p.user
	}
	return &Peer{
		PeerID:    p.peerID,
		PublicKey: pk, // raw key so drift matches the DB's wg_public_key
		PrivateIP: p.privateIP,
		PublicIPs: p.publicIPs,
		Status:    p.status,
		CreatedAt: p.createdAt,
	}
}
