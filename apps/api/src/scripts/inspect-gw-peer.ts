import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "@vpnhub/provisioning";

async function main() {
  const [gw] = await sql<{
    id: string; hostname: string;
    agent_endpoint: string; agent_ca_cert: string; agent_token: string;
  }[]>`SELECT id, hostname, agent_endpoint, agent_ca_cert, agent_token FROM vpn_gateways LIMIT 1`;
  if (!gw) throw new Error("no gateway");
  console.log("gateway:", gw.hostname, gw.agent_endpoint);

  const client = buildGatewayClient(gw);
  const r = await client.listPeers();
  const peers = r.peers ?? [];
  console.log(`\n=== Peers in kernel (${r.interface ?? "wg0"}) ===`);
  for (const p of peers) {
    console.log(`peer ${p.publicKey.slice(0, 20)}...`);
    console.log(`  privateIp: ${p.privateIp}`);
    console.log(`  publicIps: ${(p.publicIps ?? []).join(", ") || "(none)"}`);
    console.log(`  status: ${p.status}, lastHandshake: ${p.lastHandshake ?? "never"}`);
  }

  console.log("\n=== Expected (DB) for tunnel that owns 104.238.11.10 ===");
  const tRows: { id: string; name: string; wg_public_key: string; private_ip: string }[] =
    await sql`SELECT t.id, t.name, t.wg_public_key, host(t.private_ip) AS private_ip
              FROM tunnels t JOIN public_ips p ON p.tunnel_id = t.id
              WHERE host(p.ip_address) = '104.238.11.10' AND p.status = 'allocated'`;
  const t = tRows[0];
  if (t) {
    console.log("tunnel:", t.name, "pubkey:", t.wg_public_key.slice(0, 20) + "...");
    const ips: { ip: string }[] = await sql`
      SELECT host(ip_address) AS ip FROM public_ips
      WHERE tunnel_id = ${t.id} AND status = 'allocated' ORDER BY ip_address`;
    console.log("private (DB):", t.private_ip);
    console.log("public IPs (DB):", ips.map((r) => r.ip).join(", "));

    const kernelPeer = peers.find((p) => p.publicKey === t.wg_public_key);
    if (!kernelPeer) {
      console.log("❌ PEER NOT IN KERNEL");
    } else {
      const have = new Set(kernelPeer.publicIps ?? []);
      const want = ips.map((r) => r.ip);
      const missing = want.filter((e) => !have.has(e));
      const extra = (kernelPeer.publicIps ?? []).filter((a) => !want.includes(a));
      console.log("private match:", kernelPeer.privateIp === t.private_ip ? "✓" : `❌ kernel=${kernelPeer.privateIp}`);
      console.log("public IPs missing in kernel:", missing.length ? missing : "none ✓");
      console.log("public IPs extra in kernel:", extra.length ? extra : "none ✓");
    }
  }
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
