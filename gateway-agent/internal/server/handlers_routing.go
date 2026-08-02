// GET /v1/routing/status — read-only view of BGP session state and the
// managed VPN-POOLS prefix-list. Used by the admin Gateways page so the
// operator can spot a down BGP neighbor or missing prefix without SSHing in.
//
// Runs two vtysh queries. `show bgp summary json` gives structured output
// with all neighbors and prefix counts. The prefix-list JSON schema varies
// across FRR versions, so we parse the text form for VPN-POOLS — cheap and
// stable. If FRR isn't installed on this node (non-BGP gateway), we return
// an empty payload rather than erroring — callers key off `bgpAvailable`.
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type bgpNeighbor struct {
	Neighbor      string `json:"neighbor"`
	RemoteAs      int    `json:"remoteAs"`
	State         string `json:"state"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	PfxRcd        int    `json:"pfxRcd"`
	PfxSnt        int    `json:"pfxSnt"`
}

type prefixEntry struct {
	Seq    int    `json:"seq"`
	Action string `json:"action"`
	Prefix string `json:"prefix"`
	Ge     int    `json:"ge,omitempty"`
	Le     int    `json:"le,omitempty"`
}

type routingStatus struct {
	CollectedAt      string        `json:"collectedAt"`
	BgpAvailable     bool          `json:"bgpAvailable"`
	LocalAs          int           `json:"localAs,omitempty"`
	RouterId         string        `json:"routerId,omitempty"`
	Neighbors        []bgpNeighbor `json:"neighbors"`
	PrefixListName   string        `json:"prefixListName"`
	PrefixListCount  int           `json:"prefixListCount"`
	PrefixEntries    []prefixEntry `json:"prefixEntries"`
	Warnings         []string      `json:"warnings,omitempty"`
}

func (s *Server) handleRoutingStatus(w http.ResponseWriter, r *http.Request) {
	out := routingStatus{
		CollectedAt:    time.Now().UTC().Format(time.RFC3339),
		PrefixListName: "VPN-POOLS",
		Neighbors:      []bgpNeighbor{},
		PrefixEntries:  []prefixEntry{},
	}

	// BGP summary (structured). Cap at 3s so a stuck vtysh can't hang the API.
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	sum, err := exec.CommandContext(ctx, "vtysh", "-c", "show bgp summary json").Output()
	if err != nil {
		// vtysh missing → non-BGP node; return empty payload with the flag off.
		out.Warnings = append(out.Warnings, "bgp: "+err.Error())
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.BgpAvailable = true
	parseBgpSummary(sum, &out)

	// Prefix-list VPN-POOLS (text — FRR prefix-list JSON output isn't stable
	// across versions; the text form has one entry per line and parses cleanly).
	pctx, pcancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer pcancel()
	pl, err := exec.CommandContext(pctx, "vtysh", "-c", "show ip prefix-list VPN-POOLS").Output()
	if err == nil {
		out.PrefixEntries = parsePrefixList(string(pl))
		out.PrefixListCount = len(out.PrefixEntries)
	} else {
		out.Warnings = append(out.Warnings, "prefix-list: "+err.Error())
	}

	writeJSON(w, http.StatusOK, out)
}

// FRR "show bgp summary json" wraps AFIs under keys like "ipv4Unicast".
// We only care about IPv4 unicast for now.
func parseBgpSummary(raw []byte, out *routingStatus) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		out.Warnings = append(out.Warnings, "bgp-summary: "+err.Error())
		return
	}
	v4, ok := doc["ipv4Unicast"]
	if !ok {
		return
	}
	var af struct {
		As       int                        `json:"as"`
		RouterId string                     `json:"routerId"`
		Peers    map[string]json.RawMessage `json:"peers"`
	}
	if err := json.Unmarshal(v4, &af); err != nil {
		out.Warnings = append(out.Warnings, "bgp-af: "+err.Error())
		return
	}
	out.LocalAs = af.As
	out.RouterId = af.RouterId
	for addr, raw := range af.Peers {
		var p struct {
			RemoteAs      int    `json:"remoteAs"`
			State         string `json:"state"`
			PeerUptimeMsec int64 `json:"peerUptimeMsec"`
			PfxRcd        int    `json:"pfxRcd"`
			PfxSnt        int    `json:"pfxSnt"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		out.Neighbors = append(out.Neighbors, bgpNeighbor{
			Neighbor:      addr,
			RemoteAs:      p.RemoteAs,
			State:         p.State,
			UptimeSeconds: p.PeerUptimeMsec / 1000,
			PfxRcd:        p.PfxRcd,
			PfxSnt:        p.PfxSnt,
		})
	}
}

// FRR prefix-list text format, e.g.:
//   ZEBRA: ip prefix-list VPN-POOLS: 3 entries
//      seq 5 permit 104.238.11.0/26
//      seq 10 permit 185.213.250.32/27 ge 32
var prefixLine = regexp.MustCompile(`^\s*seq\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+ge\s+(\d+))?(?:\s+le\s+(\d+))?`)

func parsePrefixList(text string) []prefixEntry {
	// Some FRR versions print each entry twice (e.g. once per daemon output
	// prefix). Dedupe by seq so the UI shows the real prefix-list contents.
	seen := make(map[int]bool)
	var out []prefixEntry
	for _, line := range strings.Split(text, "\n") {
		m := prefixLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		seq, _ := strconv.Atoi(m[1])
		if seen[seq] {
			continue
		}
		seen[seq] = true
		e := prefixEntry{Seq: seq, Action: m[2], Prefix: m[3]}
		if m[4] != "" {
			e.Ge, _ = strconv.Atoi(m[4])
		}
		if m[5] != "" {
			e.Le, _ = strconv.Atoi(m[5])
		}
		out = append(out, e)
	}
	return out
}
