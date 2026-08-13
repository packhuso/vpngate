// Plain GRE (RFC 2784) tunnel management. Each customer gets one interface
// named `gre-<peerId>` — the peerId is a short hex string picked by the
// control plane. Linux enforces source-IP by refusing to decap packets whose
// outer src doesn't match the peer's `remote`, so `ip tunnel change remote
// <new>` on DNS re-resolve is enough auth for dynamic-ISP customers.
//
// The GRE key (32-bit RFC 2890) namespaces two peers behind the same NAT.
//
// State lives in the kernel (`ip -j link show type gre`), not in memory —
// so a restart of the agent doesn't lose visibility, and a manual `ip tunnel`
// change from an operator surfaces on the next GET.
package server

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

const greIfPrefix = "gre-"

var peerIdRe = regexp.MustCompile(`^[a-zA-Z0-9]{4,32}$`)

type greCreateReq struct {
	PeerId         string   `json:"peerId"`         // becomes gre-<peerId>; must match peerIdRe
	RemoteIp       string   `json:"remoteIp"`       // customer's public IP (resolved from domain by control plane)
	LocalIp        string   `json:"localIp"`        // this gateway's public IP; must equal the underlay bind
	GreKey         uint32   `json:"greKey"`         // 32-bit; 0 = no key (accepted but not recommended)
	TunnelLocalIp  string   `json:"tunnelLocalIp"`  // e.g. 10.100.0.1/30 — our end of the point-to-point
	TunnelRemoteIp string   `json:"tunnelRemoteIp"` // customer's end (peer address for routes into their LAN)
	PublicIps      []string `json:"publicIps"`      // /32 or /Nn routes to install pointing at this tunnel
	Mtu            int      `json:"mtu"`            // 0 → default 1476
}

type grePatchReq struct {
	RemoteIp  *string   `json:"remoteIp,omitempty"`  // for DNS re-resolve
	PublicIps *[]string `json:"publicIps,omitempty"` // full replacement — diff + add/remove routes
}

type grePeer struct {
	PeerId         string   `json:"peerId"`
	Interface      string   `json:"interface"`
	RemoteIp       string   `json:"remoteIp"`
	LocalIp        string   `json:"localIp"`
	GreKey         uint32   `json:"greKey"`
	TunnelLocalIp  string   `json:"tunnelLocalIp"`
	TunnelRemoteIp string   `json:"tunnelRemoteIp"`
	PublicIps      []string `json:"publicIps"`
	Mtu            int      `json:"mtu"`
	OperState      string   `json:"operState"` // UP / DOWN / UNKNOWN
	BytesRx        int64    `json:"bytesRx"`
	BytesTx        int64    `json:"bytesTx"`
}

// ── HTTP handlers ─────────────────────────────────────────────

func (s *Server) handleCreateGrePeer(w http.ResponseWriter, r *http.Request) {
	var req greCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "json decode failed")
		return
	}
	if !peerIdRe.MatchString(req.PeerId) {
		writeErr(w, http.StatusBadRequest, "BAD_PEER_ID", "peerId must be 4-32 alnum")
		return
	}
	if net.ParseIP(req.RemoteIp) == nil {
		writeErr(w, http.StatusBadRequest, "BAD_REMOTE", "remoteIp not an IP")
		return
	}
	if req.LocalIp != "" && net.ParseIP(req.LocalIp) == nil {
		writeErr(w, http.StatusBadRequest, "BAD_LOCAL", "localIp not an IP")
		return
	}
	if _, _, err := net.ParseCIDR(req.TunnelLocalIp); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_TLOCAL", "tunnelLocalIp must be CIDR (e.g. 10.100.0.1/30)")
		return
	}
	for _, p := range req.PublicIps {
		if _, _, err := net.ParseCIDR(p); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_PUBLIC_IP", "publicIps["+p+"] invalid CIDR")
			return
		}
	}

	ifname := greIfPrefix + req.PeerId
	if req.Mtu == 0 {
		req.Mtu = 1476 // 1500 - 20 (outer IP) - 4 (GRE base header)
	}

	// If already exists (idempotent-ish behaviour: re-create is disallowed —
	// callers should PATCH). The control plane uses idempotency keys upstream.
	if linkExists(ifname) {
		writeErr(w, http.StatusConflict, "EXISTS", "interface "+ifname+" already exists")
		return
	}

	// ip link add gre-<id> type gre remote <r> local <l> key <k> ttl inherit
	args := []string{"link", "add", ifname, "type", "gre",
		"remote", req.RemoteIp,
		"ttl", "inherit"}
	if req.LocalIp != "" {
		args = append(args, "local", req.LocalIp)
	}
	if req.GreKey != 0 {
		args = append(args, "key", strconv.FormatUint(uint64(req.GreKey), 10))
	}
	if out, err := runIp(args...); err != nil {
		writeErr(w, http.StatusInternalServerError, "IP_ADD", "ip link add: "+err.Error()+": "+out)
		return
	}
	// Rollback on any subsequent failure so we never leave a half-built tunnel.
	success := false
	defer func() {
		if !success {
			_, _ = runIp("link", "del", ifname)
		}
	}()

	if out, err := runIp("link", "set", ifname, "mtu", strconv.Itoa(req.Mtu), "up"); err != nil {
		writeErr(w, http.StatusInternalServerError, "IP_UP", "ip link set up: "+err.Error()+": "+out)
		return
	}
	if out, err := runIp("addr", "add", req.TunnelLocalIp, "dev", ifname); err != nil {
		writeErr(w, http.StatusInternalServerError, "ADDR_ADD", "ip addr add: "+err.Error()+": "+out)
		return
	}
	for _, p := range req.PublicIps {
		// proto static distinguishes routes we own from the kernel's connected
		// route (proto kernel) for the tunnel-local /30 — listRoutesOnDev
		// filters on this so PATCH diffs work correctly.
		if out, err := runIp("route", "add", p, "dev", ifname, "proto", "static"); err != nil {
			writeErr(w, http.StatusInternalServerError, "ROUTE_ADD", "ip route add "+p+": "+err.Error()+": "+out)
			return
		}
	}

	success = true
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "created",
		"peerId":    req.PeerId,
		"interface": ifname,
	})
}

