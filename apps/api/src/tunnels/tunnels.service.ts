import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { sql } from "@vpnhub/db";
import { decryptSecret } from "@vpnhub/shared";
import {
  createTunnel,
  getOvpnConfig,
  getOvpnMikrotikScript,
  getSstpConfig,
  ensureSstpCredentials,
  getOnlineStatus,
  buildGatewayClient,
  type CreateTunnelInput,
} from "@vpnhub/provisioning";
import { gatewayQueue } from "./queue";

@Injectable()
export class TunnelsService {
  private readonly log = new Logger(TunnelsService.name);

  // design 7.1: atomic DB tx (commit) → THEN enqueue gateway job → 202.
  async provision(input: CreateTunnelInput) {
    const r = await createTunnel(input);
    await gatewayQueue().add(
      "provision-tunnel",
      { tunnelId: r.tunnelId },
      {
        jobId: `provision-${r.tunnelId}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
      },
    );
    this.log.log(`tunnel ${r.tunnelId} created → enqueued provision`);
    return { status: "provisioning", ...r };
  }

  // GET /v1/tunnels/options — protocols offerable right now (data-driven).
  // A protocol is available only when an active gateway can serve it; OpenVPN
  // lights up automatically the moment an OpenVPN node is registered.
  async availableProtocols() {
    const [r] = await sql<{ wg: boolean; ovpn: boolean; sstp: boolean }[]>`
      SELECT
        COALESCE(bool_or(wg_public_key IS NOT NULL), false) AS wg,
        COALESCE(bool_or(ovpn_endpoint IS NOT NULL), false) AS ovpn,
        COALESCE(bool_or(sstp_endpoint IS NOT NULL), false) AS sstp
      FROM vpn_gateways WHERE status = 'active'`;
    const protocols: string[] = [];
    if (r?.wg) protocols.push("wireguard");
    if (r?.ovpn) protocols.push("openvpn");
    if (r?.sstp) protocols.push("sstp");
    return {
      protocols,
      tiers: [
        { value: "tier_100mb", label: "100 Mbps", priceSatang: 10000 },
        { value: "tier_500mb", label: "500 Mbps", priceSatang: 20000 },
        { value: "tier_1gb", label: "1 Gbps", priceSatang: 30000 },
      ],
    };
  }

  async listForUser(userId: string) {
    const rows = await sql<
      {
        id: string;
        name: string;
        description: string | null;
        speed_tier: string;
        status: string;
        protocol: string;
        private_ip: string;
        created_at: Date;
      }[]
    >`
      SELECT id, name, description, speed_tier, status, protocol,
             host(private_ip) AS private_ip, created_at
      FROM tunnels
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY created_at DESC`;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const ipRows = await sql<{ tunnel_id: string; ip: string; block_id: string | null }[]>`
      SELECT tunnel_id, host(ip_address) AS ip, block_id::text AS block_id
      FROM public_ips
      WHERE tunnel_id = ANY(${ids}::uuid[]) AND status = 'allocated'
      ORDER BY ip_address`;
    const byTunnel = new Map<string, { ip: string; blockId: string | null }[]>();
    for (const r of ipRows) {
      const list = byTunnel.get(r.tunnel_id) ?? [];
      list.push({ ip: r.ip, blockId: r.block_id });
      byTunnel.set(r.tunnel_id, list);
    }
    const online = await getOnlineStatus(ids);
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      speedTier: t.speed_tier,
      status: t.status,
      protocol: t.protocol,
      privateIp: t.private_ip,
      createdAt: t.created_at,
      publicIps: byTunnel.get(t.id) ?? [],
      online: online[t.id]?.online ?? false,
      lastSeenAt: online[t.id]?.lastSeenAt ?? null,
    }));
  }

  // GET /v1/tunnels/:id/config?format=wireguard|mikrotik|openvpn
  // SSTP credentials (server/port/username/password), issuing + caching them on
  // first call. Lets the portal show creds on first page load (no .rsc click).
  async sstpCredentials(userId: string, tunnelId: string) {
    return ensureSstpCredentials(userId, tunnelId);
  }

  // Server-side connectivity test: ping the tunnel's peer (client) from the
  // gateway VM that hosts it, over the tunnel itself (private IP), not the
  // internet. Tells the customer "is my VPN client actually online and reachable
  // from the server end?" Goes through the gateway agent's /v1/ping endpoint.
  async pingTunnel(userId: string, tunnelId: string, count?: number) {
    const [t] = await sql<{
      private_ip: string;
      agent_endpoint: string;
      agent_ca_cert: string;
      agent_token: string;
    }[]>`
      SELECT host(t.private_ip) AS private_ip,
             g.agent_endpoint, g.agent_ca_cert, g.agent_token
      FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
      WHERE t.id = ${tunnelId} AND t.user_id = ${userId}
        AND t.deleted_at IS NULL`;
    if (!t) throw new NotFoundException("tunnel not found");
    const gw = buildGatewayClient({
      agent_endpoint: t.agent_endpoint,
      agent_ca_cert: t.agent_ca_cert,
      agent_token: t.agent_token,
    });
    try {
      const r = await gw.pingPeer(t.private_ip, count);
      return { results: [r] };
    } catch (e) {
      // Agent unreachable / errored — surface as a zero-loss-all-loss row so
      // the UI shows "ไม่ตอบ" instead of a generic 500.
      return {
        results: [{
          ip: t.private_ip, transmitted: 4, received: 0, lossPct: 100,
          minMs: null, avgMs: null, maxMs: null,
          error: (e as Error).message,
        }],
      };
    }
  }

  // Private key is decrypted on demand only (encrypted at rest, design §6.5).
  async getConfig(
    userId: string,
    tunnelId: string,
    format: "wireguard" | "mikrotik" | "openvpn" | "sstp" = "wireguard",
  ) {
    // OpenVPN profiles assemble in the provisioning package (lazy cert issuance
    // via the gateway agent + inline .ovpn build).
    if (format === "openvpn") {
      return getOvpnConfig(userId, tunnelId);
    }
    if (format === "sstp") {
      return getSstpConfig(userId, tunnelId);
    }
    // Mikrotik script differs per protocol — branch before the WG-only query.
    if (format === "mikrotik") {
      const [p] = await sql<{ protocol: string }[]>`
        SELECT protocol FROM tunnels
        WHERE id = ${tunnelId} AND user_id = ${userId} AND deleted_at IS NULL`;
      if (p?.protocol === "openvpn") {
        return getOvpnMikrotikScript(userId, tunnelId);
      }
      if (p?.protocol === "sstp") {
        return getSstpConfig(userId, tunnelId);
      }
    }
    const [t] = await sql<
      {
        name: string;
        status: string;
        private_ip: string;
        wg_private_key_encrypted: string;
        gw_pub: string;
        wg_endpoint: string;
        wg_port: number;
        private_subnet: string;
      }[]
    >`
      SELECT t.name, t.status, host(t.private_ip) AS private_ip,
             t.wg_private_key_encrypted,
             g.wg_public_key AS gw_pub, g.wg_endpoint, g.wg_port,
             g.private_subnet::text AS private_subnet
      FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
      WHERE t.id = ${tunnelId} AND t.user_id = ${userId}
        AND t.deleted_at IS NULL`;
    if (!t) throw new NotFoundException("tunnel not found");
    if (t.status === "provisioning") {
      throw new BadRequestException("tunnel is still provisioning, try again in a moment");
    }

    // Single IPs route as /32; a sold block routes as its CIDR (e.g. a /25),
    // NOT 128 separate /32s — compact, correct, and keeps the config/QR small.
    const singles = (
      await sql<{ ip: string }[]>`
        SELECT host(ip_address) AS ip FROM public_ips
        WHERE tunnel_id = ${tunnelId} AND block_id IS NULL AND status = 'allocated'
        ORDER BY ip_address`
    ).map((r) => r.ip);
    const blockCidrs = (
      await sql<{ cidr: string }[]>`
        SELECT DISTINCT b.block::text AS cidr
        FROM ip_blocks b JOIN public_ips p ON p.block_id = b.id
        WHERE p.tunnel_id = ${tunnelId} AND p.status = 'allocated'
        ORDER BY 1`
    ).map((r) => r.cidr);

    // Client model: wg0 carries ONLY the tunnel-internal private IP. Each
    // assigned public IP/block is routed by the gateway to this peer; the
    // customer adds it to their LOOPBACK to actually use it (bind/listen). This
    // keeps wg0 minimal and gives the customer explicit control over which
    // traffic sources from the public IP (via standard policy routing).
    const routable = [...singles.map((ip) => `${ip}/32`), ...blockCidrs];
    const allowedIPs = [t.private_subnet, ...routable].join(", ");

    const privateKey = decryptSecret(t.wg_private_key_encrypted);
    const safeName = t.name.replace(/[^A-Za-z0-9_-]/g, "_") || "tunnel";

    if (format === "mikrotik") {
      const conf = buildMikrotikScript({
        privateKey,
        gwPub: t.gw_pub,
        endpointHost: t.wg_endpoint,
        endpointPort: t.wg_port,
        privateIp: t.private_ip,
        privateSubnet: t.private_subnet,
        singles,
        blockCidrs,
      });
      return { filename: `${safeName}.mikrotik.rsc`, conf };
    }

    const conf =
      `[Interface]\n` +
      `PrivateKey = ${privateKey}\n` +
      `Address = ${t.private_ip}/32\n` +
      `\n` +
      `[Peer]\n` +
      `PublicKey = ${t.gw_pub}\n` +
      `Endpoint = ${t.wg_endpoint}:${t.wg_port}\n` +
      `AllowedIPs = ${allowedIPs}\n` +
      `PersistentKeepalive = 25\n`;

    return { filename: `${safeName}.conf`, conf };
  }
}

interface MikrotikArgs {
  privateKey: string;
  gwPub: string;
  endpointHost: string;
  endpointPort: number;
  privateIp: string;
  privateSubnet: string;
  singles: string[]; // bare IPs → /32
  blockCidrs: string[]; // sold blocks → routed as their CIDR
}

/** RouterOS 7.x script — paste into the Mikrotik terminal (or `/import` the file).
 *  Pure-routing client: public IP held on a bridge "lo-vpnhub"; policy routing
 *  sources outbound from the public IP via wg-vpnhub. */
function buildMikrotikScript(a: MikrotikArgs): string {
  const ifName = "wg-vpnhub";
  const loName = "lo-vpnhub";
  const tableName = "vpnhub-egress";
  // allowed-address on the peer = which SOURCE IPs we accept from the gateway.
  // Use 0.0.0.0/0 so traffic from any internet source destined to our public
  // IP can be decrypted (gateway forwards inbound from arbitrary internet hosts).
  // Routing on the Mikrotik side is controlled separately via /ip/route below
  // (RouterOS does NOT auto-derive routes from allowed-address, unlike wg-quick).
  // routable source prefixes the customer owns (singles as /32, blocks as CIDR)
  const routable = [...a.singles.map((ip) => `${ip}/32`), ...a.blockCidrs];
  const allowed = routable.length > 0 ? "0.0.0.0/0" : a.privateSubnet;

  const wgIface =
    `/interface/wireguard\n` +
    `add name=${ifName} listen-port=13231 \\\n` +
    `    private-key="${a.privateKey}"\n` +
    `\n`;

  const wgPeer =
    `/interface/wireguard/peers\n` +
    `add interface=${ifName} name=vpnhub-gw \\\n` +
    `    public-key="${a.gwPub}" \\\n` +
    `    endpoint-address=${a.endpointHost} endpoint-port=${a.endpointPort} \\\n` +
    `    allowed-address=${allowed} \\\n` +
    `    persistent-keepalive=25s\n` +
    `\n`;

  const prefix = a.privateSubnet.split("/")[1] || "24";
  const privAddr =
    `/ip/address\n` +
    `add interface=${ifName} address=${a.privateIp}/${prefix}\n` +
    `\n`;

  // Clamp TCP MSS to the WireGuard MTU (1420 → MSS 1380) so PMTUD black-holes
  // don't hang TCP / break page loads through the tunnel. SYN only, only when
  // the announced MSS is larger than the cap (tcp-mss=1381-65535).
  const mssClamp =
    `/ip/firewall/mangle\n` +
    `add chain=forward action=change-mss new-mss=1380 passthrough=yes \\\n` +
    `    protocol=tcp tcp-flags=syn tcp-mss=1381-65535 out-interface=${ifName} \\\n` +
    `    comment="vpnhub: clamp MSS (PMTUD-safe)"\n` +
    `add chain=forward action=change-mss new-mss=1380 passthrough=yes \\\n` +
    `    protocol=tcp tcp-flags=syn tcp-mss=1381-65535 in-interface=${ifName} \\\n` +
    `    comment="vpnhub: clamp MSS (PMTUD-safe)"\n` +
    `\n`;

  if (routable.length === 0) {
    return wgIface + wgPeer + privAddr + mssClamp;
  }

  // Hold each owned prefix on the loopback bridge: singles as /32, a sold block
  // as its CIDR (one line for the whole block instead of N×/32).
  const loBridge =
    `/interface/bridge\n` +
    `add name=${loName}\n` +
    `\n` +
    `/ip/address\n` +
    a.singles.map((ip) => `add interface=${loName} address=${ip}/32\n`).join("") +
    a.blockCidrs.map((c) => `add interface=${loName} address=${c}\n`).join("") +
    `\n`;

  const polRouting =
    `/routing/table\n` +
    `add fib name=${tableName}\n` +
    `\n` +
    `/ip/route\n` +
    `add gateway=${ifName} routing-table=${tableName}\n` +
    `\n` +
    `/routing/rule\n` +
    routable
      .map((src) => `add src-address=${src} action=lookup table=${tableName}\n`)
      .join("") +
    `\n`;
  return wgIface + wgPeer + privAddr + loBridge + polRouting + mssClamp;
}
