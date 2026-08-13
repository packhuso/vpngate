// GRE tunnel provisioning + lifecycle. Mirrors provision.ts (WireGuard) but:
// - allocates a /30 point-to-point pair out of the gateway's private_subnet
//   (10.100.0.0/24 on vpnhub-gre-1 → .1/.2 for tunnel #1, .5/.6 for #2, …)
// - allocates a monotonic GRE key per gateway
// - stores the customer's endpoint as a DOMAIN and caches the current IP
//   so the health-check loop can re-resolve on tunnel-down
//
// Pushing to the agent happens OUT of the DB transaction (network side effect,
// deliberately not gated by the wallet-charge tx). Callers should call
// activateGreTunnel right after provisionGreTunnel; a crash between the two
// leaves a row in status='provisioning' that drift will reconcile.
import { promises as dns } from "dns";
import { sql } from "@vpnhub/db";
import { type SpeedTier } from "@vpnhub/billing";
import {
  InsufficientCredit,
  NoGatewayAvailable,
  NotFound,
  ValidationError,
} from "./errors";
import { speedTierPrice, tierAllowed } from "./pricing";
import { buildGatewayClient } from "./gateway-client";
import { TUNNEL_NAME_RE } from "./provision";

const DAY_MS = 86_400_000;
// GRE keys: reserve 1..999 for admin/testing, allocate customers from 1000+.
const GRE_KEY_MIN = 1000;

export interface CreateGreTunnelInput {
  userId: string;
  speedTier: SpeedTier;
  name: string;
  description?: string;
  /** customer's endpoint host (domain or IP). We resolve DNS at create time
   *  and cache the IP; the worker re-resolves on ping-fail. */
  remoteEndpointHost: string;
  gatewayHostname?: string;
}

export interface CreateGreTunnelResult {
  tunnelId: string;
  gatewayId: string;
  gatewayHostname: string;
  peerId: string;              // short id used as `gre-<peerId>` on the agent
  gatewayEndIp: string;        // our side of the point-to-point (10.100.0.1)
  customerEndIp: string;       // their side (10.100.0.2)
  pointToPointCidr: string;    // e.g. "10.100.0.0/30"
  greKey: number;
  remoteEndpointHost: string;
  remoteEndpointIp: string;    // resolved
}

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isPlausibleHost(s: string): boolean {
  if (!s || s.length > 253) return false;
  return HOST_RE.test(s) || IPV4_RE.test(s);
}

/** Resolve a domain (or return the IP if already numeric). Prefers IPv4;
 *  GRE is IPv4-only in this stack. Throws ValidationError on NXDOMAIN so
 *  a customer typo surfaces at create time, not silently 12 h later. */
export async function resolveHost(host: string): Promise<string> {
  if (IPV4_RE.test(host)) return host;
  try {
    const addrs = await dns.resolve4(host);
    if (!addrs.length) throw ValidationError(`${host} has no A record`);
    return addrs[0];
  } catch (e) {
    throw ValidationError(`cannot resolve ${host}: ${(e as Error).message}`);
  }
}

/** Allocate the next free /30 in the gateway's private_subnet by looking at
 *  used private_ip values. Returns the gateway-end address (odd offset:
 *  .1, .5, .9, …). Callers derive customer-end = gateway-end + 1. */