func (s *Server) handleListGrePeers(w http.ResponseWriter, r *http.Request) {
	peers, err := listGrePeers()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "LIST_FAIL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"peers": peers})
}

func (s *Server) handleGetGrePeer(w http.ResponseWriter, r *http.Request) {
	peerId := r.PathValue("peerId")
	if !peerIdRe.MatchString(peerId) {
		writeErr(w, http.StatusBadRequest, "BAD_PEER_ID", "invalid peerId")
		return
	}
	p, err := getGrePeer(peerId)
	if err != nil {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handlePatchGrePeer(w http.ResponseWriter, r *http.Request) {
	peerId := r.PathValue("peerId")
	if !peerIdRe.MatchString(peerId) {
		writeErr(w, http.StatusBadRequest, "BAD_PEER_ID", "invalid peerId")
		return
	}
	ifname := greIfPrefix + peerId
	if !linkExists(ifname) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", ifname+" does not exist")
		return
	}
	var req grePatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", err.Error())
		return
	}

	if req.RemoteIp != nil {
		if net.ParseIP(*req.RemoteIp) == nil {
			writeErr(w, http.StatusBadRequest, "BAD_REMOTE", "remoteIp not an IP")
			return
		}
		// ip tunnel change gre-<id> mode gre remote <new>
		if out, err := runIp("tunnel", "change", ifname, "mode", "gre", "remote", *req.RemoteIp); err != nil {
			writeErr(w, http.StatusInternalServerError, "IP_CHANGE", "ip tunnel change: "+err.Error()+": "+out)
			return
		}
	}

	if req.PublicIps != nil {
		cur, err := listRoutesOnDev(ifname)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "ROUTE_LIST", err.Error())
			return
		}
		desired := make(map[string]bool, len(*req.PublicIps))
		for _, p := range *req.PublicIps {
			if _, _, e := net.ParseCIDR(p); e != nil {
				writeErr(w, http.StatusBadRequest, "BAD_PUBLIC_IP", p)
				return
			}
			desired[p] = true
		}
		curSet := make(map[string]bool, len(cur))
		for _, p := range cur {
			curSet[p] = true
		}
		for p := range desired {
			if !curSet[p] {
				if out, err := runIp("route", "add", p, "dev", ifname, "proto", "static"); err != nil {
					writeErr(w, http.StatusInternalServerError, "ROUTE_ADD", p+": "+err.Error()+": "+out)
					return
				}
			}
		}
		for p := range curSet {
			if !desired[p] {
				if out, err := runIp("route", "del", p, "dev", ifname); err != nil {
					writeErr(w, http.StatusInternalServerError, "ROUTE_DEL", p+": "+err.Error()+": "+out)
					return
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "updated", "peerId": peerId})
}

func (s *Server) handleDeleteGrePeer(w http.ResponseWriter, r *http.Request) {
	peerId := r.PathValue("peerId")
	if !peerIdRe.MatchString(peerId) {
		writeErr(w, http.StatusBadRequest, "BAD_PEER_ID", "invalid peerId")
		return
	}
	ifname := greIfPrefix + peerId
	if !linkExists(ifname) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "already-gone", "peerId": peerId})
		return
	}
	// `ip link del` on a GRE interface also drops any route pointing at it.
	if out, err := runIp("link", "del", ifname); err != nil {
		writeErr(w, http.StatusInternalServerError, "IP_DEL", "ip link del: "+err.Error()+": "+out)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "deleted", "peerId": peerId})
}

// ── kernel helpers ───────────────────────────────────────────

