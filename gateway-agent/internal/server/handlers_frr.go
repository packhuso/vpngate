// POST /v1/frr/prefix-list/sync — replace the contents of a managed FRR
// prefix-list atomically (one vtysh call → BGP withdraw/announce together).
// The control plane is the source of truth for VPN-POOLS contents; this
// endpoint lets it push the desired state without us shelling into the box.
//
// Security: caller is already authenticated by mTLS + bearer. We additionally
// (a) whitelist the list name (so callers can't wreck unrelated prefix-lists),
// (b) parse each prefix as a real CIDR, (c) bound ge/le, and (d) use exec
// array args (no shell). No write touches anything outside `VPN-POOLS`.
package server

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
)

var allowedPrefixLists = map[string]bool{
	"VPN-POOLS": true,
}

type prefixListEntry struct {
	Prefix string `json:"prefix"`
	Ge     int    `json:"ge"`
	Le     int    `json:"le"`
}

type prefixListSyncReq struct {
	List     string            `json:"list"`
	Prefixes []prefixListEntry `json:"prefixes"`
}

func (s *Server) handlePrefixListSync(w http.ResponseWriter, r *http.Request) {
	var req prefixListSyncReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "json decode failed")
		return
	}
	if !allowedPrefixLists[req.List] {
		writeErr(w, http.StatusBadRequest, "BAD_LIST", "list not in allowlist")
		return
	}
	// Validate each entry — must parse as real CIDR; ge/le bounded.
	for i, p := range req.Prefixes {
		if _, _, err := net.ParseCIDR(p.Prefix); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_PREFIX",
				fmt.Sprintf("entry %d: invalid CIDR %q", i, p.Prefix))
			return
		}
		if p.Ge < 0 || p.Ge > 32 || p.Le < 0 || p.Le > 32 {
			writeErr(w, http.StatusBadRequest, "BAD_GE_LE",
				fmt.Sprintf("entry %d: ge/le out of range", i))
			return
		}
	}

	// Build vtysh commands. `no ip prefix-list <name>` clears the list, then we
	// re-add every desired entry — all inside ONE `configure terminal` block so
	// BGP sees a single atomic transition (no flap window where the list is
	// empty). `write memory` persists for FRR restart.
	cmds := []string{"configure terminal", "no ip prefix-list " + req.List}
	seq := 5
	for _, p := range req.Prefixes {
		line := fmt.Sprintf("ip prefix-list %s seq %d permit %s", req.List, seq, p.Prefix)
		if p.Ge > 0 {
			line += fmt.Sprintf(" ge %d", p.Ge)
		}
		if p.Le > 0 {
			line += fmt.Sprintf(" le %d", p.Le)
		}
		cmds = append(cmds, line)
		seq += 5
	}
	cmds = append(cmds, "do write memory")

	args := make([]string, 0, len(cmds)*2)
	for _, c := range cmds {
		args = append(args, "-c", c)
	}
	cmd := exec.CommandContext(r.Context(), "vtysh", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "VTYSH_FAILED",
			fmt.Sprintf("%s: %s", err.Error(), string(out)))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"list":    req.List,
		"entries": len(req.Prefixes),
	})
}
