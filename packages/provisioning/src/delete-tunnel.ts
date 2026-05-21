// deleteTunnel — customer-initiated tunnel removal (no refund, design MVP).
// Requires the user to detach ALL public IPs first (unassign or move) before
// the tunnel can be deleted. Once detached, deleteTunnel removes the peer
// from the gateway and soft-deletes the tunnel row.
import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "./gateway-client";
import { NotFound, ValidationError } from "./errors";

export interface DeleteTunnelResult {
  tunnelId: string;
}

export async function deleteTunnel(
  tunnelId: string,
  userId: string,
): Promise<DeleteTunnelResult> {
  const phase1 = await sql.begin(async (tx) => {
    const tRows: {
      id: string;
      gateway_id: string;
      wg_public_key: string;
      private_ip: string;
      status: string;
    }[] = await tx`
      SELECT id, gateway_id, wg_public_key, host(private_ip) AS private_ip,
             status
      FROM tunnels
      WHERE id = ${tunnelId} AND user_id = ${userId} AND deleted_at IS NULL`;
    const t = tRows[0];
    if (!t) throw NotFound("tunnel");

    const ipRows: { ip: string; block_id: string | null }[] = await tx`
      SELECT host(ip_address) AS ip, block_id::text AS block_id
      FROM public_ips
      WHERE tunnel_id = ${tunnelId} AND status = 'allocated'`;
    if (ipRows.length > 0) {
      const singles = ipRows.filter((r) => !r.block_id).length;
      const blocks = new Set(
        ipRows.filter((r) => r.block_id).map((r) => r.block_id),
      ).size;
      const parts: string[] = [];
      if (singles) parts.push(`${singles} single IP(s)`);
      if (blocks) parts.push(`${blocks} block(s)`);
      throw ValidationError(
        `ปลด ${parts.join(" + ")} ออกจาก tunnel นี้ก่อนถึงจะลบได้`,
      );
    }

    await tx`UPDATE tunnels SET status = 'deleted', deleted_at = NOW()
             WHERE id = ${tunnelId}`;
    await tx`UPDATE vpn_gateways
             SET current_tunnels = GREATEST(current_tunnels - 1, 0)
             WHERE id = ${t.gateway_id}`;

    await tx`INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
               resource_id, success, metadata)
             VALUES ('user', ${userId}, 'tunnel.delete', 'tunnel', ${tunnelId},
               true, ${JSON.stringify({ noRefund: true })}::jsonb)`;

    const gwRows: {
      agent_endpoint: string;
      agent_ca_cert: string;
      agent_token: string;
    }[] = await tx`SELECT agent_endpoint, agent_ca_cert, agent_token
                    FROM vpn_gateways WHERE id = ${t.gateway_id}`;
    return { wgPub: t.wg_public_key, gw: gwRows[0] };
  });

  await buildGatewayClient(phase1.gw)
    .deletePeer(phase1.wgPub, `delete-tunnel-${tunnelId}-${Date.now()}`)
    .catch((e) => {
      // gateway-side cleanup is recoverable via drift reconcile; don't fail
      // the user-facing delete after DB has committed.
      console.error(`[deleteTunnel] gateway deletePeer failed for ${tunnelId}:`, e);
    });

  return { tunnelId };
}
