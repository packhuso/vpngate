package wg

import (
	"context"
	"sync"
	"time"
)

// MemoryManager is an in-memory backend for development and contract tests.
// It has NO kernel side effects — it does not touch WireGuard, netlink, nft
// or FRR. Replace with the kernel backend on the real gateway VM.
type MemoryManager struct {
	iface string
	mu    sync.RWMutex
	peers map[string]*Peer // keyed by publicKey
}

func NewMemoryManager(iface string) *MemoryManager {
	return &MemoryManager{iface: iface, peers: make(map[string]*Peer)}
}

func (m *MemoryManager) Interface() string { return m.iface }

func (m *MemoryManager) ListPeers(_ context.Context) ([]Peer, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Peer, 0, len(m.peers))
	for _, p := range m.peers {
		out = append(out, *p)
	}
	return out, nil
}

func (m *MemoryManager) GetPeer(_ context.Context, pk string) (*Peer, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.peers[pk]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (m *MemoryManager) CreatePeer(_ context.Context, in CreatePeerInput) (*Peer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.peers[in.PublicKey]; ok {
		if existing.PrivateIP != in.PrivateIP {
			return nil, ErrConflict
		}
		cp := *existing
		return &cp, nil // idempotent: same config
	}
	p := &Peer{
		PeerID:       in.PeerID,
		PublicKey:    in.PublicKey,
		PresharedKey: in.PresharedKey,
		PrivateIP:    in.PrivateIP,
		PublicIPs:    in.PublicIPs,
		Status:       StatusActive,
		CreatedAt:    time.Now().UTC(),
	}
	m.peers[in.PublicKey] = p
	cp := *p
	return &cp, nil
}

func (m *MemoryManager) UpdatePeer(_ context.Context, pk string, in UpdatePeerInput) (*Peer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.peers[pk]
	if !ok {
		return nil, ErrNotFound
	}
	p.PublicIPs = in.PublicIPs
	cp := *p
	return &cp, nil
}

func (m *MemoryManager) DeletePeer(_ context.Context, pk string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.peers, pk) // idempotent: deleting a missing peer is fine
	return nil
}

func (m *MemoryManager) SuspendPeer(_ context.Context, pk string) error {
	return m.setStatus(pk, StatusSuspended)
}

func (m *MemoryManager) ResumePeer(_ context.Context, pk string) error {
	return m.setStatus(pk, StatusActive)
}

// SetBlackhole is a no-op in the in-memory backend (no kernel routing table).
func (m *MemoryManager) SetBlackhole(_ context.Context, _ string, _ bool) error {
	return nil
}

// IssueClientCert is unsupported in the in-memory backend (no PKI).
func (m *MemoryManager) IssueClientCert(_ context.Context, _ string) (*ClientCert, error) {
	return nil, ErrNotSupported
}

func (m *MemoryManager) setStatus(pk string, s PeerStatus) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.peers[pk]
	if !ok {
		return ErrNotFound
	}
	p.Status = s
	return nil
}

func (m *MemoryManager) Stats(_ context.Context) (*GatewayStats, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	active := 0
	var rx, tx int64
	for _, p := range m.peers {
		if p.Status == StatusActive {
			active++
		}
		rx += p.BytesRx
		tx += p.BytesTx
	}
	return &GatewayStats{
		CollectedAt:     time.Now().UTC(),
		PeerCount:       len(m.peers),
		ActivePeerCount: active,
		TotalBytesRx:    rx,
		TotalBytesTx:    tx,
	}, nil
}

func (m *MemoryManager) Ready(_ context.Context) (ReadyChecks, bool) {
	// Memory backend is always "ready"; the kernel backend will probe
	// the real wg interface, FRR daemon and nftables ruleset.
	return ReadyChecks{WireGuard: "stub", FRR: "stub", NFTables: "stub"}, true
}