function allocateNextP2p(subnet: string, usedGwEnds: Set<string>): {
  gwEnd: string;
  custEnd: string;
  cidr: string;
} {
  // Parse "10.100.0.0/24" → base .0, host bits from 0..255 (for /24).
  const [base, maskStr] = subnet.split("/");
  const mask = Number(maskStr);
  if (mask > 30) throw ValidationError(`subnet /${mask} too small for GRE /30`);
  const octets = base.split(".").map(Number);
  const baseInt =
    (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
  const hostBits = 32 - mask;
  const size = 1 << hostBits;
  // Iterate /30 offsets: 0, 4, 8, 12, ... — skip the very first /30 whose
  // .1 collides with a common gateway .1 elsewhere (safety margin), so
  // start at offset 0 (.1/.2) — actually the whole /24 is ours; use it all.
  for (let off = 0; off + 3 < size; off += 4) {
    const gwEndInt = baseInt + off + 1; // .1 offset
    const gwEnd = intToIp(gwEndInt);
    if (usedGwEnds.has(gwEnd)) continue;
    const custEnd = intToIp(gwEndInt + 1); // .2 offset
    const cidr = `${intToIp(baseInt + off)}/30`;
    return { gwEnd, custEnd, cidr };
  }
  throw NoGatewayAvailable(); // subnet exhausted
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** peerId is a short URL-safe suffix baked into the gre-<peerId> interface
 *  name. Derived from the tunnel UUID (first 8 hex chars) — unique per gateway,
 *  human-readable in `ip link show`. */
export function peerIdFromTunnelId(tunnelId: string): string {
  return tunnelId.replace(/-/g, "").slice(0, 8);
}

export async function provisionGreTunnel(
  input: CreateGreTunnelInput,
): Promise<CreateGreTunnelResult> {
  if (!TUNNEL_NAME_RE.test(input.name ?? "")) {
    throw ValidationError("name must be 1-100 chars: letters, digits, - or _ only");
  }
  if (!isPlausibleHost(input.remoteEndpointHost)) {
    throw ValidationError("remoteEndpointHost must be a valid domain or IPv4");
  }
  const description = (input.description ?? "").slice(0, 300) || null;

  let price: number;
  try {
    price = await speedTierPrice(input.speedTier);
  } catch {
    throw ValidationError(`bad speedTier ${input.speedTier}`);
  }
  if (!(await tierAllowed("gre", input.speedTier))) {
    throw ValidationError(`gre ไม่เปิดขายแพ็กเกจ ${input.speedTier}`);
  }

  // Resolve DNS BEFORE the tx — validates the domain and captures the initial
  // IP so we can push to the agent immediately after commit.
  const initialIp = await resolveHost(input.remoteEndpointHost);

  return sql.begin(async (tx) => {
    const [wallet] = await tx`
      SELECT id, balance_satang FROM credit_wallets
      WHERE user_id = ${input.userId} FOR UPDATE`;
    if (!wallet) throw ValidationError("wallet not found for user");
    if (Number(wallet.balance_satang) < price) {
      throw InsufficientCredit(price, Number(wallet.balance_satang));
    }

    const dup = await tx`
      SELECT 1 FROM tunnels
      WHERE user_id = ${input.userId} AND lower(name) = lower(${input.name})
        AND deleted_at IS NULL LIMIT 1`;
    if (dup.length > 0) {
      throw ValidationError(`tunnel name "${input.name}" is already in use`);
    }

    // Pick a gateway that supports GRE. Order by current_tunnels for load-spread.
    const gwRows = input.gatewayHostname
      ? await tx`SELECT id, hostname, private_subnet::text AS subnet FROM vpn_gateways
                 WHERE hostname = ${input.gatewayHostname}
                   AND status = 'active' AND 'gre' = ANY(supported_protocols)
                 FOR UPDATE`
      : await tx`SELECT id, hostname, private_subnet::text AS subnet FROM vpn_gateways
                 WHERE status = 'active' AND current_tunnels < max_tunnels
                   AND 'gre' = ANY(supported_protocols)
                 ORDER BY current_tunnels ASC LIMIT 1 FOR UPDATE`;
    if (!gwRows[0]) throw NoGatewayAvailable();
    const gateway = gwRows[0] as { id: string; hostname: string; subnet: string };

    // Collect used gateway-end IPs on this gateway (all rows, incl. soft-deleted,
    // since UNIQUE(gateway_id, private_ip) has no deleted_at predicate).
    const usedRows = await tx<{ ip: string }[]>`
      SELECT host(private_ip) AS ip FROM tunnels WHERE gateway_id = ${gateway.id}`;
    const { gwEnd, custEnd, cidr } = allocateNextP2p(
      gateway.subnet,
      new Set(usedRows.map((r) => r.ip)),
    );

    // Allocate a monotonic GRE key per gateway (unique index enforces).
    const [maxKey] = await tx<{ k: number | null }[]>`
      SELECT COALESCE(MAX(gre_key), ${GRE_KEY_MIN - 1})::bigint AS k
      FROM tunnels WHERE gateway_id = ${gateway.id} AND gre_key IS NOT NULL`;
    const greKey = Number(maxKey.k) + 1;

    const nextBilling = new Date(Date.now() + 31 * DAY_MS);
    const nowIso = new Date().toISOString();

    const [tunnel] = await tx`
      INSERT INTO tunnels (user_id, gateway_id, name, description, protocol,
        speed_tier, price_satang, private_ip, status, next_billing_at,
        remote_endpoint_host, remote_endpoint_ip, remote_endpoint_resolved_at,
        gre_key)
      VALUES (${input.userId}, ${gateway.id}, ${input.name}, ${description},
        'gre', ${input.speedTier}, ${price}, ${gwEnd}, 'provisioning',
        ${nextBilling.toISOString()},
        ${input.remoteEndpointHost}, ${initialIp}, ${nowIso},
        ${greKey})
      RETURNING id`;
    const tunnelId = tunnel.id as string;

    const newBalance = Number(wallet.balance_satang) - price;
    await tx`
      UPDATE credit_wallets
      SET balance_satang = ${newBalance},
          lifetime_spent_satang = lifetime_spent_satang + ${price},
          version = version + 1
      WHERE id = ${wallet.id}`;

    await tx`
      INSERT INTO credit_transactions (user_id, wallet_id, type,
        amount_satang, balance_after, description, idempotency_key)
      VALUES (${input.userId}, ${wallet.id}, 'subscription_charge',
        ${-price}, ${newBalance},
        ${"GRE tunnel " + input.name + " (" + input.speedTier + ")"},
        ${"buy-gre-tunnel-" + tunnelId + "-" + Date.now()})`;

    await tx`UPDATE vpn_gateways SET current_tunnels = current_tunnels + 1
             WHERE id = ${gateway.id}`;

    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
        resource_id, success, metadata)
      VALUES ('system', ${input.userId}, 'tunnel.create', 'tunnel',
        ${tunnelId}, true,
        ${JSON.stringify({
          protocol: "gre",
          gateway: gateway.hostname,
          gatewayEndIp: gwEnd,
          customerEndIp: custEnd,
          greKey,
          remoteEndpointHost: input.remoteEndpointHost,
          remoteEndpointIp: initialIp,
          priceSatang: price,
        })}::jsonb)`;

    return {
      tunnelId,
      gatewayId: gateway.id,
      gatewayHostname: gateway.hostname,
      peerId: peerIdFromTunnelId(tunnelId),
      gatewayEndIp: gwEnd,
      customerEndIp: custEnd,
      pointToPointCidr: cidr,
      greKey,
      remoteEndpointHost: input.remoteEndpointHost,
      remoteEndpointIp: initialIp,
    };
  });
}

/** Push the newly-provisioned tunnel to its gateway agent. Called after
 *  provisionGreTunnel commits. On success, flips status to 'active'. */
export async function activateGreTunnel(tunnelId: string): Promise<void> {
  const [t] = await sql<
    {
      id: string;
      gateway_id: string;
      gw_end: string;
      gre_key: number;
      remote_ip: string;
      remote_host: string;
      subnet: string;
      hostname: string;
      agent_endpoint: string;
      agent_ca_cert: string;
      agent_token: string;
      pub_ip: string | null;
    }[]
  >`
    SELECT t.id::text, t.gateway_id::text, host(t.private_ip) AS gw_end,
           t.gre_key, host(t.remote_endpoint_ip) AS remote_ip,
           t.remote_endpoint_host AS remote_host,
           g.private_subnet::text AS subnet, g.hostname,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token,
           host(g.bgp_router_id) AS pub_ip
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId} AND t.protocol = 'gre'`;
  if (!t) throw NotFound(`gre tunnel ${tunnelId}`);

  const peerId = peerIdFromTunnelId(t.id);
  // Point-to-point /30: gwEnd is .1/.5/…; the /30 network aligns to gwEnd-1.
  const gwEndInt = ipToInt(t.gw_end);
  const cidr = `${intToIp(gwEndInt - 1)}/30`;
  const gwEndCidr = `${t.gw_end}/30`;
  const custEnd = intToIp(gwEndInt + 1);

  const publicIps = await sql<{ ip: string }[]>`
    SELECT host(ip_address) AS ip FROM public_ips
    WHERE tunnel_id = ${tunnelId} AND status = 'allocated'`;
  // Sold blocks route as their aggregate CIDR (matches the WG flow).
  const blockCidrs = (
    await sql<{ cidr: string }[]>`
      SELECT DISTINCT b.block::text AS cidr FROM ip_blocks b
      JOIN public_ips p ON p.block_id = b.id
      WHERE p.tunnel_id = ${tunnelId} AND p.status = 'allocated'`
  ).map((r) => r.cidr);
  const singleIps = publicIps
    .filter((p) => !cidr.includes(p.ip)) // paranoia — never route P2P /30 as customer IP
    .map((p) => `${p.ip}/32`);
  const routableCidrs = [...singleIps, ...blockCidrs].filter(
    (c) => c !== gwEndCidr && c !== `${custEnd}/32`,
  );

  const client = buildGatewayClient(t);
  await client.createGrePeer(
    {
      peerId,
      remoteIp: t.remote_ip,
      localIp: t.pub_ip ?? undefined,
      greKey: Number(t.gre_key),
      tunnelLocalIp: gwEndCidr,
      tunnelRemoteIp: custEnd,
      publicIps: routableCidrs,
    },
    `gre-activate-${tunnelId}`,
  );

  await sql`UPDATE tunnels SET status = 'active', updated_at = NOW() WHERE id = ${tunnelId}`;
}

function ipToInt(ip: string): number {
  const o = ip.split(".").map(Number);
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** Delete a GRE tunnel: DB soft-delete inside a tx (releases counter) then
 *  best-effort agent removal. Public IPs are unbound but not released
 *  (customer keeps ownership — matches WG delete flow). */
export async function deleteGreTunnel(tunnelId: string, userId: string): Promise<void> {
  const [t] = await sql<
    {
      id: string;
      gateway_id: string;
      hostname: string;
      agent_endpoint: string;
      agent_ca_cert: string;
      agent_token: string;
    }[]
  >`
    SELECT t.id::text, t.gateway_id::text, g.hostname,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId} AND t.user_id = ${userId}
      AND t.protocol = 'gre' AND t.deleted_at IS NULL`;
  if (!t) throw NotFound(`gre tunnel ${tunnelId}`);

  const peerId = peerIdFromTunnelId(t.id);

  await sql.begin(async (tx) => {
    await tx`UPDATE public_ips SET tunnel_id = NULL WHERE tunnel_id = ${tunnelId}`;
    await tx`UPDATE tunnels SET status = 'deleted', deleted_at = NOW(),
                                updated_at = NOW() WHERE id = ${tunnelId}`;
    await tx`UPDATE vpn_gateways SET current_tunnels = GREATEST(current_tunnels - 1, 0)
             WHERE id = ${t.gateway_id}`;
    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
        resource_id, success, metadata)
      VALUES ('user', ${userId}, 'tunnel.delete', 'tunnel', ${tunnelId}, true,
        ${JSON.stringify({ protocol: "gre" })}::jsonb)`;
  });

  // Best-effort agent removal — if the agent is down we've already flipped
  // the DB; drift can pick up the orphan interface later.
  try {
    await buildGatewayClient(t).deleteGrePeer(peerId, `gre-delete-${tunnelId}`);
  } catch (e) {
    console.error(`[gre-delete] agent DELETE ${peerId} failed: ${(e as Error).message}`);
  }
}