func runIp(args ...string) (string, error) {
	out, err := exec.Command("ip", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func linkExists(name string) bool {
	_, err := exec.Command("ip", "link", "show", name).Output()
	return err == nil
}

// listRoutesOnDev returns destinations of `proto static` routes on this dev —
// i.e. the ones WE added for customer publicIps. Excludes the kernel-added
// connected route for the tunnel-local /30 (that's proto kernel).
func listRoutesOnDev(dev string) ([]string, error) {
	out, err := exec.Command("ip", "-j", "route", "show", "dev", dev, "proto", "static").Output()
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Dst string `json:"dst"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, err
	}
	res := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.Dst == "" || r.Dst == "default" {
			continue
		}
		if !strings.Contains(r.Dst, "/") {
			r.Dst += "/32"
		}
		res = append(res, r.Dst)
	}
	return res, nil
}

func listGrePeers() ([]grePeer, error) {
	// `ip -d -j link show type gre` — -d gives us linkinfo.info_data.remote/local/ikey
	out, err := exec.Command("ip", "-d", "-j", "link", "show", "type", "gre").Output()
	if err != nil {
		return nil, fmt.Errorf("ip link show: %w", err)
	}
	var links []linkRow
	if err := json.Unmarshal(out, &links); err != nil {
		return nil, fmt.Errorf("parse ip link json: %w", err)
	}
	res := make([]grePeer, 0, len(links))
	for _, l := range links {
		if !strings.HasPrefix(l.Ifname, greIfPrefix) {
			continue
		}
		p := grePeer{
			PeerId:    strings.TrimPrefix(l.Ifname, greIfPrefix),
			Interface: l.Ifname,
			OperState: l.Operstate,
			Mtu:       l.Mtu,
		}
		if l.LinkInfo.InfoData.Remote != "" {
			p.RemoteIp = l.LinkInfo.InfoData.Remote
		}
		if l.LinkInfo.InfoData.Local != "" {
			p.LocalIp = l.LinkInfo.InfoData.Local
		}
		p.GreKey = parseGreKey(l.LinkInfo.InfoData.Ikey)
		if l.Stats64.Rx.Bytes > 0 || l.Stats64.Tx.Bytes > 0 {
			p.BytesRx = l.Stats64.Rx.Bytes
			p.BytesTx = l.Stats64.Tx.Bytes
		}
		// Attach the point-to-point addr + public routes.
		if addrs, err := listAddrsOnDev(l.Ifname); err == nil && len(addrs) > 0 {
			p.TunnelLocalIp = addrs[0]
		}
		if routes, err := listRoutesOnDev(l.Ifname); err == nil {
			p.PublicIps = routes
		}
		res = append(res, p)
	}
	return res, nil
}

func getGrePeer(peerId string) (*grePeer, error) {
	peers, err := listGrePeers()
	if err != nil {
		return nil, err
	}
	for _, p := range peers {
		if p.PeerId == peerId {
			return &p, nil
		}
	}
	return nil, fmt.Errorf("peer %s not found", peerId)
}

// parseGreKey turns iproute2's dotted-quad key ("0.0.3.233") back into the
// uint32 the control plane assigned. Handles bare integer strings too, since
// some iproute2 versions may emit that form.
func parseGreKey(s string) uint32 {
	if s == "" {
		return 0
	}
	if strings.Contains(s, ".") {
		parts := strings.Split(s, ".")
		if len(parts) != 4 {
			return 0
		}
		var n uint32
		for _, p := range parts {
			b, err := strconv.ParseUint(p, 10, 8)
			if err != nil {
				return 0
			}
			n = (n << 8) | uint32(b)
		}
		return n
	}
	n, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		return 0
	}
	return uint32(n)
}

func listAddrsOnDev(dev string) ([]string, error) {
	out, err := exec.Command("ip", "-j", "-4", "addr", "show", "dev", dev).Output()
	if err != nil {
		return nil, err
	}
	var rows []struct {
		AddrInfo []struct {
			Local     string `json:"local"`
			Prefixlen int    `json:"prefixlen"`
		} `json:"addr_info"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, err
	}
	res := []string{}
	for _, r := range rows {
		for _, a := range r.AddrInfo {
			res = append(res, fmt.Sprintf("%s/%d", a.Local, a.Prefixlen))
		}
	}
	return res, nil
}

// Structs mirror `ip -d -j link show` output — only the fields we use.
type linkRow struct {
	Ifname    string `json:"ifname"`
	Operstate string `json:"operstate"`
	Mtu       int    `json:"mtu"`
	LinkInfo  struct {
		InfoKind string `json:"info_kind"`
		InfoData struct {
			Remote string `json:"remote"`
			Local  string `json:"local"`
			// iproute2 serialises GRE keys as dotted-quad strings ("0.0.3.233")
			// even though the wire is a 32-bit int — accept as string here.
			Ikey string `json:"ikey"`
			Okey string `json:"okey"`
		} `json:"info_data"`
	} `json:"linkinfo"`
	Stats64 struct {
		Rx struct {
			Bytes int64 `json:"bytes"`
		} `json:"rx"`
		Tx struct {
			Bytes int64 `json:"bytes"`
		} `json:"tx"`
	} `json:"stats64"`
}
