//go:build linux

// OpenVPN backend — implements the same Manager contract as the WireGuard
// KernelManager so the control plane is protocol-agnostic (design:
// docs/IBGP_MULTISERVER_TODO.md). Data plane:
//   - per-tunnel client-config-dir (CCD) file keyed by Common Name (the
//     "publicKey" slot from the control plane): pins the private IP via
//     ifconfig-push and routes each public IP to the client via `iroute`.
//   - kernel /32 routes on tun0 (so the OS sends the public IP into the tunnel),
//     managed via netlink exactly like the WG backend.
//   - tc HTB shaping + pool blackhole reuse the shared data-plane helpers.
//   - the OpenVPN management interface (status / client-kill) is used to read
//     live byte counters and to force a CCD re-read after a config change.
//
// Note: OpenVPN applies CCD (iroute/ifconfig-push) on (re)connect. After an IP
// change we `client-kill` the CN so the client reconnects and picks up the new
// iroutes — the OpenVPN equivalent of WireGuard's instant allowed-IPs update.
package wg

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ovpnPeer struct {
	peerID    string
	cn        string
	privateIP string
	publicIPs []string
	status    PeerStatus
	createdAt time.Time
	classid   uint16
	speedKbit int
}

type OpenVPNManager struct {
	iface     string // tun0
	ccdDir    string // /etc/openvpn/ccd
	pkiDir    string // /etc/openvpn/pki (ca.crt, ca.key, tc.key — for client-cert issuance)
	mgmtAddr  string // unix:/run/openvpn/mgmt.sock  OR  127.0.0.1:7505
	mu        sync.RWMutex
	meta      map[string]*ovpnPeer // keyed by CN
	certMu    sync.Mutex           // serializes client-cert issuance
	nextClass uint16
	shaping   bool
}

func NewOpenVPNManager(iface, ccdDir, pkiDir, mgmtAddr string) (*OpenVPNManager, error) {
	if iface == "" {
		iface = "tun0"
	}
	if ccdDir == "" {
		ccdDir = "/etc/openvpn/ccd"
	}
	if pkiDir == "" {
		pkiDir = "/etc/openvpn/pki"
	}
	if err := os.MkdirAll(ccdDir, 0o755); err != nil {
		return nil, fmt.Errorf("ccd dir %s: %w", ccdDir, err)
	}
	m := &OpenVPNManager{
		iface: iface, ccdDir: ccdDir, pkiDir: pkiDir, mgmtAddr: mgmtAddr,
		meta: map[string]*ovpnPeer{}, nextClass: 2,
	}
	if err := setupRootShapingOn(iface); err != nil {
		fmt.Printf("[shaping] disabled: %v\n", err)
	} else {
		m.shaping = true
	}
	return m, nil
}

func (m *OpenVPNManager) Interface() string { return m.iface }

// sanitizeCN maps an arbitrary CN (the control plane sends a base64 WG key in
// the publicKey slot) to a filename-safe string. The SAME value is used for the
// CCD filename, the client cert's X.509 CN, and the on-disk cert cache, so
// `ccd-exclusive` matches the connecting client's CN to its CCD file.
func sanitizeCN(cn string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '_'
	}, cn)
}

// ccdPath returns the CCD filename for a CN (sanitized — CN is from a signed
// cert, but defend against path traversal anyway).
func (m *OpenVPNManager) ccdPath(cn string) string {
	return filepath.Join(m.ccdDir, sanitizeCN(cn))
}

// IssueClientCert signs (or reuses) a client cert whose CN matches this peer's
// CCD filename, plus the node CA + tls-crypt key — everything a customer needs
// for an inline .ovpn profile.
func (m *OpenVPNManager) IssueClientCert(_ context.Context, cn string) (*ClientCert, error) {
	if cn == "" {
		return nil, fmt.Errorf("cn required")
	}
	m.certMu.Lock()
	defer m.certMu.Unlock()
	return issueClientCert(m.pkiDir, sanitizeCN(cn))
}

