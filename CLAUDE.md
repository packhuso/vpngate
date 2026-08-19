# VPN Hub — Claude primer

Read this before touching anything. **Production is live** on this host —
customers depend on it. Prefer reversible edits, verify from the outside
(portal, external endpoints), and commit with a `Co-Authored-By: Claude Opus`
trailer.

## What this is

CGNAT-bypass VPN that hands customers a real Public IPv4 through pure
WireGuard routing (no NAT). Sold via a self-service portal. Design memory
lives in `~/.claude/projects/-opt-vpnhub-app/memory/project_vpnhub.md`.

## Monorepo layout (pnpm workspaces)

    apps/
      api/              NestJS control-plane API (:3001) — vpnhub-api.service
      portal/           Next.js 15 App Router customer + admin portal (:3080) — vpnhub-portal.service
      worker-internal/  BullMQ worker: billing tick, drift reconcile, traffic sampler,
                        email enqueue/dispatch — vpnhub-worker-internal.service
      worker-gateway/   (per-gateway agent bridge)
    packages/
      auth/             session cookie + Google OAuth
      billing/          pricing, sale plans, wallet
      db/               drizzle schema + migrations (0000-0014)
      gateway-client/   mTLS client to gateway-agent :9443
      provisioning/     tunnel/IP/block lifecycle, drift, email/, traffic-sampler, ...
      shared/           encryption, common types
    gateway-agent/      Go daemon that runs ON each VPN gateway VM (mTLS + Bearer)
    infra/tools/        ros-bgp-check.py (Mikrotik ASBR read-only queries)
    infra/gateway/      provision scripts for new gateway VMs

## The hosts

    vpnhub-app          10.2.1.3    this machine — API + portal + worker + Postgres/Redis in docker
                        185.213.250.2 (Mikrotik SNAT outbound only, no inbound SSH)
                        portal.myip.in.th → cloudflared tunnel → :3080 + :3001/v1
    vpnhub-gw-1         10.2.1.2    active WG gateway VM, endpoint 185.213.250.90:443
                        AS 65001, peers Mikrotik AS 65000, runs vpnhub-agent + FRR
    vpnhub-gre-1        10.2.1.7    active GRE gateway VM, public 185.213.250.91/29
                        AS 65002, peers Mikrotik AS 65000, runs vpnhub-agent + FRR + nftables
                        packhuso has NOPASSWD sudo here (unlike gw-1)
    vpnhub-gw-2/3       10.2.1.4/5  DB rows only, VMs deleted (OpenVPN/SSTP was ripped out)
    mikrotik-asbr       10.2.1.1 / 185.213.250.89  ASBR, ROS API :8728

Public IP pools currently in `ip_pool`: 104.238.11.0/24, 185.213.250.32/27,
185.213.250.8/30, 216.132.69.248/29.

## SSH access

`~/.ssh/config` has aliases `vpnhub-gw` (→ 10.2.1.2) and `vpnhub-app`. My
key `~/.ssh/vpnhub_gw` is authorized on **both**. YANH-DEBIAN also has
this pubkey (customer client; access via ProxyJump through vpnhub-gw only,
its WG AllowedIPs is now `10.99.0.0/24`).

## What you can and can't sudo

- **vpnhub-app (here)**: NOPASSWD sudo for `systemctl restart|is-active`
  on `vpnhub-{api,portal,worker-internal}` — use freely for deploys.
- **vpnhub-gw (10.2.1.2)**: sudo requires password. `packhuso@vpnhub-gw` has
  NO NOPASSWD rules. Agent deploy needs a human. The Claude Code auto-mode
  classifier **also blocks** `sudo -S` / `sshpass` — do not try. Ask the
  operator to run the install command themselves from their laptop:
  `ssh -t vpnhub-gw 'sudo install -m 0755 /tmp/vpnhub-agent-new /usr/local/bin/vpnhub-agent && sudo systemctl restart vpnhub-agent'`

## Common deploys

    # API or portal (both here)
    pnpm --filter @vpnhub/api build      # or portal
    sudo -n systemctl restart vpnhub-api # or vpnhub-portal

    # Worker (also here)
    pnpm --filter @vpnhub/worker-internal build
    sudo -n systemctl restart vpnhub-worker-internal

    # Gateway agent (on vpnhub-gw)
    cd gateway-agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -o /tmp/scratch/gateway-agent ./cmd/agent
    scp /tmp/scratch/gateway-agent vpnhub-gw:/tmp/vpnhub-agent-new
    # then user runs the install+restart (see above — sudo password on gw)

## DB migrations

Numbered SQL files under `packages/db/src/drizzle/`. Apply with:
`docker exec -i vpnhub-postgres psql -U vpnhub -d vpnhub < packages/db/src/drizzle/NNNN_*.sql`.
Drizzle schema in `schema.ts` should mirror the migration; keep them in sync
by hand (no drizzle-kit push to prod).

