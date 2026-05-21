// Package wg defines the WireGuard control contract used by the agent.
//
// The real backend (added on the gateway VM) will drive the kernel via
// wgctrl-go + netlink, and let FRR announce /32 routes over OSPF/BGP
// (design Section 3.2 / 7.1). This package keeps that behind an interface
// so the HTTP layer is testable without a WireGuard kernel module.
package wg

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound     = errors.New("peer not found")
	ErrConflict     = errors.New("peer exists with different config")
	ErrNotSupported = errors.New("operation not supported by this backend")
)

// ClientCert is the material a customer needs to assemble an inline .ovpn
// profile. Only the OpenVPN backend issues these; other backends return
// ErrNotSupported. The CA cert and tls-crypt key are node-wide; the client
// cert/key are unique per CN (one tunnel).
type ClientCert struct {
	CACert      string `json:"caCert"`      // node CA cert (PEM)
	ClientCert  string `json:"clientCert"`  // signed client cert (PEM)
	ClientKey   string `json:"clientKey"`   // client private key (PEM)
	TLSCryptKey string `json:"tlsCryptKey"` // shared tls-crypt static key
}

type PeerStatus string

const (
	StatusActive    PeerStatus = "active"
	StatusSuspended PeerStatus = "suspended"
)

// Peer mirrors components.schemas.Peer in docs/vpnhub-agent.yaml.
type Peer struct {
	PeerID        string     `json:"peerId"`
	PublicKey     string     `json:"publicKey"`
	PresharedKey  string     `json:"-"`
	PrivateIP     string     `json:"privateIp"`
	PublicIPs     []string   `json:"publicIps"`
	BytesRx       int64      `json:"bytesRx"`
	BytesTx       int64      `json:"bytesTx"`
	LastHandshake *time.Time `json:"lastHandshake"`
	LastEndpoint  *string    `json:"lastEndpoint"`
	Status        PeerStatus `json:"status"`
	CreatedAt     time.Time  `json:"createdAt"`
}

type CreatePeerInput struct {
	PeerID         string
	PublicKey      string
	PresharedKey   string
	PrivateIP      string
	PublicIPs      []string
	SpeedLimitKbit int // 0 = unshaped
}

type UpdatePeerInput struct {
	PrivateIP      string
	PublicIPs      []string
	SpeedLimitKbit int // 0 = leave/unshaped
}

type GatewayStats struct {
	CollectedAt     time.Time `json:"collectedAt"`
	PeerCount       int       `json:"peerCount"`
	ActivePeerCount int       `json:"activePeerCount"`
	TotalBytesRx    int64     `json:"totalBytesRx"`
	TotalBytesTx    int64     `json:"totalBytesTx"`
	CPUUsagePercent float64   `json:"cpuUsagePercent"`
	MemoryUsageMb   int       `json:"memoryUsageMb"`
	SystemLoad      float64   `json:"systemLoad"`
}

type ReadyChecks struct {
	WireGuard string `json:"wireguard"`
	FRR       string `json:"frr"`
	NFTables  string `json:"nftables"`
}

// Manager is the gateway control contract. Implementations:
//   - MemoryManager (this package): dev/test, no kernel side effects.
//   - kernel backend (TODO, gateway VM): wgctrl + netlink + nft + FRR.
type Manager interface {
	Interface() string
	ListPeers(ctx context.Context) ([]Peer, error)
	GetPeer(ctx context.Context, publicKey string) (*Peer, error)
	CreatePeer(ctx context.Context, in CreatePeerInput) (*Peer, error)
	UpdatePeer(ctx context.Context, publicKey string, in UpdatePeerInput) (*Peer, error)
	DeletePeer(ctx context.Context, publicKey string) error
	SuspendPeer(ctx context.Context, publicKey string) error
	ResumePeer(ctx context.Context, publicKey string) error
	Stats(ctx context.Context) (*GatewayStats, error)
	Ready(ctx context.Context) (ReadyChecks, bool)
	// SetBlackhole installs (add=true) or removes (add=false) a blackhole
	// route for an entire pool CIDR — drops traffic to unallocated IPs.
	SetBlackhole(ctx context.Context, cidr string, add bool) error
	// IssueClientCert signs (or reuses) a client cert for the given CN and
	// returns the material needed to build a .ovpn profile. WireGuard/memory
	// backends return ErrNotSupported.
	IssueClientCert(ctx context.Context, cn string) (*ClientCert, error)
}
