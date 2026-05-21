import { sql } from "@vpnhub/db";
import { buyPublicIp, moveIp, releasePublicIp, deleteTunnel, buyIpBlock, releaseIpBlock, moveIpBlock } from "@vpnhub/provisioning";

async function main() {
  const [tun] = await sql<{ id: string; name: string; user_id: string }[]>`
    SELECT id, name, user_id FROM tunnels
    WHERE status = 'active' AND deleted_at IS NULL LIMIT 1`;
  if (!tun) throw new Error("no active tunnel");
  console.log("tunnel:", tun.name, "user:", tun.user_id);

  // find unused IP
  const [pool] = await sql<{ block: string }[]>`SELECT block::text AS block FROM ip_pool LIMIT 1`;
  const ip4ToInt = (ip: string): number => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const intToIp4 = (n: number): string => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const [base, lenStr] = pool.block.split("/");
  const net = ip4ToInt(base);
  const size = 1 << (32 - Number(lenStr));
  const used = await sql<{ ip: string }[]>`SELECT host(ip_address) AS ip FROM public_ips WHERE status != 'available'`;
  const usedSet = new Set(used.map((r) => ip4ToInt(r.ip)));
  let testIp: string | null = null;
  for (let off = size - 20; off > 0; off--) { if (!usedSet.has(net + off)) { testIp = intToIp4(net + off); break; } }
  if (!testIp) throw new Error("no free IP");

  console.log("\n[1] Buy + assign IP", testIp);
  await buyPublicIp(tun.user_id, testIp);
  await moveIp(tun.user_id, testIp, tun.id);
  console.log("   ✓ attached");

  console.log("\n[2] releasePublicIp while attached → must REJECT");
  try {
    await releasePublicIp(tun.user_id, testIp);
    throw new Error("FAIL: should have rejected");
  } catch (e) {
    if ((e as Error).message.includes("ปลด")) console.log("   ✓", (e as Error).message);
    else throw e;
  }

  console.log("\n[3] deleteTunnel while IP attached → must REJECT");
  try {
    await deleteTunnel(tun.id, tun.user_id);
    throw new Error("FAIL: should have rejected");
  } catch (e) {
    if ((e as Error).message.includes("ปลด")) console.log("   ✓", (e as Error).message);
    else throw e;
  }

  console.log("\n[4] Unassign IP from tunnel");
  await moveIp(tun.user_id, testIp, null);
  console.log("   ✓ detached");

  console.log("\n[5] releasePublicIp now → must SUCCEED");
  console.log("   →", await releasePublicIp(tun.user_id, testIp));

  // Also test block: buy block, attach, release should fail, detach, release should succeed
  console.log("\n[6] Buy block /31");
  const blk = await buyIpBlock(tun.user_id, 2);
  console.log("   →", blk.cidr);

  console.log("[7] Attach block");
  await moveIpBlock(tun.user_id, blk.blockId, tun.id);

  console.log("[8] releaseIpBlock while attached → must REJECT");
  try {
    await releaseIpBlock(tun.user_id, blk.blockId);
    throw new Error("FAIL");
  } catch (e) {
    if ((e as Error).message.includes("ปลด")) console.log("   ✓", (e as Error).message);
    else throw e;
  }

  console.log("[9] Detach + release block");
  await moveIpBlock(tun.user_id, blk.blockId, null);
  console.log("   →", await releaseIpBlock(tun.user_id, blk.blockId));

  console.log("\n✅ ALL CHECKS PASSED");
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