## Env (source of truth: `.env`, template: `.env.example`)

Notable:
- `DATABASE_URL`, `REDIS_URL` — local docker
- `APP_SECRET_KEY` — encryption for wg private keys
- `WORKER_TLS_CLIENT_CERT/_KEY` — mTLS to gateway-agent (path, not inline)
- `GOOGLE_CLIENT_ID/_SECRET/_REDIRECT_URI` — OAuth
- `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_ENABLED` — email stack (see below)

## Postgres.js gotcha (bit us twice)

`postgres.js` returns `timestamptz` as **string**, not `Date`. Anywhere you
`.toISOString()` a query result you'll crash. Two fixes we use:
- Format inside SQL with `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
- Or cast to `text` in the SELECT and treat as string everywhere in TS.

## Email notifications (worker-internal)

Live via Resend. `EMAIL_ENABLED=false` puts the dispatcher in dry-run
(queue fills, log says what would send, no HTTP to Resend). Classifier
lives in `packages/provisioning/src/email/classifier.ts` — when adding
new admin/system events, check the REAL `metadata` keys via
`SELECT metadata FROM audit_logs WHERE action = ...` (production keys
often differ from what the code that emits them "looks like").

## Gateways / BGP

vpnhub-gw runs FRR. Prefix-list `VPN-POOLS` is admin-managed (control plane
pushes via `POST /v1/frr/prefix-list/sync`, atomically). BGP: local AS 65001,
neighbor 185.213.250.89 (Mikrotik AS 65000). Admin page `/admin/gateways`
shows live BGP + WG peers + prefix-list contents — new agent endpoint
`GET /v1/routing/status` backs it.

## GRE gateway (vpnhub-gre-1) — infra config not in git

Rebuilding a GRE gateway from scratch needs these on the box (they're **not**
in provisioning scripts yet — add to `infra/gateway/provision-gre.sh` when
you write it):

**FRR** — must be `redistribute kernel` (not `static`) because our agent inserts
routes with `ip route add ... proto static` at the kernel level, not via
vtysh's own static-route RIB:

    router bgp <asn>
      address-family ipv4 unicast
        redistribute kernel
        neighbor <mikrotik-ip> prefix-list VPN-POOLS out

If you set `redistribute static` instead, BGP announces nothing and Mikrotik
shows the session up with `PfxSnt=0` — silently broken.

**nftables** — TCP MSS clamp for GRE tunnels. Without it, PMTUD blackholes
kill TCP flows on paths that filter ICMP:

    table inet vpnhub {
      chain forward_gre_mss {
        type filter hook forward priority mangle; policy accept;
        meta iifname "gre-*" tcp flags syn tcp option maxseg size set rt mtu
        meta oifname "gre-*" tcp flags syn tcp option maxseg size set rt mtu
      }
    }

Persisted in `/etc/nftables.conf`, service enabled.

**Netplan** — default route MUST go via the public interface (ens19), not the
LAN one, or customer traffic gets NAT'd by Mikrotik LAN interface. Also
disable cloud-init network config (`/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`
= `network: {config: disabled}`) so netplan changes persist.

**Perf tuning** (`/etc/sysctl.d/60-vpnhub-net-tune.conf`) — default Debian
buffers cap single-TCP-flow throughput at ~150 Mbps on high-BDP paths:

    net.core.rmem_max = 16777216
    net.core.wmem_max = 16777216
    net.ipv4.tcp_rmem = 4096 262144 16777216
    net.ipv4.tcp_wmem = 4096 262144 16777216
    net.core.netdev_max_backlog = 16384
    net.ipv4.tcp_congestion_control = bbr
    net.core.default_qdisc = fq

Plus `apt install irqbalance` (enable) to spread virtio queue IRQs across
the 8 vCPUs. TX ring bump attempted via `/etc/systemd/system/vpnhub-nic-tune.service`
but virtio-net caps at 256 — kept for a future driver that supports more.

## Traffic sampler

Every 5 min the worker polls each active gateway's `/v1/stats/peers`,
diffs against `tunnel_stats_last`, writes deltas into `bandwidth_usage`
(NOT cumulative). First-ever sample per tunnel is skipped so a fresh
counter doesn't show as a giant spike. Retention 90d, prune daily 03:00 UTC.

## Style

- Terse Thai replies to the operator. English commits + code comments.
- Never mock the DB in tests — hit the real one.
- Prefer bundled PRs over splitting when they touch the same area.
- No `<style jsx>` — this repo isn't wired for styled-jsx; use `globals.css`
  or inline `style` with `animation:` referencing a globals @keyframes.
