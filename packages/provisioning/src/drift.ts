// Drift detection (design §7.1): reconcile DB ↔ gateway kernel.
// Per gateway: pull current peers from agent; push missing (active in DB,
// absent in kernel); delete orphans (in kernel, not in DB).
import { sql } from "@vpnhub/db";
import { tierRateKbit } from "@vpnhub/billing";
import { buildGatewayClient } from "./gateway-client";
import { parseCidr } from "./sale-plans";

export interface DriftReport {
  gatewayId: string;
  gatewayHostname: string;
  pushed: string[]; // tunnelIds re-pushed into kernel
  deletedOrphans: string[]; // publicKeys removed from kernel
  alreadyOk: number;
  errors: { tunnelId?: string; publicKey?: string; message: string }[];
}

interface GwRow {
  id: string;
  hostname: string;
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string;
}

interface DbTunnel {
  id: string;
  wg_public_key: string;
  private_ip: string;
  status: string;
  speed_tier: string;
  public_ips: string[];
}

export async function reconcileGateway(gatewayId: string): Promise<DriftReport> {
  const [gw] = await sql<GwRow[]>`
    SELECT id, hostname, agent_endpoint, agent_ca_cert, agent_token
    FROM vpn_gateways WHERE id = ${gatewayId} AND status = 'active'`;
  if (!gw) throw new Error(`gateway ${gatewayId} not active or not found`);

  const report: DriftReport = {
    gatewayId: gw.id,
    gatewayHostname: gw.hostname,
    pushed: [],
    deletedOrphans: [],
    alreadyOk: 0,
    errors: [],
  };

  const client = buildGatewayClient(gw);

  // What the kernel currently holds, keyed by publicKey.
  const kernel = await client.listPeers();
  const kernelByPk = new Map(kernel.peers.map((p) => [p.publicKey, p]));

  // What the DB says SHOULD be in the kernel for this gateway. Singles → /32;
  // block members → one row per block as the block's CIDR (e.g. /30). This
  // matches the grouped form pushed by moveIp/moveIpBlock.
  const dbTunnels = await sql<DbTunnel[]>`
    SELECT t.id, t.wg_public_key, host(t.private_ip) AS private_ip, t.status,
           t.speed_tier,
           COALESCE(cidrs.cidrs, ARRAY[]::text[]) AS public_ips
    FROM tunnels t
    LEFT JOIN LATERAL (
      SELECT array_agg(cidr ORDER BY cidr) AS cidrs
      FROM (
        SELECT host(p.ip_address) || '/32' AS cidr
        FROM public_ips p
        WHERE p.tunnel_id = t.id AND p.status = 'allocated' AND p.block_id IS NULL
        UNION
        SELECT DISTINCT b.block::text AS cidr
        FROM public_ips p JOIN ip_blocks b ON b.id = p.block_id
        WHERE p.tunnel_id = t.id AND p.status = 'allocated'
      ) c
    ) cidrs ON true
    WHERE t.gateway_id = ${gw.id}
      AND t.deleted_at IS NULL
      AND t.status = 'active'`;
  const dbByPk = new Map(dbTunnels.map((t) => [t.wg_public_key, t]));

  // 1. For each DB tunnel: re-push if missing, OR reconcile allowed-IPs if
  //    present but stale (DB ↔ kernel diff). Either case is a "pushed" event.
  for (const t of dbTunnels) {
    const want = (t.public_ips ?? []).filter((x) => x).sort();
    const kp = kernelByPk.get(t.wg_public_key);
    if (!kp) {
      // missing → createPeer with full allowed-IPs
      try {
        await client.createPeer(
          {
            peerId: t.id,
            publicKey: t.wg_public_key,
            privateIp: t.private_ip,
            publicIps: want,
            speedLimitKbit: tierRateKbit(t.speed_tier),
          },
          `drift-push-${t.id}-${Date.now()}`,
        );
        report.pushed.push(t.id);
        await sql`
          INSERT INTO audit_logs (actor_type, action, resource_type,
            resource_id, success, metadata)
          VALUES ('system', 'tunnel.drift_repush', 'tunnel', ${t.id}, true,
            ${JSON.stringify({ gateway: gw.hostname, reason: "missing" })}::jsonb)`;
      } catch (e) {
        report.errors.push({ tunnelId: t.id, message: (e as Error).message });
      }
      continue;
    }
    // present → diff publicIps + privateIp
    const have = [...(kp.publicIps ?? [])].sort();
    const privateOk = kp.privateIp === t.private_ip;
    const ipsEqual =
      have.length === want.length && have.every((v, i) => v === want[i]);
    if (privateOk && ipsEqual) {
      report.alreadyOk++;
      continue;
    }
    try {
      await client.updatePeerIps(
        t.wg_public_key,
        t.private_ip,
        want,
        `drift-reip-${t.id}-${Date.now()}`,
        tierRateKbit(t.speed_tier),
      );
      report.pushed.push(t.id);
      await sql`
        INSERT INTO audit_logs (actor_type, action, resource_type,
          resource_id, success, metadata)
        VALUES ('system', 'tunnel.drift_reip', 'tunnel', ${t.id}, true,
          ${JSON.stringify({
            gateway: gw.hostname,
            reason: privateOk ? "stale public_ips" : "stale private_ip",
            kernelHad: have,
            dbWants: want,
          })}::jsonb)`;
    } catch (e) {
      report.errors.push({ tunnelId: t.id, message: (e as Error).message });
    }
  }

  // 2. In kernel but not in active-DB → orphan, delete from kernel.
  for (const pk of kernelByPk.keys()) {
    if (dbByPk.has(pk)) continue;
    try {
      await client.deletePeer(pk, `drift-orphan-${Date.now()}`);
      report.deletedOrphans.push(pk);
      await sql`
        INSERT INTO audit_logs (actor_type, action, resource_type,
          success, metadata)
        VALUES ('system', 'gateway.drift_orphan_removed', 'gateway', true,
          ${JSON.stringify({ gateway: gw.hostname, publicKey: pk })}::jsonb)`;
    } catch (e) {
      report.errors.push({ publicKey: pk, message: (e as Error).message });
    }
  }

  // 3. Ensure a blackhole route exists for every active pool CIDR (self-heal
  //    across agent restarts). Idempotent on the agent side (RouteReplace).
  const pools = await sql<{ block: string }[]>`
    SELECT block::text AS block FROM ip_pool`;
  for (const p of pools) {
    try {
      // normalize to network/prefix (parseCidr validates the form)
      parseCidr(p.block);
      await client.setBlackhole(p.block, true, `drift-blackhole-${Date.now()}`);
    } catch (e) {
      report.errors.push({ message: `blackhole ${p.block}: ${(e as Error).message}` });
    }
  }

  return report;
}

export async function reconcileAllGateways(): Promise<DriftReport[]> {
  const gws = await sql<{ id: string }[]>`
    SELECT id FROM vpn_gateways WHERE status = 'active'`;
  const reports: DriftReport[] = [];
  for (const g of gws) {
    try {
      reports.push(await reconcileGateway(g.id));
    } catch (e) {
      reports.push({
        gatewayId: g.id,
        gatewayHostname: "?",
        pushed: [],
        deletedOrphans: [],
        alreadyOk: 0,
        errors: [{ message: (e as Error).message }],
      });
    }
  }
  return reports;
}
