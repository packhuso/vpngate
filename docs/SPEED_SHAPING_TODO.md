# Speed shaping per peer — design (not yet implemented)

Status: **deferred**. The agent and pricing tables already understand
`speed_tier` (100 Mbps / 500 Mbps / 1 Gbps); gateway-side enforcement is the
missing piece.

## Goal

For every WireGuard peer, cap throughput in BOTH directions at the
customer's purchased tier. Customer must not be able to bypass (egress
limit must be on the gateway, not on the client).

## Recommended approach — HTB on wg0 + ifb for ingress

Linux `tc` HTB classifier on `wg0` shapes egress (gateway → customer); a
mirror through an `ifb0` virtual interface shapes ingress (customer →
gateway).

```bash
# one-time, on gateway:
tc qdisc add dev wg0 root handle 1: htb default 9999
tc class add dev wg0 parent 1: classid 1:1 htb rate 10gbit

# ingress mirror:
modprobe ifb numifbs=1
ip link set ifb0 up
tc qdisc add dev wg0 handle ffff: ingress
tc filter add dev wg0 parent ffff: u32 match u32 0 0 \
  action mirred egress redirect dev ifb0
tc qdisc add dev ifb0 root handle 1: htb default 9999
tc class add dev ifb0 parent 1: classid 1:1 htb rate 10gbit
```

Per peer (when agent runs `CreatePeer`):

```bash
# pick a unique 16-bit classid per tunnel — e.g. minor = first 16 bits
# of the SHA1 of the peer publicKey, OR a counter from the agent.
CLASSID=2
RATE=100mbit   # from speed_tier

# egress (download to customer): match dst = peer's allowed IPs
tc class add dev wg0 parent 1:1 classid 1:$CLASSID htb rate $RATE ceil $RATE
tc qdisc add dev wg0 parent 1:$CLASSID handle $CLASSID: fq_codel
tc filter add dev wg0 parent 1: protocol ip prio 1 u32 \
  match ip dst 10.99.0.5/32 flowid 1:$CLASSID
tc filter add dev wg0 parent 1: protocol ip prio 1 u32 \
  match ip dst 104.238.11.10/32 flowid 1:$CLASSID
# repeat the dst filter for every public IP assigned to the peer

# ingress (upload from customer): match src on ifb0
tc class add dev ifb0 parent 1:1 classid 1:$CLASSID htb rate $RATE ceil $RATE
tc qdisc add dev ifb0 parent 1:$CLASSID handle $CLASSID: fq_codel
tc filter add dev ifb0 parent 1: protocol ip prio 1 u32 \
  match ip src 10.99.0.5/32 flowid 1:$CLASSID
tc filter add dev ifb0 parent 1: protocol ip src 104.238.11.10/32 flowid 1:$CLASSID
```

On peer delete: remove the class + filters.
On peer update (IP add/remove): adjust filters.
On peer rate change: `tc class change ... rate <new>`.

## Implementation plan

1. **`gateway-agent/internal/wg/wg.go`** — add `SpeedLimitBps int64` to
   `CreatePeerInput` and `Peer` struct.
2. **`gateway-agent/internal/wg/kernel.go`** — new helpers:
   - `setupRootShaping()` called once at startup (HTB root on wg0 + ifb)
   - `addPeerShaping(classid, rateBps, privateIp, publicIps)` after `ConfigureDevice`
   - `removePeerShaping(classid)` before peer delete
   - `updatePeerShapingIps(classid, newIps)` on `UpdatePeer`
   - classid map: `map[publicKey]uint16` — survives in memory; rebuild on
     restart from kernel state via `tc filter show`
3. **`@vpnhub/billing`** — add `TIER_RATE_BPS`:
   ```ts
   tier_100mb:  12_500_000,  // 100 Mbps in bytes/sec (or use kbit directly)
   tier_500mb:  62_500_000,
   tier_1gb:   125_000_000,
   ```
4. **`@vpnhub/provisioning`** — `createTunnel` and `assignPublicIp` pass the
   rate to `gateway-client.createPeer` / `updatePeerIps`.
5. **`@vpnhub/gateway-client`** — extend `createPeer`/`updatePeerIps`
   payloads with `speedLimitBps`.
6. **Drift detection** — include speed limit in the diff so reboot
   recovery restores shaping too.
7. **Tests** — `tc -s class show dev wg0` parsing, verify bytes counters
   in `wg show` match expected after a known download.

## Verification

```bash
# expected: actual throughput from customer matches tier
iperf3 -c <gateway-or-far-end> -t 30
# inspect on gateway:
tc -s class show dev wg0
tc -s filter show dev wg0
```

## Why not done now

- `tc` filter rebuilds on every IP add/remove (move flow) — needs careful
  ordering with `wgctrl.ConfigureDevice` to avoid windows where allowed-IPs
  are set but filters not yet matching (= packet matches default 1:9999 unshaped).
- Multi-peer testing on a real high-bandwidth path is needed.
- Need to decide policy: hard cap (drop excess) vs. soft (delay/queue).
  HTB defaults to delay; for VPN customers, hard rate-limit + small burst
  is usually preferred.

Estimated effort: ~1-2 days focused work + test infrastructure (iperf
endpoints, multiple peers).