/** Re-resolve the tunnel's domain and, if changed, patch the agent's remote.
 *  Returns {changed} so the caller can log/audit. Safe to call unconditionally;
 *  a stable DNS returns changed=false with no side effect. */
export async function resolveGreEndpoint(tunnelId: string): Promise<{
  changed: boolean;
  oldIp: string;
  newIp: string;
}> {
  const [t] = await sql<
    {
      id: string;
      remote_host: string;
      remote_ip: string;
      agent_endpoint: string;
      agent_ca_cert: string;
      agent_token: string;
    }[]
  >`
    SELECT t.id::text, t.remote_endpoint_host AS remote_host,
           host(t.remote_endpoint_ip) AS remote_ip,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId} AND t.protocol = 'gre' AND t.deleted_at IS NULL`;
  if (!t) throw NotFound(`gre tunnel ${tunnelId}`);
  if (!t.remote_host) throw ValidationError("tunnel has no remote_endpoint_host");

  const newIp = await resolveHost(t.remote_host);
  const nowIso = new Date().toISOString();
  if (newIp === t.remote_ip) {
    await sql`UPDATE tunnels SET remote_endpoint_resolved_at = ${nowIso}
              WHERE id = ${tunnelId}`;
    return { changed: false, oldIp: t.remote_ip, newIp };
  }
  // IP changed: patch agent first (so no packet drops after we bump DB), then DB.
  const peerId = peerIdFromTunnelId(t.id);
  await buildGatewayClient(t).patchGrePeer(
    peerId,
    { remoteIp: newIp },
    `gre-reresolve-${tunnelId}-${Date.now()}`,
  );
  await sql`
    UPDATE tunnels SET remote_endpoint_ip = ${newIp},
                       remote_endpoint_resolved_at = ${nowIso},
                       updated_at = NOW()
    WHERE id = ${tunnelId}`;
  await sql`
    INSERT INTO audit_logs (actor_type, action, resource_type, resource_id,
      success, metadata)
    VALUES ('system', 'gre.endpoint_reresolved', 'tunnel', ${tunnelId}, true,
      ${JSON.stringify({ oldIp: t.remote_ip, newIp, host: t.remote_host })}::jsonb)`;
  return { changed: true, oldIp: t.remote_ip, newIp };
}
