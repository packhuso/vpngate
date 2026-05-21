// activateTunnel / removeTunnel — drive the real gateway agent over mTLS+Bearer
// (design Section 7.1 worker step). Used by worker-gateway and E2E.
import { sql } from "@vpnhub/db";
import { tierRateKbit } from "@vpnhub/billing";
import { buildGatewayClient } from "./gateway-client";
import { NotFound } from "./errors";

interface GwRow {
  id: string;
  status: string;
  speed_tier: string;
  wg_public_key: string;
  private_ip: string;
  gateway_id: string;
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string;
}

async function loadTunnelWithGateway(tunnelId: string): Promise<GwRow | null> {
  const rows = await sql<GwRow[]>`
    SELECT t.id, t.status, t.speed_tier, t.wg_public_key,
           host(t.private_ip) AS private_ip,
           t.gateway_id, g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId}`;
  return rows[0] ?? null;
}

const clientFor = buildGatewayClient;

export async function activateTunnel(tunnelId: string) {
  const row = await loadTunnelWithGateway(tunnelId);
  if (!row) throw NotFound("tunnel");
  if (row.status === "active") return { tunnelId, alreadyActive: true };

  await clientFor(row).createPeer(
    {
      peerId: tunnelId,
      publicKey: row.wg_public_key,
      privateIp: row.private_ip,
      publicIps: [],
      speedLimitKbit: tierRateKbit(row.speed_tier),
    },
    `provision-${tunnelId}`,
  );

  await sql`UPDATE tunnels SET status = 'active' WHERE id = ${tunnelId}`;
  await sql`
    INSERT INTO audit_logs (actor_type, action, resource_type, resource_id,
      success)
    VALUES ('system', 'tunnel.activate', 'tunnel', ${tunnelId}, true)`;
  return { tunnelId, alreadyActive: false };
}

export async function removeTunnel(tunnelId: string) {
  const row = await loadTunnelWithGateway(tunnelId);
  if (!row) return { tunnelId, notFound: true };

  await clientFor(row).deletePeer(row.wg_public_key, `remove-${tunnelId}`);

  await sql.begin(async (tx) => {
    await tx`UPDATE tunnels SET status = 'deleted', deleted_at = NOW()
             WHERE id = ${tunnelId}`;
    await tx`UPDATE vpn_gateways
             SET current_tunnels = GREATEST(current_tunnels - 1, 0)
             WHERE id = ${row.gateway_id}`;
    await tx`INSERT INTO audit_logs (actor_type, action, resource_type,
               resource_id, success)
             VALUES ('system', 'tunnel.delete', 'tunnel', ${tunnelId}, true)`;
  });
  return { tunnelId, removed: true };
}
