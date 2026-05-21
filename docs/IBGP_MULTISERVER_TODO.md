# iBGP multi-server routing — WireGuard + OpenVPN (symmetric)

Status: **design + schema foundation done** (migration 0004). FRR rollout and
the OpenVPN node are deliberate, gated steps — not done yet. The running
WireGuard gateway is untouched (`vpn_gateways.bgp_enabled = false`).

## Principle: every VPN server is the same archetype

A VPN node = `{ agent (identical HTTP API), FRR (identical config template),
kernel /32 routes }`. The **only** difference between a WireGuard node and an
OpenVPN node is the data-plane interface name (`wg0` vs `tun0`) and the protocol
its peers speak. The control plane is already protocol-agnostic:
`tunnels.protocol` (wireguard|openvpn) exists, gateway selection in
`packages/provisioning/src/provision.ts` can filter by it, and the agent API
(createPeer / updatePeerIps / deletePeer / setBlackhole / speedLimitKbit) is the
same regardless of data plane.

## Why iBGP (replaces static Mikrotik routes)

Today the Mikrotik gateway (185.213.250.89) has **static routes** sending the
pool to the WireGuard VPN gateway (185.213.250.90). With a second (OpenVPN) node
this breaks: an IP mapped to an OpenVPN tunnel must route to the OpenVPN node,
not the WG node, and IPs move between tunnels/nodes at runtime.

With iBGP, each node **announces only the /32s currently mapped to its tunnels**.
The Mikrotik installs routes from announcements, so a move just withdraws on the
old node and announces on the new one — next-hop updates automatically. No
manual Mikrotik edits, identical behaviour for WG↔WG, WG↔OVPN, OVPN↔OVPN moves.

```
                 ┌────────────── Mikrotik gw 185.213.250.89 ──────────────┐
                 │   RouterOS 7 BGP, AS 65000 (route reflector / peer)     │
                 └───────┬──────────────────────────────┬─────────────────┘
                  iBGP   │                               │  iBGP
            ┌────────────┴───────────┐       ┌───────────┴────────────┐
            │ WG node .90 (AS 65001) │       │ OVPN node .91 (AS 65002)│
            │ FRR redistribute /32   │       │ FRR redistribute /32    │
            │ on wg0 (agent-managed) │       │ on tun0 (agent-managed) │
            └────────────────────────┘       └─────────────────────────┘
```
(Single AS iBGP; per-node `local_asn` is informational/eBGP-ready. For pure iBGP
all nodes + Mikrotik share one AS and Mikrotik acts as route reflector.)

## How announcements stay correct with zero extra agent code

The agent **already** installs a scope-link `/32` (or grouped block CIDR) on the
VPN interface for every assigned public IP (`kernel.go route()`), and removes it
on unassign/delete. FRR with `redistribute connected` (or `kernel`) + a
prefix-list limited to the pool blocks will announce exactly those routes. So:

- assign IP → agent adds /32 → FRR announces → Mikrotik routes to this node
- unassign/move → agent removes /32 → FRR withdraws → Mikrotik re-points
- unallocated IP → announced by nobody → Mikrotik has no route → dropped
  (the per-node blackhole route is the local backstop)

No new agent↔FRR integration is required — FRR observes the kernel table.

## Schema (migration 0004 — applied)

`vpn_gateways` gained:
- `local_asn integer` — per-node AS (e.g. 65001 WG, 65002 OVPN)
- `bgp_router_id inet` — node's own IP (FRR router-id)
- `bgp_peer_ip inet` — Mikrotik side (shared)
- `bgp_enabled boolean default false` — rollout gate

Existing & reused: `tunnels.protocol`, `vpn_gateways.ovpn_endpoint/ovpn_port`,
`ip_pool.asn`.

## FRR config template (shared by both node types)

Only `INTERFACE` (`wg0`/`tun0`), `LOCAL_ASN`, `ROUTER_ID` differ per node.

```
! /etc/frr/frr.conf
frr defaults traditional
!
ip prefix-list POOLS seq 10 permit 104.238.11.0/25 le 32
! (one line per ip_pool.block; control plane can template this)
!
route-map TO_MIKROTIK permit 10
  match ip address prefix-list POOLS
!
router bgp <LOCAL_ASN>
  bgp router-id <ROUTER_ID>
  no bgp ebgp-requires-policy
  neighbor 185.213.250.89 remote-as 65000
  address-family ipv4 unicast
    redistribute connected route-map TO_MIKROTIK
    neighbor 185.213.250.89 activate
  exit-address-family
```
Enable `connected` redistribution because the agent's /32s are scope-link routes
on the VPN interface (show as "connected" to FRR). If they appear as kernel
routes instead, use `redistribute kernel route-map TO_MIKROTIK`.

