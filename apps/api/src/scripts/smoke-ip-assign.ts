import { sql } from "@vpnhub/db";
import { buyPublicIp, moveIp, releasePublicIp } from "@vpnhub/provisioning";

async function main() {
  const [tun] = await sql<{ id: string; name: string; user_id: string }[]>`
    SELECT id, name, user_id FROM tunnels
    WHERE status = 'active' AND deleted_at IS NULL LIMIT 1`;
  if (!tun) throw new Error("no active tunnel");
  console.log("tunnel:", tun.name, "user:", tun.user_id);

  const [pool] = await sql<{ block: string }[]>`SELECT block::text AS block FROM ip_pool LIMIT 1`;
  const ip4ToInt = (ip: string): number =>
    ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const intToIp4 = (n: number): string =>
    [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const [base, lenStr] = pool.block.split("/");
  const net = ip4ToInt(base);
  const size = 1 << (32 - Number(lenStr));
  const used = await sql<{ ip: string }[]>`
    SELECT host(ip_address) AS ip FROM public_ips WHERE status != 'available'`;
  const usedSet = new Set(used.map((r) => ip4ToInt(r.ip)));
  let testIp: string | null = null;
  for (let off = size - 10; off > 0; off--) {
    if (!usedSet.has(net + off)) { testIp = intToIp4(net + off); break; }
  }
  if (!testIp) throw new Error("no free IP");
  console.log("test IP:", testIp);

  console.log("\n[1] Buy unassigned:");
  console.log("   →", await buyPublicIp(tun.user_id, testIp));

  console.log("\n[2] Assign to tunnel:");
  console.log("   →", await moveIp(tun.user_id, testIp, tun.id));
  const [a] = await sql`SELECT tunnel_id FROM public_ips WHERE ip_address = ${testIp}::inet`;
  if (a.tunnel_id !== tun.id) throw new Error("FAIL");
  console.log("   ✓ assigned");

  console.log("\n[3] Unassign:");
  console.log("   →", await moveIp(tun.user_id, testIp, null));
  const [b] = await sql`SELECT tunnel_id, status FROM public_ips WHERE ip_address = ${testIp}::inet`;
  if (b.tunnel_id !== null || b.status !== "allocated") throw new Error("FAIL");
  console.log("   ✓ unassigned, still owned");

  console.log("\n[4] Release:");
  console.log("   →", await releasePublicIp(tun.user_id, testIp));

  console.log("\n✅ ALL CHECKS PASSED");
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
