// GRE-specific drift reconcile. Runs alongside the WG drift on each active
// gateway. For each active GRE tunnel in DB:
//   - if agent has no matching gre-<peerId>: re-push (activateGreTunnel).
//     This is what fires after a gateway reboot — kernel tunnels don't
//     persist across boots, but our DB row + activate flow rebuild them.
//   - if agent has a matching interface but different remoteIp/publicIps:
//     patch the agent to match DB (control plane wins).
// For agent-side interfaces with no matching DB row:
//   - delete (orphan cleanup — customer was deleted or wrong gateway).
import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "./gateway-client";
import { activateGreTunnel, peerIdFromTunnelId } from "./gre";

export interface GreDriftReport {
  gatewayId: string;
  gatewayHostname: string;
  reactivated: string[]; // tunnel IDs re-pushed to agent (missing interfaces)
  patched: string[];     // tunnel IDs whose remote/publicIps drifted
  deletedOrphans: string[]; // peerIds removed from agent (no DB row)
  alreadyOk: number;
  errors: { tunnelId?: string; peerId?: string; message: string }[];
}

export async function reconcileGreOnGateway(gatewayId: string): Promise<GreDriftReport> {
  const [gw] = await sql<{
    id: string; hostname: string;
    agent_endpoint: string; agent_ca_cert: string; agent_token: string;
    supported_protocols: string[];
  }[]>`
    SELECT id::text, hostname, agent_endpoint, agent_ca_cert, agent_token,
           supported_protocols
    FROM vpn_gateways WHERE id = ${gatewayId} AND status = 'active'`;
  if (!gw) throw new Error(`gateway ${gatewayId} not active`);

  const report: GreDriftReport = {
    gatewayId: gw.id, gatewayHostname: gw.hostname,
    reactivated: [], patched: [], deletedOrphans: [], alreadyOk: 0, errors: [],
  };

  // Skip nodes that don't run GRE — nothing to reconcile.
  if (!gw.supported_protocols?.includes("gre")) return report;

  const client = buildGatewayClient(gw);
  let kernel: { peers: { peerId: string; remoteIp: string; publicIps: string[] }[] };
  try {
    kernel = await client.listGrePeers();
  } catch (e) {
    report.errors.push({ message: `list gre peers: ${(e as Error).message}` });
    return report;
  }
  const kernelByPeer = new Map(kernel.peers.map((p) => [p.peerId, p]));

  // DB tunnels + their expected public IPs (single /32s plus block CIDRs, in
  // sorted order for stable comparison).
  const dbRows = await sql<{
    id: string; gw_end: string; remote_ip: string;
    public_ips: string[];
  }[]>`
    SELECT t.id::text, host(t.private_ip) AS gw_end,
           host(t.remote_endpoint_ip) AS remote_ip,
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
    WHERE t.gateway_id = ${gatewayId} AND t.protocol = 'gre'
      AND t.deleted_at IS NULL AND t.status = 'active'`;

  const dbPeerIds = new Set<string>();
  for (const t of dbRows) {
    const peerId = peerIdFromTunnelId(t.id);
    dbPeerIds.add(peerId);
    const k = kernelByPeer.get(peerId);
    if (!k) {
      // Missing on agent → re-activate (typical after gateway reboot).
      try {
        await activateGreTunnel(t.id);
        report.reactivated.push(t.id);
      } catch (e) {
        report.errors.push({ tunnelId: t.id, message: `reactivate: ${(e as Error).message}` });
      }
      continue;
    }
    // Present — diff. Only trigger a PATCH if there's an actual delta so we
    // don't hammer the agent every 10 minutes.
    const wantIps = [...t.public_ips].sort();
    const haveIps = [...k.publicIps].sort();
    const ipsChanged =
      wantIps.length !== haveIps.length ||
      wantIps.some((v, i) => v !== haveIps[i]);
    const remoteChanged = k.remoteIp !== t.remote_ip;
    if (!ipsChanged && !remoteChanged) {
      report.alreadyOk++;
      continue;
    }
    try {
      const patch: { remoteIp?: string; publicIps?: string[] } = {};
      if (remoteChanged) patch.remoteIp = t.remote_ip;
      if (ipsChanged) patch.publicIps = wantIps;
      await client.patchGrePeer(peerId, patch, `gre-drift-${t.id}-${Date.now()}`);
      report.patched.push(t.id);
    } catch (e) {
      report.errors.push({ tunnelId: t.id, message: `patch: ${(e as Error).message}` });
    }
  }

  // Orphans on agent — customer deleted or wrong gateway. Remove.
  for (const p of kernel.peers) {
    if (dbPeerIds.has(p.peerId)) continue;
    try {
      await client.deleteGrePeer(p.peerId, `gre-drift-orphan-${p.peerId}-${Date.now()}`);
      report.deletedOrphans.push(p.peerId);
    } catch (e) {
      report.errors.push({ peerId: p.peerId, message: `delete orphan: ${(e as Error).message}` });
    }
  }
  return report;
}

export async function reconcileGreAllGateways(): Promise<GreDriftReport[]> {
  const gws = await sql<{ id: string }[]>`
    SELECT id FROM vpn_gateways
    WHERE status = 'active' AND 'gre' = ANY(supported_protocols)`;
  const out: GreDriftReport[] = [];
  for (const g of gws) {
    try {
      out.push(await reconcileGreOnGateway(g.id));
    } catch (e) {
      out.push({
        gatewayId: g.id, gatewayHostname: "?",
        reactivated: [], patched: [], deletedOrphans: [], alreadyOk: 0,
        errors: [{ message: (e as Error).message }],
      });
    }
  }
  return out;
}
