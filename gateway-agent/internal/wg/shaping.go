//go:build linux

// Per-peer bandwidth shaping via `tc` HTB on the WG interface (egress /
// download) mirrored through an ifb device (ingress / upload), plus blackhole
// route management. Shells out to `tc`/`ip` — same toolset used to provision
// the gateway. See docs/SPEED_SHAPING_TODO.md.
package wg

import (
	"fmt"
	"os/exec"
	"strings"
)

const ifbDev = "ifb0"

func run(args ...string) error {
	cmd := exec.Command(args[0], args[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// runOK ignores "already exists" / "no such file" style errors (idempotent).
func runOK(args ...string) {
	_ = run(args...)
}

// setupRootShaping installs the HTB root qdisc on the WG interface (egress)
// and an ifb mirror (ingress). Idempotent-ish: clears any previous root first.
func (k *KernelManager) setupRootShaping() error {
	if _, err := exec.LookPath("tc"); err != nil {
		return fmt.Errorf("tc not found")
	}
	// egress root on wg0
	runOK("tc", "qdisc", "del", "dev", k.iface, "root")
	if err := run("tc", "qdisc", "add", "dev", k.iface, "root", "handle", "1:", "htb", "default", "9999"); err != nil {
		return err
	}
	runOK("tc", "class", "add", "dev", k.iface, "parent", "1:", "classid", "1:1", "htb", "rate", "10gbit")

	// ingress mirror via ifb
	runOK("modprobe", "ifb", "numifbs=1")
	runOK("ip", "link", "set", ifbDev, "up")
	runOK("tc", "qdisc", "del", "dev", k.iface, "ingress")
	if err := run("tc", "qdisc", "add", "dev", k.iface, "handle", "ffff:", "ingress"); err != nil {
		return err
	}
	if err := run("tc", "filter", "add", "dev", k.iface, "parent", "ffff:",
		"protocol", "all", "u32", "match", "u32", "0", "0",
		"action", "mirred", "egress", "redirect", "dev", ifbDev); err != nil {
		return err
	}
	runOK("tc", "qdisc", "del", "dev", ifbDev, "root")
	if err := run("tc", "qdisc", "add", "dev", ifbDev, "root", "handle", "1:", "htb", "default", "9999"); err != nil {
		return err
	}
	runOK("tc", "class", "add", "dev", ifbDev, "parent", "1:", "classid", "1:1", "htb", "rate", "10gbit")
	return nil
}

// shapeArgs builds the host/32 string for a tc u32 match (accepts bare IP or CIDR).
func host32(ip string) string {
	if strings.Contains(ip, "/") {
		return ip
	}
	return ip + "/32"
}

// addPeerShaping creates an HTB class + fq_codel leaf on both wg0 (egress, dst
// match) and ifb0 (ingress, src match) for the peer's privateIP + publicIPs.
func (k *KernelManager) addPeerShaping(classid uint16, kbit int, privateIP string, publicIPs []string) {
	if !k.shaping || classid == 0 || kbit <= 0 {
		return
	}
	rate := fmt.Sprintf("%dkbit", kbit)
	cid := fmt.Sprintf("1:%d", classid)
	handle := fmt.Sprintf("%d:", classid)

	// egress (download): class + leaf + dst filters on wg0
	runOK("tc", "class", "add", "dev", k.iface, "parent", "1:1", "classid", cid, "htb", "rate", rate, "ceil", rate)
	runOK("tc", "qdisc", "add", "dev", k.iface, "parent", cid, "handle", handle, "fq_codel")
	// ingress (upload): class + leaf on ifb0
	runOK("tc", "class", "add", "dev", ifbDev, "parent", "1:1", "classid", cid, "htb", "rate", rate, "ceil", rate)
	runOK("tc", "qdisc", "add", "dev", ifbDev, "parent", cid, "handle", handle, "fq_codel")

	k.addShapingFilters(classid, append([]string{privateIP}, publicIPs...))
}

// addShapingFilters adds dst (wg0) + src (ifb0) u32 filters for each IP → class.
func (k *KernelManager) addShapingFilters(classid uint16, ips []string) {
	if !k.shaping || classid == 0 {
		return
	}
	cid := fmt.Sprintf("1:%d", classid)
	for _, ip := range ips {
		h := host32(ip)
		runOK("tc", "filter", "add", "dev", k.iface, "parent", "1:", "protocol", "ip",
			"prio", "1", "u32", "match", "ip", "dst", h, "flowid", cid)
		runOK("tc", "filter", "add", "dev", ifbDev, "parent", "1:", "protocol", "ip",
			"prio", "1", "u32", "match", "ip", "src", h, "flowid", cid)
	}
}

// updatePeerShaping re-applies rate + filters when a peer's IPs or tier change.
// Simplest correct approach: tear down the class (which drops its filters) and
// rebuild. tc has no clean per-filter delete by match, so rebuild is safest.
func (k *KernelManager) updatePeerShaping(classid uint16, kbit int, privateIP string, publicIPs []string) {
	if !k.shaping || classid == 0 {
		return
	}
	k.removePeerShaping(classid)
	k.addPeerShaping(classid, kbit, privateIP, publicIPs)
}

// removePeerShaping deletes the peer's HTB classes on both interfaces. Deleting
// a class also removes its attached filters and leaf qdisc.
func (k *KernelManager) removePeerShaping(classid uint16) {
	if classid == 0 {
		return
	}
	cid := fmt.Sprintf("1:%d", classid)
	// remove filters first (best-effort), then leaf qdisc, then class
	runOK("tc", "qdisc", "del", "dev", k.iface, "parent", cid)
	runOK("tc", "qdisc", "del", "dev", ifbDev, "parent", cid)
	runOK("tc", "class", "del", "dev", k.iface, "classid", cid)
	runOK("tc", "class", "del", "dev", ifbDev, "classid", cid)
}

// allocClass returns the peer's existing classid or assigns a fresh one.
// Caller must hold k.mu.
func (k *KernelManager) allocClass(m *meta) uint16 {
	if m.classid != 0 {
		return m.classid
	}
	if k.nextClass < 2 {
		k.nextClass = 2
	}
	m.classid = k.nextClass
	k.nextClass++
	return m.classid
}

// ── interface-parameterized variants (used by the OpenVPN backend) ──────────
// Same HTB/ifb scheme as the *KernelManager methods, but take the interface
// name explicitly so a tun0-based backend can reuse them. Kept separate so the
// production WireGuard path stays untouched.

func setupRootShapingOn(iface string) error {
	if _, err := exec.LookPath("tc"); err != nil {
		return fmt.Errorf("tc not found")
	}
	runOK("tc", "qdisc", "del", "dev", iface, "root")
	if err := run("tc", "qdisc", "add", "dev", iface, "root", "handle", "1:", "htb", "default", "9999"); err != nil {
		return err
	}
	runOK("tc", "class", "add", "dev", iface, "parent", "1:", "classid", "1:1", "htb", "rate", "10gbit")
	runOK("modprobe", "ifb", "numifbs=1")
	runOK("ip", "link", "set", ifbDev, "up")
	runOK("tc", "qdisc", "del", "dev", iface, "ingress")
	if err := run("tc", "qdisc", "add", "dev", iface, "handle", "ffff:", "ingress"); err != nil {
		return err
	}
	if err := run("tc", "filter", "add", "dev", iface, "parent", "ffff:",
		"protocol", "all", "u32", "match", "u32", "0", "0",
		"action", "mirred", "egress", "redirect", "dev", ifbDev); err != nil {
		return err
	}
	runOK("tc", "qdisc", "del", "dev", ifbDev, "root")
	if err := run("tc", "qdisc", "add", "dev", ifbDev, "root", "handle", "1:", "htb", "default", "9999"); err != nil {
		return err
	}
	runOK("tc", "class", "add", "dev", ifbDev, "parent", "1:", "classid", "1:1", "htb", "rate", "10gbit")
	return nil
}

func addShapingOn(iface string, classid uint16, kbit int, privateIP string, publicIPs []string) {
	if classid == 0 || kbit <= 0 {
		return
	}
	rate := fmt.Sprintf("%dkbit", kbit)
	cid := fmt.Sprintf("1:%d", classid)
	handle := fmt.Sprintf("%d:", classid)
	runOK("tc", "class", "add", "dev", iface, "parent", "1:1", "classid", cid, "htb", "rate", rate, "ceil", rate)
	runOK("tc", "qdisc", "add", "dev", iface, "parent", cid, "handle", handle, "fq_codel")
	runOK("tc", "class", "add", "dev", ifbDev, "parent", "1:1", "classid", cid, "htb", "rate", rate, "ceil", rate)
	runOK("tc", "qdisc", "add", "dev", ifbDev, "parent", cid, "handle", handle, "fq_codel")
	for _, ip := range append([]string{privateIP}, publicIPs...) {
		h := host32(ip)
		runOK("tc", "filter", "add", "dev", iface, "parent", "1:", "protocol", "ip",
			"prio", "1", "u32", "match", "ip", "dst", h, "flowid", cid)
		runOK("tc", "filter", "add", "dev", ifbDev, "parent", "1:", "protocol", "ip",
			"prio", "1", "u32", "match", "ip", "src", h, "flowid", cid)
	}
}

func removeShapingOn(iface string, classid uint16) {
	if classid == 0 {
		return
	}
	cid := fmt.Sprintf("1:%d", classid)
	runOK("tc", "qdisc", "del", "dev", iface, "parent", cid)
	runOK("tc", "qdisc", "del", "dev", ifbDev, "parent", cid)
	runOK("tc", "class", "del", "dev", iface, "classid", cid)
	runOK("tc", "class", "del", "dev", ifbDev, "classid", cid)
}
