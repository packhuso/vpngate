//go:build linux

// Shared data-plane primitives used by both the WireGuard (kernel.go) and
// OpenVPN (openvpn.go) backends, so the two node types stay symmetric: kernel
// /32 routes on the VPN interface, a pool blackhole route, and tc HTB shaping.
package wg

import (
	"fmt"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// routeOnIface installs (add=true) or removes a scope-link route for each CIDR
// on the given interface. Accepts bare IP (→/32) or CIDR.
func routeOnIface(iface string, add bool, cidrs []string) error {
	link, err := netlink.LinkByName(iface)
	if err != nil {
		return fmt.Errorf("link %s: %w", iface, err)
	}
	for _, c := range cidrs {
		n, err := parseCIDR(c)
		if err != nil {
			return err
		}
		nn := n
		r := &netlink.Route{LinkIndex: link.Attrs().Index, Dst: &nn, Scope: netlink.SCOPE_LINK}
		if add {
			if err := netlink.RouteReplace(r); err != nil {
				return fmt.Errorf("route add %s dev %s: %w", c, iface, err)
			}
		} else if err := netlink.RouteDel(r); err != nil && !isNoSuchProcess(err) {
			return fmt.Errorf("route del %s dev %s: %w", c, iface, err)
		}
	}
	return nil
}

// applyBlackhole installs/removes a blackhole route for a pool CIDR.
// Interface-independent — more-specific /32 routes still win.
func applyBlackhole(cidr string, add bool) error {
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