// writeCCD writes ifconfig-push + one iroute per public IP. When suspended,
// iroutes are omitted so OpenVPN won't route any public IP to the client.
func (m *OpenVPNManager) writeCCD(p *ovpnPeer) error {
	var b strings.Builder
	// topology subnet → ifconfig-push <ip> <netmask>
	fmt.Fprintf(&b, "ifconfig-push %s 255.255.255.0\n", p.privateIP)
	if p.status != StatusSuspended {
		for _, ip := range p.publicIPs {
			base := ip
			if i := strings.IndexByte(base, '/'); i >= 0 {
				base = base[:i] // iroute takes addr + mask separately; emit /32s
			}
			fmt.Fprintf(&b, "iroute %s 255.255.255.255\n", base)
		}
	}
	tmp := m.ccdPath(p.cn) + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, m.ccdPath(p.cn))
}

// expandToHost32 turns block CIDRs into individual /32s for kernel routes.
// (The WG side groups blocks into one CIDR route; OpenVPN iroute is per-host,
// so we keep kernel routes per-/32 too for a 1:1 match.)
func expandToHost32(cidrs []string) []string {
	out := make([]string, 0, len(cidrs))
	for _, c := range cidrs {
		if !strings.Contains(c, "/") || strings.HasSuffix(c, "/32") {
			out = append(out, strings.TrimSuffix(c, "/32"))
			continue
		}
		// expand a small block (e.g. /30) into hosts
		n, err := parseCIDR(c)
		if err != nil {
			out = append(out, c)
			continue
		}
		ones, bits := n.Mask.Size()
		count := 1 << uint(bits-ones)
		if count > 256 { // safety: don't explode huge blocks
			out = append(out, c)
			continue
		}
		ip4 := n.IP.To4()
		if ip4 == nil {
			out = append(out, c)
			continue
		}
		start := uint32(ip4[0])<<24 | uint32(ip4[1])<<16 | uint32(ip4[2])<<8 | uint32(ip4[3])
		for i := 0; i < count; i++ {
			v := start + uint32(i)
			out = append(out, fmt.Sprintf("%d.%d.%d.%d", byte(v>>24), byte(v>>16), byte(v>>8), byte(v)))
		}
	}
	return out
}

