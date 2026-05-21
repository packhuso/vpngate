import { sql } from "@vpnhub/db";
import { buyPublicIp, runBillingTick, moveIp, releasePublicIp } from "@vpnhub/provisioning";

async function main() {
  // Setup: find user + tunnel for testing
  const [tun] = await sql<{ id: string; name: string; user_id: string; speed_tier: string; next_billing_at: Date }[]>`
    SELECT id, name, user_id, speed_tier, next_billing_at FROM tunnels
    WHERE status = 'active' AND deleted_at IS NULL LIMIT 1`;
  if (!tun) throw new Error("no active tunnel");
  console.log("tunnel:", tun.name, "tier:", tun.speed_tier, "next_billing:", tun.next_billing_at);

  // Find a free IP
  const ip4ToInt = (ip: string): number => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const intToIp4 = (n: number): string => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const [pool] = await sql<{ block: string }[]>`SELECT block::text AS block FROM ip_pool LIMIT 1`;
  const [base, lenStr] = pool.block.split("/");
  const net = ip4ToInt(base);
  const size = 1 << (32 - Number(lenStr));
  const used = await sql<{ ip: string }[]>`SELECT host(ip_address) AS ip FROM public_ips WHERE status != 'available'`;
  const usedSet = new Set(used.map((r) => ip4ToInt(r.ip)));
  let testIp: string | null = null;
  for (let off = size - 30; off > 0; off--) { if (!usedSet.has(net + off)) { testIp = intToIp4(net + off); break; } }
  if (!testIp) throw new Error("no free IP");

  // ── Scenario A: IP charge-on-due succeeds ──────────────────────
  console.log("\n=== Scenario A: charge IP when user has credit ===");
  console.log("[a1] Buy IP", testIp);
  await buyPublicIp(tun.user_id, testIp);

  // Time-skew the IP's next_billing_at to NOW
  await sql`UPDATE public_ips SET next_billing_at = NOW() - INTERVAL '1 minute'
            WHERE ip_address = ${testIp}::inet`;
  const balBefore = (await sql<{ b: string }[]>`SELECT balance_satang::text b FROM credit_wallets WHERE user_id = ${tun.user_id}`)[0].b;
  console.log("[a2] balance before tick:", balBefore);

  console.log("[a3] runBillingTick()");
  const r1 = await runBillingTick();
  console.log("   →", JSON.stringify(r1));

  const balAfter = (await sql<{ b: string }[]>`SELECT balance_satang::text b FROM credit_wallets WHERE user_id = ${tun.user_id}`)[0].b;
  const [ipState1] = await sql<{ status: string; next_billing_at: Date; suspended_at: Date | null }[]>`
    SELECT status, next_billing_at, suspended_at FROM public_ips WHERE ip_address = ${testIp}::inet`;
  console.log("   balance after:", balAfter, "(delta:", Number(balBefore) - Number(balAfter), ")");
  console.log("   IP next_billing pushed to:", ipState1.next_billing_at, "status:", ipState1.status);
  if (Number(balBefore) - Number(balAfter) !== 10000) throw new Error("FAIL: should charge 10000");
  if (ipState1.status !== "allocated" || ipState1.suspended_at) throw new Error("FAIL: should be active");
  console.log("   ✓ charged + advanced");

  // ── Scenario B: IP suspends when user has no credit ─────────────
  console.log("\n=== Scenario B: insufficient credit → suspend ===");
  // Drain the wallet to below SINGLE_IP_SATANG
  const drain = Number(balAfter) - 5000; // leave only 50 satang
  if (drain > 0) {
    await sql`UPDATE credit_wallets SET balance_satang = 5000 WHERE user_id = ${tun.user_id}`;
  }
  await sql`UPDATE public_ips SET next_billing_at = NOW() - INTERVAL '1 minute' WHERE ip_address = ${testIp}::inet`;
  console.log("[b1] balance set to 50 satang. runBillingTick()");
  const r2 = await runBillingTick();
  console.log("   →", JSON.stringify(r2));
  const [ipState2] = await sql<{ status: string; suspended_at: Date | null; delete_after: Date | null }[]>`
    SELECT status, suspended_at, delete_after FROM public_ips WHERE ip_address = ${testIp}::inet`;
  console.log("   IP status:", ipState2.status, "suspended_at:", ipState2.suspended_at, "delete_after:", ipState2.delete_after);
  if (ipState2.status !== "suspended" || !ipState2.delete_after) throw new Error("FAIL: should be suspended with delete_after");
  console.log("   ✓ suspended + delete_after set");

  // ── Scenario C: grace expires → auto-cancel ─────────────────────
  console.log("\n=== Scenario C: grace expires → force-cancel ===");
  await sql`UPDATE public_ips SET delete_after = NOW() - INTERVAL '1 minute' WHERE ip_address = ${testIp}::inet`;
  console.log("[c1] delete_after set to past. runBillingTick()");
  const r3 = await runBillingTick();
  console.log("   →", JSON.stringify(r3));
  const [ipState3] = await sql<{ status: string; user_id: string | null; tunnel_id: string | null }[]>`
    SELECT status, user_id, tunnel_id FROM public_ips WHERE ip_address = ${testIp}::inet`;
  console.log("   IP final:", ipState3);
  if (ipState3.status !== "available" || ipState3.user_id !== null) throw new Error("FAIL: should be back in pool");
  console.log("   ✓ auto-released back to pool (no refund)");

  // ── Scenario D: IP attached to tunnel + grace expires → unassign first ─
  console.log("\n=== Scenario D: attached IP grace expires → unassign + release ===");
  // restore some balance and buy again
  await sql`UPDATE credit_wallets SET balance_satang = 100000 WHERE user_id = ${tun.user_id}`;
  await buyPublicIp(tun.user_id, testIp);
  await moveIp(tun.user_id, testIp, tun.id);
  // force grace expiry
  await sql`UPDATE public_ips SET delete_after = NOW() - INTERVAL '1 minute', suspended_at = NOW(), status = 'suspended' WHERE ip_address = ${testIp}::inet`;
  console.log("[d1] attached + grace expired. runBillingTick()");
  const r4 = await runBillingTick();
  console.log("   →", JSON.stringify(r4));
  const [ipState4] = await sql<{ status: string; user_id: string | null; tunnel_id: string | null }[]>`
    SELECT status, user_id, tunnel_id FROM public_ips WHERE ip_address = ${testIp}::inet`;
  console.log("   IP final:", ipState4);
  if (ipState4.status !== "available" || ipState4.tunnel_id !== null) throw new Error("FAIL: should be released, tunnel_id null");
  console.log("   ✓ unassigned + released");

  console.log("\n✅ ALL BILLING SCENARIOS PASSED");
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
