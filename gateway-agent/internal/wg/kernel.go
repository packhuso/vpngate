//go:build linux

// Kernel backend: drives the real WireGuard device via wgctrl and installs
// /32 routes for public IPs via netlink, so FRR can redistribute/announce
// them (design Section 3.2 / 7.1). Pure-Go deps → builds static, no CGO.
package wg

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// meta holds what the WireGuard device itself does not store (our tunnel id,
// the private vs public IP split, suspend state). In-memory; the control
// plane's drift-detection job reconciles after an agent restart (design 7.1).
type meta struct {
	peerID    string
	privateIP string
	publicIPs []string
	status    PeerStatus
	createdAt time.Time
	classid   uint16 // tc HTB minor class id (0 = unshaped)
	speedKbit int    // current shaping rate (0 = unshaped)
}

type KernelManager struct {
	iface     string
	client    *wgctrl.Client
	mu        sync.RWMutex
	meta      map[string]*meta // keyed by publicKey
	nextClass uint16           // next tc classid to hand out (starts at 2)
	shaping   bool             // true once setupRootShaping succeeded
}

func NewKernelManager(iface string) (*KernelManager, error) {
	c, err := wgctrl.New()
	if err != nil {
		return nil, fmt.Errorf("wgctrl init: %w", err)
	}
	if _, err := c.Device(iface); err != nil {
		c.Close()
		return nil, fmt.Errorf("wireguard device %q not found: %w", iface, err)
	}
	k := &KernelManager{
		iface: iface, client: c, meta: map[string]*meta{}, nextClass: 2,
	}
	// Best-effort: configure HTB root + ifb ingress mirror once at startup.
	// If tc/ifb is unavailable the agent still runs (shaping just disabled).
	if err := k.setupRootShaping(); err != nil {
		fmt.Printf("[shaping] disabled: %v\n", err)
	} else {
		k.shaping = true
	}
	return k, nil
}

func (k *KernelManager) Interface() string { return k.iface }

// parseCIDR accepts either a bare IP ("1.2.3.4" → /32) or a CIDR
// ("1.2.3.0/30"). Back-compat with older callers that send /32 only.
func parseCIDR(s string) (net.IPNet, error) {
	if !strings.Contains(s, "/") {
		p := net.ParseIP(s)
		if p == nil {
			return net.IPNet{}, fmt.Errorf("invalid IP %q", s)
		}
		if v4 := p.To4(); v4 != nil {
			return net.IPNet{IP: v4, Mask: net.CIDRMask(32, 32)}, nil
		}
		return net.IPNet{IP: p, Mask: net.CIDRMask(128, 128)}, nil
	}
	ip, n, err := net.ParseCIDR(s)
	if err != nil {
		return net.IPNet{}, fmt.Errorf("invalid CIDR %q: %w", s, err)
	}
	if v4 := ip.To4(); v4 != nil {
		return net.IPNet{IP: n.IP.To4(), Mask: n.Mask}, nil
	}
	return net.IPNet{IP: n.IP, Mask: n.Mask}, nil
}