func (m *OpenVPNManager) CreatePeer(_ context.Context, in CreatePeerInput) (*Peer, error) {
	cn := in.PublicKey // the control plane sends the client CN in the publicKey slot
	if cn == "" || in.PrivateIP == "" {
		return nil, fmt.Errorf("publicKey (CN) and privateIp required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if ex, ok := m.meta[cn]; ok && ex.privateIP != in.PrivateIP {
		return nil, ErrConflict
	}
	p := &ovpnPeer{
		peerID: in.PeerID, cn: cn, privateIP: in.PrivateIP,
		publicIPs: in.PublicIPs, status: StatusActive,
		createdAt: time.Now().UTC(), speedKbit: in.SpeedLimitKbit,
	}
	if err := m.writeCCD(p); err != nil {
		return nil, fmt.Errorf("write ccd: %w", err)
	}
	// Do NOT install a kernel route — OpenVPN installs the correct per-client
	// route (<ip> via <client-vaddr>) from the CCD iroute on connect. A
	// scope-link route (<ip> dev tun0, no next-hop) has metric 0 → it SHADOWS
	// OpenVPN's route, and with DCO has no peer association so data is dropped
	// (verified). Actively REMOVE any such stale route a prior agent build left.
	_ = routeOnIface(m.iface, false, expandToHost32(in.PublicIPs))
	m.meta[cn] = p
	if m.shaping && in.SpeedLimitKbit > 0 {
		p.classid = m.allocOvpnClass(p)
		addShapingOn(m.iface, p.classid, in.SpeedLimitKbit, in.PrivateIP, expandToHost32(in.PublicIPs))
	}
	return m.peerView(p), nil
}

func (m *OpenVPNManager) UpdatePeer(_ context.Context, cn string, in UpdatePeerInput) (*Peer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[cn]
	if !ok {
		// post-restart recovery: rebuild meta from the update
		p = &ovpnPeer{cn: cn, status: StatusActive, createdAt: time.Now().UTC()}
		m.meta[cn] = p
	}
	p.privateIP = in.PrivateIP
	p.publicIPs = in.PublicIPs
	if in.SpeedLimitKbit > 0 {
		p.speedKbit = in.SpeedLimitKbit
	}
	if err := m.writeCCD(p); err != nil {
		return nil, fmt.Errorf("write ccd: %w", err)
	}
	newIPs := expandToHost32(in.PublicIPs)
	// Remove any stale scope-link routes for these IPs (see CreatePeer); OpenVPN
	// reinstalls the correct per-client routes on the killClient reconnect below.
	_ = routeOnIface(m.iface, false, newIPs)
	// rebuild shaping for the new IP set
	if m.shaping && p.speedKbit > 0 {
		p.classid = m.allocOvpnClass(p)
		removeShapingOn(m.iface, p.classid)
		addShapingOn(m.iface, p.classid, p.speedKbit, p.privateIP, newIPs)
	}
	// force the client to reconnect so OpenVPN re-reads the CCD iroutes
	m.killClient(cn)
	return m.peerView(p), nil
}

func (m *OpenVPNManager) DeletePeer(_ context.Context, cn string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[cn]
	if !ok {
		_ = os.Remove(m.ccdPath(cn))
		return nil
	}
	removeShapingOn(m.iface, p.classid)
	_ = os.Remove(m.ccdPath(cn))
	m.killClient(cn) // reconnect with no CCD → OpenVPN drops its per-client routes
	delete(m.meta, cn)
	return nil
}

func (m *OpenVPNManager) SuspendPeer(_ context.Context, cn string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[cn]
	if !ok {
		return ErrNotFound
	}
	p.status = StatusSuspended
	_ = m.writeCCD(p)  // drops iroutes
	m.killClient(cn)   // reconnect → OpenVPN drops the per-client routes
	return nil
}

func (m *OpenVPNManager) ResumePeer(_ context.Context, cn string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.meta[cn]
	if !ok {
		return ErrNotFound
	}
	p.status = StatusActive
	_ = m.writeCCD(p)  // restores iroutes
	m.killClient(cn)   // reconnect → OpenVPN re-installs the per-client routes
	return nil
}

func (m *OpenVPNManager) GetPeer(_ context.Context, cn string) (*Peer, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.meta[cn]
	if !ok {
		return nil, ErrNotFound
	}
	return m.peerView(p), nil
}

func (m *OpenVPNManager) ListPeers(_ context.Context) ([]Peer, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Peer, 0, len(m.meta))
	stats := m.statusBytes() // CN → {rx,tx}; best-effort
	for _, p := range m.meta {
		v := m.peerView(p)
		// status reports the sanitized X.509 CN; meta keys by the raw CN.
		if s, ok := stats[sanitizeCN(p.cn)]; ok {
			v.BytesRx, v.BytesTx = s[0], s[1]
		}
		out = append(out, *v)
	}
	return out, nil
}

func (m *OpenVPNManager) Stats(_ context.Context) (*GatewayStats, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	active := 0
	for _, p := range m.meta {
		if p.status == StatusActive {
			active++
		}
	}
	return &GatewayStats{
		CollectedAt:     time.Now().UTC(),
		PeerCount:       len(m.meta),
		ActivePeerCount: active,
	}, nil
}

func (m *OpenVPNManager) Ready(_ context.Context) (ReadyChecks, bool) {
	checks := ReadyChecks{WireGuard: "n/a", FRR: "unknown", NFTables: "unknown"}
	ok := true
	if _, err := net.InterfaceByName(m.iface); err != nil {
		checks.WireGuard = "down"
		ok = false
	} else {
		checks.WireGuard = "up" // (interface field reused for the data-plane device)
	}
	return checks, ok
}

func (m *OpenVPNManager) SetBlackhole(_ context.Context, cidr string, add bool) error {
	return applyBlackhole(cidr, add)
}

// ── helpers ────────────────────────────────────────────────────────────────

