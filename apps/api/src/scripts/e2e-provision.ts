// E2E: createTunnel (money-safe tx) → activateTunnel (real gateway over
// mTLS+Bearer). Asserts DB state; persists ids to /tmp/e2e.json. No cleanup
// here (e2e-cleanup.ts does that, after wg-show proof).
import { writeFileSync } from "node:fs";
import { sql } from "@vpnhub/db";
import { createTunnel, activateTunnel } from "@vpnhub/provisioning";

async function main() {
  const [u] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = 'e2e@vpnhub.local'`;
  if (!u) throw new Error("run seed-e2e first");

  const [w0] = await sql<{ balance_satang: string }[]>`
    SELECT balance_satang FROM credit_wallets WHERE user_id = ${u.id}`;
  const before = Number(w0.balance_satang);

  const r = await createTunnel({
    userId: u.id,
    speedTier: "tier_100mb",
    name: "e2e-tunnel",
    gatewayHostname: "vpnhub-gw-1",
  });
  console.log("created:", r.tunnelId, "privateIp", r.privateIp);

  const [t1] = await sql<{ status: string }[]>`
    SELECT status FROM tunnels WHERE id = ${r.tunnelId}`;
  const [w1] = await sql<{ balance_satang: string }[]>`
    SELECT balance_satang FROM credit_wallets WHERE user_id = ${u.id}`;
  const charged = before - Number(w1.balance_satang);
  console.log(`status=${t1.status} walletDebited=${charged} satang (expect 10000)`);
  if (t1.status !== "provisioning" || charged !== 10000) {
    throw new Error("createTunnel assertions failed");
  }

  const a = await activateTunnel(r.tunnelId);
  console.log("activate:", JSON.stringify(a));

  const [t2] = await sql<{ status: string }[]>`
    SELECT status FROM tunnels WHERE id = ${r.tunnelId}`;
  if (t2.status !== "active") throw new Error(`expected active, got ${t2.status}`);

  writeFileSync(
    "/tmp/e2e.json",
    JSON.stringify({ tunnelId: r.tunnelId, publicKey: r.publicKey, privateIp: r.privateIp }),
  );
  console.log("E2E PROVISION: PASS  pubkey=" + r.publicKey);
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("E2E PROVISION FAIL:", e);
    await sql.end();
    process.exit(1);
  });