func (k *KernelManager) allowed(privateIP string, publicIPs []string) ([]net.IPNet, error) {
	out := make([]net.IPNet, 0, len(publicIPs)+1)
	pn, err := parseCIDR(privateIP)
	if err != nil {
		return nil, err
	}
	out = append(out, pn)
	for _, ip := range publicIPs {
		n, err := parseCIDR(ip)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

// route installs/removes a LINK-scoped /N on wg0 for each public CIDR (single
// /32 or grouped block prefix e.g. /30, /29). The private IP is already covered
// by the wg0 interface subnet.
func (k *KernelManager) route(add bool, publicIPs []string) error {
	link, err := netlink.LinkByName(k.iface)
	if err != nil {
		return fmt.Errorf("link %s: %w", k.iface, err)
	}
	for _, ip := range publicIPs {
		n, err := parseCIDR(ip)
		if err != nil {
			return err
		}
		nn := n
		r := &netlink.Route{LinkIndex: link.Attrs().Index, Dst: &nn, Scope: netlink.SCOPE_LINK}
		if add {
			if err := netlink.RouteReplace(r); err != nil {
				return fmt.Errorf("route add %s: %w", ip, err)
			}
		} else if err := netlink.RouteDel(r); err != nil &&
			!isNoSuchProcess(err) {
			return fmt.Errorf("route del %s: %w", ip, err)
		}
	}
	return nil
}

func isNoSuchProcess(err error) bool {
	return err != nil && err.Error() == "no such process"
}

func (k *KernelManager) configurePeer(pc wgtypes.PeerConfig) error {
	return k.client.ConfigureDevice(k.iface, wgtypes.Config{Peers: []wgtypes.PeerConfig{pc}})
}

func (k *KernelManager) CreatePeer(_ context.Context, in CreatePeerInput) (*Peer, error) {
	pub, err := wgtypes.ParseKey(in.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("invalid publicKey: %w", err)
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if m, ok := k.meta[in.PublicKey]; ok && m.privateIP != in.PrivateIP {
		return nil, ErrConflict
	}
	aips, err := k.allowed(in.PrivateIP, in.PublicIPs)
	if err != nil {
		return nil, err
	}
	pc := wgtypes.PeerConfig{
		PublicKey:         pub,
		ReplaceAllowedIPs: true,
		AllowedIPs:        aips,
	}
	if in.PresharedKey != "" {
		psk, err := wgtypes.ParseKey(in.PresharedKey)
		if err != nil {
			return nil, fmt.Errorf("invalid presharedKey: %w", err)
		}
		pc.PresharedKey = &psk
	}
	if err := k.configurePeer(pc); err != nil {
		return nil, fmt.Errorf("configure peer: %w", err)
	}
	if err := k.route(true, in.PublicIPs); err != nil {
		return nil, err
	}
	m := &meta{
		peerID: in.PeerID, privateIP: in.PrivateIP, publicIPs: in.PublicIPs,
		status: StatusActive, createdAt: time.Now().UTC(),
		speedKbit: in.SpeedLimitKbit,
	}
	k.meta[in.PublicKey] = m
	// Apply bandwidth shaping after the device + routes are in place so there's
	// no window where allowed-IPs exist but filters don't (= unshaped traffic).
	if in.SpeedLimitKbit > 0 {
		cid := k.allocClass(m)
		k.addPeerShaping(cid, in.SpeedLimitKbit, in.PrivateIP, in.PublicIPs)
	}
	return k.peerFromDevice(in.PublicKey)
}

func (k *KernelManager) UpdatePeer(_ context.Context, publicKey string, in UpdatePeerInput) (*Peer, error) {
	pub, err := wgtypes.ParseKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("invalid publicKey: %w", err)
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	m, ok := k.meta[publicKey]
	if !ok {
		// Post-restart recovery: meta is in-memory and gets wiped on agent
		// restart, but the kernel may still hold the peer. Auto-create meta
		// so the control plane can drive updates without a separate
		// re-registration step (drift detection relies on this).
		m = &meta{status: StatusActive, createdAt: time.Now().UTC()}
		k.meta[publicKey] = m
	}
	aips, err := k.allowed(in.PrivateIP, in.PublicIPs)
	if err != nil {
		return nil, err
	}
	if err := k.configurePeer(wgtypes.PeerConfig{
		PublicKey: pub, ReplaceAllowedIPs: true, AllowedIPs: aips,
	}); err != nil {
		return nil, err
	}
	// reconcile routes: drop removed, add current
	removed := diff(m.publicIPs, in.PublicIPs)
	if err := k.route(false, removed); err != nil {
		return nil, err
	}
	if err := k.route(true, in.PublicIPs); err != nil {
		return nil, err
	}
	m.privateIP, m.publicIPs = in.PrivateIP, in.PublicIPs
	// Rate: keep existing if caller passes 0, else update.
	if in.SpeedLimitKbit > 0 {
		m.speedKbit = in.SpeedLimitKbit
	}
	// Rebuild shaping filters for the new IP set (and rate). No-op if unshaped.
	if m.speedKbit > 0 {
		cid := k.allocClass(m)
		k.updatePeerShaping(cid, m.speedKbit, in.PrivateIP, in.PublicIPs)
	}
	return k.peerFromDevice(publicKey)
}

func (k *KernelManager) DeletePeer(_ context.Context, publicKey string) error {
	pub, err := wgtypes.ParseKey(publicKey)
	if err != nil {
		return nil // invalid key → treat as already absent (idempotent)
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.configurePeer(wgtypes.PeerConfig{PublicKey: pub, Remove: true}); err != nil {
		return fmt.Errorf("remove peer: %w", err)
	}
	if m, ok := k.meta[publicKey]; ok {
		_ = k.route(false, m.publicIPs)
		k.removePeerShaping(m.classid)
		delete(k.meta, publicKey)
	}
	return nil
}

// SetBlackhole installs/removes a blackhole route for an entire pool CIDR.
// More-specific /32 peer routes (scope link) still win, so allocated IPs work;
// only unallocated IPs in the pool get dropped (no upstream↔gateway loop).
func (k *KernelManager) SetBlackhole(_ context.Context, cidr string, add bool) error {
	n, err := parseCIDR(cidr)
	if err != nil {
		return fmt.Errorf("invalid cidr %q: %w", cidr, err)
	}
	nn := n
	r := &netlink.Route{Dst: &nn, Type: unix.RTN_BLACKHOLE}
	if add {
		if err := netlink.RouteReplace(r); err != nil {
			return fmt.Errorf("blackhole add %s: %w", cidr, err)
		}
		return nil
	}
	if err := netlink.RouteDel(r); err != nil && !isNoSuchProcess(err) {
		return fmt.Errorf("blackhole del %s: %w", cidr, err)
	}
	return nil
}

// IssueClientCert — WireGuard nodes have no OpenVPN PKI.
func (k *KernelManager) IssueClientCert(_ context.Context, _ string) (*ClientCert, error) {
	return nil, ErrNotSupported
}

func (k *KernelManager) SuspendPeer(_ context.Context, publicKey string) error {
	pub, err := wgtypes.ParseKey(publicKey)
	if err != nil {
		return ErrNotFound
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	m, ok := k.meta[publicKey]
	if !ok {
		return ErrNotFound
	}
	// Drop all allowed-ips + routes → traffic blocked, peer record kept.
	if err := k.configurePeer(wgtypes.PeerConfig{
		PublicKey: pub, ReplaceAllowedIPs: true, AllowedIPs: []net.IPNet{},
	}); err != nil {
		return err
	}
	_ = k.route(false, m.publicIPs)
	m.status = StatusSuspended
	return nil
}

func (k *KernelManager) ResumePeer(_ context.Context, publicKey string) error {
	pub, err := wgtypes.ParseKey(publicKey)
	if err != nil {
		return ErrNotFound
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	m, ok := k.meta[publicKey]
	if !ok {
		return ErrNotFound
	}
	aips, err := k.allowed(m.privateIP, m.publicIPs)
	if err != nil {
		return err
	}
	if err := k.configurePeer(wgtypes.PeerConfig{
		PublicKey: pub, ReplaceAllowedIPs: true, AllowedIPs: aips,
	}); err != nil {
		return err
	}
	if err := k.route(true, m.publicIPs); err != nil {
		return err
	}
	m.status = StatusActive
	return nil
}

func (k *KernelManager) GetPeer(_ context.Context, publicKey string) (*Peer, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.peerFromDevice(publicKey)
}

func (k *KernelManager) ListPeers(_ context.Context) ([]Peer, error) {
	dev, err := k.client.Device(k.iface)
	if err != nil {
		return nil, err
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	out := make([]Peer, 0, len(dev.Peers))
	for i := range dev.Peers {
		out = append(out, k.mapPeer(&dev.Peers[i]))
	}
	return out, nil
}

// peerFromDevice must be called with the lock held.
func (k *KernelManager) peerFromDevice(publicKey string) (*Peer, error) {
	dev, err := k.client.Device(k.iface)
	if err != nil {
		return nil, err
	}
	for i := range dev.Peers {
		if dev.Peers[i].PublicKey.String() == publicKey {
			p := k.mapPeer(&dev.Peers[i])
			return &p, nil
		}
	}
	return nil, ErrNotFound
}

func (k *KernelManager) mapPeer(p *wgtypes.Peer) Peer {
	pk := p.PublicKey.String()
	out := Peer{
		PublicKey: pk,
		BytesRx:   p.ReceiveBytes,
		BytesTx:   p.TransmitBytes,
		Status:    StatusActive,
	}
	if m, ok := k.meta[pk]; ok {
		out.PeerID, out.PrivateIP, out.PublicIPs = m.peerID, m.privateIP, m.publicIPs
		out.Status, out.CreatedAt = m.status, m.createdAt
	}
	if !p.LastHandshakeTime.IsZero() {
		t := p.LastHandshakeTime.UTC()
		out.LastHandshake = &t
	}
	if p.Endpoint != nil {
		e := p.Endpoint.String()
		out.LastEndpoint = &e
	}
	return out
}

func (k *KernelManager) Stats(_ context.Context) (*GatewayStats, error) {
	dev, err := k.client.Device(k.iface)
	if err != nil {
		return nil, err
	}
	var rx, tx int64
	active := 0
	cutoff := time.Now().Add(-3 * time.Minute)
	for i := range dev.Peers {
		p := &dev.Peers[i]
		rx += p.ReceiveBytes
		tx += p.TransmitBytes
		if !p.LastHandshakeTime.IsZero() && p.LastHandshakeTime.After(cutoff) {
			active++
		}
	}
	return &GatewayStats{
		CollectedAt:  time.Now().UTC(),
		PeerCount:    len(dev.Peers),
		ActivePeerCount: active,
		TotalBytesRx: rx,
		TotalBytesTx: tx,
	}, nil
}

func (k *KernelManager) Ready(_ context.Context) (ReadyChecks, bool) {
	c := ReadyChecks{WireGuard: "ok", FRR: "ok", NFTables: "ok"}
	ok := true
	if _, err := k.client.Device(k.iface); err != nil {
		c.WireGuard, ok = "down", false
	}
	if !serviceActive("frr") {
		c.FRR = "inactive" // non-fatal on a LAN test gateway w/o BGP upstream
	}
	if exec.Command("nft", "list", "ruleset").Run() != nil {
		c.NFTables = "unavailable"
	}
	return c, ok
}

func serviceActive(name string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", name).Run() == nil
}

func diff(old, cur []string) (removed []string) {
	keep := make(map[string]struct{}, len(cur))
	for _, c := range cur {
		keep[c] = struct{}{}
	}
	for _, o := range old {
		if _, ok := keep[o]; !ok {
			removed = append(removed, o)
		}
	}
	return removed
}
