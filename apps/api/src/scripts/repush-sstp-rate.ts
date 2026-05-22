import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "@vpnhub/provisioning";
import { tierRateKbit } from "@vpnhub/billing";

// One-off: re-push every SSTP tunnel's peer state INCLUDING the tier rate, so the
// agent writes the .rate sidecar + applies tc shaping on the live ppp iface.
// Drift alone skips peers whose IPs already match, so it never adds shaping to an
// existing, correctly-routed peer — this forces it.
async function main() {
  const tunnels = await sql<{
    id: string; name: string; wg_public_key: string; private_ip: string;
    speed_tier: string; gw_id: string; hostname: string;
    agent_endpoint: string; agent_ca_cert: string; agent_token: string;
  }[]>`
    SELECT t.id, t.name, t.wg_public_key, host(t.private_ip) AS private_ip,
           t.speed_tier, g.id AS gw_id, g.hostname,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t
    JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.protocol = 'sstp' AND t.deleted_at IS NULL AND t.status = 'active'`;

  for (const t of tunnels) {
    const ips: { ip: string }[] = await sql`
      SELECT host(ip_address) AS ip FROM public_ips
      WHERE tunnel_id = ${t.id} AND status = 'allocated' ORDER BY ip_address`;
    const want = ips.map((r) => r.ip);
    const rate = tierRateKbit(t.speed_tier);
    const client = buildGatewayClient({
      agent_endpoint: t.agent_endpoint, agent_ca_cert: t.agent_ca_cert, agent_token: t.agent_token,
    } as any);
    await client.updatePeerIps(
      t.wg_public_key, t.private_ip, want,
      `repush-rate-${t.id}-${Date.now()}`, rate,
    );
    console.log(`✓ ${t.name} (${t.hostname}) tier=${t.speed_tier} rate=${rate}kbit ips=[${want.join(", ")}]`);
  }
  console.log(`done — ${tunnels.length} SSTP tunnel(s) re-pushed`);
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