## Mikrotik RouterOS 7 BGP (one peer per node)

```
/routing bgp connection
add name=wg-node  remote.address=185.213.250.90 remote.as=65000 \
    local.role=ibgp-rr address-families=ip
add name=ovpn-node remote.address=185.213.250.91 remote.as=65000 \
    local.role=ibgp-rr address-families=ip
```
Mikrotik acts as iBGP route reflector so the two VPN nodes don't need a full mesh.

## Cut-over plan for the EXISTING WireGuard gateway (zero-downtime)

1. Install FRR on .90, drop the template above (`wg0`, AS 65001, router-id .90).
2. Bring up the iBGP session; confirm Mikrotik **receives** the same /32s the
   static routes currently cover: `/routing route print where bgp` on Mikrotik.
3. Only once announcements match: remove the static pool routes on Mikrotik.
4. Set `UPDATE vpn_gateways SET bgp_enabled=true, local_asn=65001,
   bgp_router_id='185.213.250.90', bgp_peer_ip='185.213.250.89' WHERE hostname='vpnhub-gw-1';`
   (`bgp_enabled` is informational for the control plane / dashboards; routing is
   driven by FRR, not the flag.)

## OpenVPN agent backend — BUILT (2026-05-21)

The `vpnhub-agent` binary now ships **both** backends; pick at runtime:
- `AGENT_WG_BACKEND=kernel`  + `AGENT_WG_INTERFACE=wg0`  → WireGuard (wgctrl)
- `AGENT_WG_BACKEND=openvpn` + `AGENT_WG_INTERFACE=tun0` → OpenVPN

OpenVPN backend (`internal/wg/openvpn.go`) implements the identical `Manager`
contract. Peer model mapping:
- control-plane `publicKey` slot → OpenVPN **Common Name** (the tunnel's client id)
- `privateIp` → `ifconfig-push` in the CCD file
- `publicIps` → one `iroute` per /32 in the CCD + a kernel /32 route on tun0
  (so the OS sends the IP into the tunnel) — same netlink path as WG
- shaping (tc HTB + ifb) and `SetBlackhole` reuse the shared data-plane helpers
- live byte counters + forced reconnect via the OpenVPN **management interface**
  (`status 3`, `kill <CN>`); CCD changes apply on reconnect, so UpdatePeer
  `kill`s the CN — the OpenVPN equivalent of WG's instant allowed-IPs update.

## OpenVPN node bring-up checklist (when the VM exists)

1. Build + ship the agent bundle to `/tmp/agent-deploy/` (vpnhub-agent gw.crt
   gw.key ca.crt gw.token vpnhub-agent.service) — same bundle format as the WG node.
2. Run `infra/gateway/provision-ovpn.sh` (set `OVPN_SUBNET` to a /24 that differs
   from the WG node, e.g. 10.99.1.0). It installs openvpn + ovpn-dco-dkms +
   easy-rsa + FRR, builds the OpenVPN PKI, writes `server.conf` (topology subnet,
   ccd-exclusive, management 127.0.0.1:7505, AES-256-GCM, client-to-client OFF),
   starts `openvpn-server@server`, then installs the agent with
   `AGENT_WG_BACKEND=openvpn AGENT_WG_INTERFACE=tun0`.
3. Configure FRR with the template (`tun0`, AS 65002, router-id = node IP).
4. Register the node: `INSERT INTO vpn_gateways (... protocol-capable ...,
   ovpn_endpoint, ovpn_port, local_asn, bgp_router_id, bgp_peer_ip, bgp_enabled)`.
5. Control plane: extend `provision.ts` gateway selection to filter by the
   requested `tunnels.protocol` so an OpenVPN customer lands on an OVPN node, and
   issue an OpenVPN client cert (CN = the value sent in the agent's publicKey
   slot) signed by the node's CA — the WG keypair generation's OpenVPN analogue.
6. Verify: create an OpenVPN tunnel, assign an IP, confirm the /32 is announced
   from the OVPN node and Mikrotik next-hops to it; move the IP to a WG tunnel and
   confirm it flips automatically.

## Still TODO on the control plane (not blocking node bring-up)

- OpenVPN client-cert issuance (CA per node or shared) — analogue of WG keygen in
  `packages/provisioning/src/provision.ts`; store CN in the tunnel row's key slot.
- `.ovpn` config download for customers (analogue of the WireGuard `.conf` /
  Mikrotik export in `tunnels.service.ts`).
- `provision.ts` gateway selection filter by `tunnels.protocol`.

## Verification (foundation, this round)

- `\d vpn_gateways` shows `local_asn`, `bgp_router_id`, `bgp_peer_ip`,
  `bgp_enabled` (default false). No runtime/routing change — the WG gateway still
  uses static Mikrotik routes + the per-node blackhole from the routing work.