func (m *OpenVPNManager) peerView(p *ovpnPeer) *Peer {
	return &Peer{
		PeerID:    p.peerID,
		PublicKey: p.cn,
		PrivateIP: p.privateIP,
		PublicIPs: p.publicIPs,
		Status:    p.status,
		CreatedAt: p.createdAt,
	}
}

// allocOvpnClass — caller holds m.mu.
func (m *OpenVPNManager) allocOvpnClass(p *ovpnPeer) uint16 {
	if p.classid != 0 {
		return p.classid
	}
	if m.nextClass < 2 {
		m.nextClass = 2
	}
	p.classid = m.nextClass
	m.nextClass++
	return p.classid
}

// mgmtCmd dials the OpenVPN management interface, sends one command, returns the
// raw response. Best-effort: errors are non-fatal (returns "").
func (m *OpenVPNManager) mgmtCmd(cmd string) string {
	if m.mgmtAddr == "" {
		return ""
	}
	network, addr := "tcp", m.mgmtAddr
	if strings.HasPrefix(m.mgmtAddr, "unix:") {
		network, addr = "unix", strings.TrimPrefix(m.mgmtAddr, "unix:")
	}
	conn, err := net.DialTimeout(network, addr, 2*time.Second)
	if err != nil {
		return ""
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "%s\n", cmd)
	var sb strings.Builder
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		line := sc.Text()
		sb.WriteString(line)
		sb.WriteByte('\n')
		if strings.HasPrefix(line, "END") || strings.HasPrefix(line, "SUCCESS") || strings.HasPrefix(line, "ERROR") {
			break
		}
	}
	return sb.String()
}

// killClient forces a CN to reconnect (so it re-reads its CCD iroutes after an
// IP change). We use `client-kill <CID>` (which sends the client an explicit
// RESTART control message → it reconnects within seconds) instead of
// `kill <cn>` (which just drops the session, leaving the client to notice only
// via its ping-restart timer — up to 60-120s of dead tunnel). Falls back to
// `kill <cn>` if the management status has no CID for this CN.
func (m *OpenVPNManager) killClient(cn string) {
	// OpenVPN knows the client by its X.509 CN, which is the SANITIZED form (the
	// cert/CCD use sanitizeCN). The control plane passes the raw base64 key, so
	// sanitize before talking to the management interface — otherwise no match
	// and the client is never restarted (it keeps the stale CCD routing).
	scn := sanitizeCN(cn)
	cids := m.clientIDs(scn)
	if len(cids) == 0 {
		_ = m.mgmtCmd("kill " + scn)
		return
	}
	for _, cid := range cids {
		// default kill message is RESTART → prompt client-side reconnect
		_ = m.mgmtCmd("client-kill " + cid)
	}
}

// clientIDs returns the management Client IDs of all live sessions for a CN
// (already sanitized). status 3 is tab-separated:
// CLIENT_LIST \t CN \t ... \t ClientID[10] \t ...
func (m *OpenVPNManager) clientIDs(cn string) []string {
	resp := m.mgmtCmd("status 3")
	if resp == "" {
		return nil
	}
	var out []string
	for _, line := range strings.Split(resp, "\n") {
		f := strings.Split(line, "\t")
		if len(f) >= 11 && f[0] == "CLIENT_LIST" && f[1] == cn {
			if id := strings.TrimSpace(f[10]); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
}

// statusBytes parses `status 3` (tab-separated) → CN → [rx, tx].
func (m *OpenVPNManager) statusBytes() map[string][2]int64 {
	out := map[string][2]int64{}
	resp := m.mgmtCmd("status 3")
	if resp == "" {
		return out
	}
	for _, line := range strings.Split(resp, "\n") {
		f := strings.Split(line, "\t")
		// CLIENT_LIST \t CN \t realaddr \t virtaddr \t virtaddr6 \t bytesRx \t bytesTx ...
		if len(f) >= 7 && f[0] == "CLIENT_LIST" {
			var rx, tx int64
			fmt.Sscan(f[5], &rx)
			fmt.Sscan(f[6], &tx)
			out[f[1]] = [2]int64{rx, tx}
		}
	}
	return out
}
