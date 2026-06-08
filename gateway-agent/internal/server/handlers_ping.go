// POST /v1/ping — shell out to /usr/bin/ping against a single private/peer IP
// on this gateway. Body: {"ip":"10.x.x.x"}. The caller (control plane) is
// trusted by mTLS+Bearer, but we still validate the IP strictly so the request
// can never inject extra args/shell.
package server

import (
	"encoding/json"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
)

type pingReq struct {
	IP string `json:"ip"`
}

type pingResp struct {
	IP          string   `json:"ip"`
	Transmitted int      `json:"transmitted"`
	Received    int      `json:"received"`
	LossPct     int      `json:"lossPct"`
	MinMs       *float64 `json:"minMs"`
	AvgMs       *float64 `json:"avgMs"`
	MaxMs       *float64 `json:"maxMs"`
}

var (
	reSummary = regexp.MustCompile(`(\d+) packets transmitted, (\d+) received`)
	reRtt     = regexp.MustCompile(`min/avg/max/[^\s=]+\s*=\s*([\d.]+)/([\d.]+)/([\d.]+)`)
)

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	var req pingReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "json decode failed")
		return
	}
	ip := net.ParseIP(req.IP)
	if ip == nil {
		writeErr(w, http.StatusBadRequest, "INVALID_IP", "not a valid IP literal")
		return
	}
	bin := "ping"
	if ip.To4() == nil {
		bin = "ping6"
	}
	// -c 4 packets, -W 2s/packet timeout, -i 0.3s interval, -n no DNS.
	cmd := exec.CommandContext(r.Context(), bin,
		"-n", "-c", "4", "-W", "2", "-i", "0.3", ip.String())
	out, err := cmd.CombinedOutput()
	resp := pingResp{IP: ip.String(), Transmitted: 4, Received: 0, LossPct: 100}
	// 100% loss makes ping exit 1 — that's OK, we still parse the summary line.
	_ = err
	if m := reSummary.FindStringSubmatch(string(out)); m != nil {
		tx, _ := strconv.Atoi(m[1])
		rx, _ := strconv.Atoi(m[2])
		resp.Transmitted = tx
		resp.Received = rx
		if tx > 0 {
			resp.LossPct = int(float64(tx-rx) / float64(tx) * 100)
		}
	}
	if m := reRtt.FindStringSubmatch(string(out)); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			resp.MinMs = &v
		}
		if v, err := strconv.ParseFloat(m[2], 64); err == nil {
			resp.AvgMs = &v
		}
		if v, err := strconv.ParseFloat(m[3], 64); err == nil {
			resp.MaxMs = &v
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
