# VPN Hub — Gateway Agent

Go daemon that runs on each **VPN gateway VM** (a separate provider with BGP,
NOT the app VM — design Section 3.1 / 4.1). The control-plane worker calls it
to provision/manage WireGuard peers. API contract: [`../docs/vpnhub-agent.yaml`](../docs/vpnhub-agent.yaml).

## Status: scaffold (stdlib-only, compiles + tested)

Implemented and verified via `go test ./...`:

- Full HTTP API from the OpenAPI spec — Peers (list/create/get/update/delete/
  suspend/resume), Stats, Stats/peers, Health/Ready/Version
- 3-layer security model (design Section 6.1):
  1. host firewall whitelist — *gateway VM concern (nftables/cloud fw)*
  2. **mTLS** — TLS 1.3, `RequireAndVerifyClientCert` vs our private CA
  3. **Bearer token** — per-gateway, constant-time compare; health exempt
- Idempotency cache (`Idempotency-Key`, 24h) for write ops
- Graceful shutdown, panic recovery, structured JSON logs

### Stubbed (real impl lands on the gateway VM)

`internal/wg.MemoryManager` is an **in-memory backend with no kernel side
effects**. The real backend implements the same `wg.Manager` interface using
`wgctrl-go` + `netlink` (add peer, route `publicIps`), with FRR announcing
`/32` over OSPF/BGP and nftables for rate-limit/firewall. It can only run on a
host with the WireGuard kernel module, so it is intentionally not faked here.

## Build / test / run

```bash
make test          # contract tests (no kernel needed)
make build         # ./bin/vpnhub-agent (host arch)
make build-linux   # static linux/amd64 to scp to the gateway VM
make run           # dev: AGENT_TLS_DISABLE=true, plain HTTP on :9443
```

## Config (env)

| Var | Default | Notes |
|---|---|---|
| `AGENT_LISTEN_ADDR` | `:9443` | bind addr |
| `AGENT_WG_INTERFACE` | `wg0` | WireGuard iface |
| `AGENT_TLS_DISABLE` | `false` | **dev only** — plain HTTP, no auth |
| `AGENT_TLS_SERVER_CERT` / `_KEY` | — | agent server cert/key (PEM) |
| `AGENT_TLS_CLIENT_CA` | — | private CA that signed worker certs |
| `AGENT_BEARER_TOKEN` | — | per-gateway token (`vpn_gateways.agent_token`) |
| `AGENT_IDEMPOTENCY_TTL` | `86400` | seconds |

When `AGENT_TLS_DISABLE` is not set, all four cert/token vars are required.

## Next (on the gateway VM)

1. Implement the kernel `wg.Manager` (wgctrl + netlink + nft + FRR hooks).
2. systemd unit + auto-restart + health probe (design Section 11.2).
3. Provision via Ansible (`infra/ansible/`), issue mTLS certs from private CA.
