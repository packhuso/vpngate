// VPN Hub — typed mTLS client for the gateway agent (docs/vpnhub-agent.yaml).
// Used by the gateway worker. Security: mTLS client cert + Bearer token
// (design Section 6.1). One client instance per gateway.
import * as https from "node:https";
import { URL } from "node:url";

export interface GatewayClientOptions {
  /** e.g. https://gw1.vpnhub.example.com:9443/v1 */
  baseUrl: string;
  /** per-gateway bearer token (vpn_gateways.agent_token, decrypted) */
  bearerToken: string;
  /** client cert/key signed by our private CA (mTLS) + the CA to trust */
  clientCertPem: string;
  clientKeyPem: string;
  caPem: string;
  timeoutMs?: number;
}

export interface CreatePeerInput {
  peerId: string;
  publicKey: string;
  presharedKey?: string;
  privateIp: string;
  publicIps?: string[];
  /** bandwidth cap (kbit/s) for tc HTB shaping; omit/0 = unshaped */
  speedLimitKbit?: number;
}

export interface Peer {
  peerId: string;
  publicKey: string;
  privateIp: string;
  publicIps: string[];
  bytesRx: number;
  bytesTx: number;
  lastHandshake: string | null;
  lastEndpoint: string | null;
  status: "active" | "suspended";
  createdAt: string;
}

export class GatewayClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

export class GatewayClient {
  private readonly agent: https.Agent;
  private readonly base: URL;

  constructor(private readonly opts: GatewayClientOptions) {
    this.base = new URL(opts.baseUrl);
    this.agent = new https.Agent({
      cert: opts.clientCertPem,
      key: opts.clientKeyPem,
      ca: opts.caPem,
      keepAlive: true,
      minVersion: "TLSv1.3",
    });
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = new URL(this.base.pathname.replace(/\/$/, "") + path, this.base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.bearerToken}`,
      Accept: "application/json",
    };
    if (payload) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        url,
        { method, agent: this.agent, headers, timeout: this.opts.timeoutMs ?? 10_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString("utf8");
            if (status === 204) return resolve(undefined as T);
            let json: unknown = undefined;
            try {
              json = text ? JSON.parse(text) : undefined;
            } catch {
              /* non-JSON body */
            }
            if (status >= 200 && status < 300) return resolve(json as T);
            const e = json as { code?: string; message?: string } | undefined;
            reject(
              new GatewayClientError(
                status,
                e?.code ?? "AGENT_ERROR",
                e?.message ?? `agent returned ${status}`,
              ),
            );
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("gateway request timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  health() {
    return this.request<{ status: string; uptime: number; version: string }>(
      "GET",
      "/health",
    );
  }
  listPeers() {
    return this.request<{ interface: string; peers: Peer[] }>("GET", "/peers");
  }
  /** Lightweight per-peer traffic counters straight from the WG kernel
   *  (cumulative bytesRx/bytesTx). Meant for the periodic traffic sampler —
   *  callers compute deltas across ticks. Cheap: one `wg show wg0 dump`. */
  getPeerStats() {
    return this.request<{
      collectedAt: string;
      peers: {
        publicKey: string;
        bytesRx: number;
        bytesTx: number;
        lastHandshake: string | null;
        lastEndpoint: string | null;
      }[];
    }>("GET", "/stats/peers");
  }
  /** BGP session state + managed VPN-POOLS prefix-list contents. Read-only.
   *  Backs the admin Gateways page — one call per gateway to render the row. */
  getRoutingStatus() {
    return this.request<{
      collectedAt: string;
      bgpAvailable: boolean;
      localAs?: number;
      routerId?: string;
      neighbors: {
        neighbor: string;
        remoteAs: number;
        state: string;
        uptimeSeconds: number;
        pfxRcd: number;
        pfxSnt: number;
      }[];
      prefixListName: string;
      prefixListCount: number;
      prefixEntries: { seq: number; action: string; prefix: string; ge?: number; le?: number }[];
      warnings?: string[];
    }>("GET", "/routing/status");
  }
  createPeer(input: CreatePeerInput, idempotencyKey: string) {
    return this.request<{ status: string; peerId: string; interface: string }>(
      "POST",
      "/peers",
      input,
      idempotencyKey,
    );
  }
  getPeer(publicKey: string) {
    return this.request<Peer>("GET", `/peers/${encodeURIComponent(publicKey)}`);
  }
  updatePeerIps(
    publicKey: string,
    privateIp: string,
    publicIps: string[],
    idempotencyKey: string,
    speedLimitKbit?: number,
  ) {
    return this.request<{ status: string }>(
      "PATCH",
      `/peers/${encodeURIComponent(publicKey)}`,
      { privateIp, publicIps, speedLimitKbit },
      idempotencyKey,
    );
  }
  deletePeer(publicKey: string, idempotencyKey: string) {
    return this.request<void>(
      "DELETE",
      `/peers/${encodeURIComponent(publicKey)}`,
      undefined,
      idempotencyKey,
    );
  }
  /** Install (add=true) or remove (add=false) a blackhole route for a whole
   *  pool CIDR — drops traffic to unallocated IPs so they don't loop with the
   *  upstream router. */
  setBlackhole(cidr: string, add: boolean, idempotencyKey: string) {
    return this.request<{ status: string }>(
      add ? "POST" : "DELETE",
      "/routes/blackhole",
      { cidr },
      idempotencyKey,
    );
  }
  /** Issue (or reuse) an OpenVPN client cert for a CN — returns the CA +
   *  client cert/key + tls-crypt key for an inline .ovpn profile. OpenVPN
   *  backend only (WireGuard nodes return 501). */
  issueOvpnClientCert(cn: string, idempotencyKey: string) {
    return this.request<{
      caCert: string;
      clientCert: string;
      clientKey: string;
      tlsCryptKey: string;
    }>(
      "POST",
      `/ovpn/clients/${encodeURIComponent(cn)}/cert`,
      undefined,
      idempotencyKey,
    );
  }
  suspendPeer(publicKey: string, idempotencyKey: string) {
    return this.request<{ status: string }>(
      "POST",
      `/peers/${encodeURIComponent(publicKey)}/suspend`,
      undefined,
      idempotencyKey,
    );
  }
  resumePeer(publicKey: string, idempotencyKey: string) {
    return this.request<{ status: string }>(
      "POST",
      `/peers/${encodeURIComponent(publicKey)}/resume`,
      undefined,
      idempotencyKey,
    );
  }
  /** Atomically replace the contents of a managed FRR prefix-list (e.g.
   *  VPN-POOLS). Each entry: {prefix, ge?, le?}. ge/le mirror FRR semantics:
   *  ge=N → accept this prefix and any more-specific within it of length ≥ N. */
  syncFrrPrefixList(
    list: string,
    prefixes: { prefix: string; ge?: number; le?: number }[],
    idempotencyKey: string,
  ) {
    return this.request<{ status: string; list: string; entries: number }>(
      "POST",
      "/frr/prefix-list/sync",
      { list, prefixes },
      idempotencyKey,
    );
  }

  /** ICMP-ping a peer's tunnel-side IP from this gateway. Returns zeros on
   *  unreachable instead of throwing (server-side helper handles loss).
   *  count = 1..10 packets (default 4). */
  pingPeer(ip: string, count?: number) {
    return this.request<{
      ip: string;
      transmitted: number;
      received: number;
      lossPct: number;
      minMs: number | null;
      avgMs: number | null;
      maxMs: number | null;
    }>("POST", "/ping", { ip, count });
  }
}
