import { sql } from "@vpnhub/db";
import { buyPublicIp, moveIp, releasePublicIp } from "@vpnhub/provisioning";

async function main() {
  const [u] = await sql<{ id: string; email: string }[]>`
    SELECT u.id, u.email FROM users u
    JOIN credit_wallets w ON w.user_id = u.id
    WHERE w.balance_satang > 50000 LIMIT 1`;
  if (!u) throw new Error("no user with enough balance for test");
  console.log("user:", u.email, u.id);

  const [pool] = await sql<{ block: string }[]>`SELECT block::text AS block FROM ip_pool LIMIT 1`;
  console.log("pool:", pool.block);

  // Find a free /32 in pool for testing
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
  for (let off = size - 5; off > 0; off--) {
    if (!usedSet.has(net + off)) { testIp = intToIp4(net + off); break; }
  }
  if (!testIp) throw new Error("no free IP for test");
  console.log("test IP:", testIp);

  console.log("\n[1] Buy IP WITHOUT tunnel:");
  const buy = await buyPublicIp(u.id, testIp);
  console.log("   →", buy);

  const [check1] = await sql`SELECT host(ip_address) AS ip, tunnel_id, status FROM public_ips WHERE ip_address = ${testIp}::inet`;
  console.log("   DB state:", check1);
  if (check1.tunnel_id !== null) throw new Error("FAIL: tunnel_id should be NULL after buy");
  if (check1.status !== "allocated") throw new Error("FAIL: status should be 'allocated'");

  // Find an active tunnel for this user
  const [tun] = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM tunnels
    WHERE user_id = ${u.id} AND status = 'active' AND deleted_at IS NULL LIMIT 1`;
  if (tun) {
    console.log("\n[2] Assign to tunnel:", tun.name);
    const assign = await moveIp(u.id, testIp, tun.id);
    console.log("   →", assign);
    const [check2] = await sql`SELECT tunnel_id FROM public_ips WHERE ip_address = ${testIp}::inet`;
    if (check2.tunnel_id !== tun.id) throw new Error("FAIL: tunnel_id should be set");
    console.log("   ✓ tunnel_id = " + tun.id);

    console.log("\n[3] Unassign (move → null):");
    const unassign = await moveIp(u.id, testIp, null);
    console.log("   →", unassign);
    const [check3] = await sql`SELECT tunnel_id, status FROM public_ips WHERE ip_address = ${testIp}::inet`;
    if (check3.tunnel_id !== null) throw new Error("FAIL: tunnel_id should be NULL");
    if (check3.status !== "allocated") throw new Error("FAIL: still allocated");
    console.log("   ✓ unassigned, still allocated to user");
  } else {
    console.log("(no active tunnel for user, skipping assign/unassign)");
  }

  console.log("\n[4] Release back to pool:");
  const rel = await releasePublicIp(u.id, testIp);
  console.log("   →", rel);
  const [check4] = await sql`SELECT user_id, tunnel_id, status FROM public_ips WHERE ip_address = ${testIp}::inet`;
  if (check4.status !== "available") throw new Error("FAIL: should be available");
  if (check4.user_id !== null) throw new Error("FAIL: user_id should be NULL");
  console.log("   ✓", check4);

  console.log("\n✅ ALL CHECKS PASSED");
}

main().then(() => sql.end()).catch(async (e) => {
  console.error("FAIL:", e); await sql.end(); process.exit(1);
});
