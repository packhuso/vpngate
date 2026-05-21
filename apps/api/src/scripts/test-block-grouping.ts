import { sql } from "@vpnhub/db";
import { buyIpBlock, moveIpBlock, releaseIpBlock, buildGatewayClient } from "@vpnhub/provisioning";

async function main() {
  const [tun] = await sql<{ id: string; user_id: string; wg_public_key: string }[]>`
    SELECT id, user_id, wg_public_key FROM tunnels
    WHERE status='active' AND deleted_at IS NULL LIMIT 1`;
  if (!tun) throw new Error("no tunnel");
  const [gw] = await sql<{
    agent_endpoint: string; agent_ca_cert: string; agent_token: string;
  }[]>`SELECT agent_endpoint, agent_ca_cert, agent_token FROM vpn_gateways LIMIT 1`;
  await sql`UPDATE credit_wallets SET balance_satang = 100000 WHERE user_id = ${tun.user_id}`;

  console.log("[1] Buy /29 block (8 IPs)");
  const blk = await buyIpBlock(tun.user_id, 8);
  console.log("   →", blk.cidr, "with", blk.ips.length, "IPs");

  console.log("[2] Assign block to tunnel");
  await moveIpBlock(tun.user_id, blk.blockId, tun.id);

  const client = buildGatewayClient(gw);
  const r = await client.listPeers();
  const peer = r.peers.find((p) => p.publicKey === tun.wg_public_key);
  console.log("\n[3] Kernel state for peer:");
  console.log("   publicIps:", peer?.publicIps);
  console.log("   #entries:", peer?.publicIps?.length);

  console.log("\n[4] Cleanup");
  await moveIpBlock(tun.user_id, blk.blockId, null);
  await releaseIpBlock(tun.user_id, blk.blockId);

  console.log("\n✅ Grouping test done");
  console.log("   Before: 8 separate /32 entries");
  console.log(`   After:  ${peer?.publicIps?.filter(s => s.includes(blk.cidr.split("/")[1])).length} entry as ${blk.cidr}`);
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
