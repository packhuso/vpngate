import { sql } from "@vpnhub/db";
import { buyFirstAvailableSingleIp, buyIpBlock, buyPublicIp, releasePublicIp, releaseIpBlock } from "@vpnhub/provisioning";

async function main() {
  // Find pool + user
  const [pool] = await sql<{ id: string; block: string }[]>`SELECT id, block::text AS block FROM ip_pool LIMIT 1`;
  const [u] = await sql<{ id: string }[]>`SELECT u.id FROM users u JOIN credit_wallets w ON w.user_id=u.id WHERE w.balance_satang > 50000 ORDER BY w.balance_satang DESC LIMIT 1`;
  if (!pool || !u) throw new Error("no pool or user");
  console.log("pool:", pool.block, "user:", u.id);

  console.log("\n[1] Add sale plan: 104.238.11.96/28 single");
  await sql`INSERT INTO ip_sale_plans (pool_id, cidr, sale_mode) VALUES (${pool.id}, '104.238.11.96/28'::cidr, 'single')`;
  console.log("[2] Add sale plan: 104.238.11.112/28 block /30 (4 IPs)");
  await sql`INSERT INTO ip_sale_plans (pool_id, cidr, sale_mode, block_size) VALUES (${pool.id}, '104.238.11.112/28'::cidr, 'block', 4)`;

  console.log("\n[3] buyFirstAvailableSingleIp → should be in 104.238.11.96/28");
  const buy1 = await buyFirstAvailableSingleIp(u.id);
  console.log("   →", buy1.ip);
  if (!buy1.ip.startsWith("104.238.11.")) throw new Error("FAIL: wrong pool");
  const ipInt = buy1.ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const segStart = "104.238.11.96".split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  if (ipInt < segStart || ipInt >= segStart + 16) throw new Error("FAIL: not in 104.238.11.96/28");
  console.log("   ✓ in single range");

  console.log("\n[4] buyPublicIp(104.238.11.112) → should REJECT (in block range)");
  try {
    await buyPublicIp(u.id, "104.238.11.112");
    throw new Error("FAIL: should have rejected");
  } catch (e) {
    if ((e as Error).message.includes("block-only")) {
      console.log("   ✓ rejected:", (e as Error).message);
    } else throw e;
  }

  console.log("\n[5] buyIpBlock(blockSize=4) → should allocate from 104.238.11.112/28");
  const buy2 = await buyIpBlock(u.id, 4);
  console.log("   →", buy2.cidr, "ips:", buy2.ips);
  if (!buy2.cidr.startsWith("104.238.11.11")) throw new Error("FAIL: wrong range");
  console.log("   ✓ from block range");

  console.log("\n[6] buyIpBlock(blockSize=8) → should FAIL (no /29 plan)");
  try {
    await buyIpBlock(u.id, 8);
    throw new Error("FAIL: should have rejected");
  } catch (e) {
    if ((e as Error).message.toLowerCase().includes("no") || (e as Error).message.toLowerCase().includes("available")) {
      console.log("   ✓ rejected:", (e as Error).message);
    } else throw e;
  }

  // cleanup
  console.log("\n[7] cleanup");
  await releasePublicIp(u.id, buy1.ip);
  await releaseIpBlock(u.id, buy2.blockId);
  await sql`DELETE FROM ip_sale_plans WHERE pool_id = ${pool.id}`;
  console.log("   ✓ cleaned up");

  console.log("\n✅ ALL CHECKS PASSED");
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
