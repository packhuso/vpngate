// Seed for the provisioning E2E: the real gateway (gw1) + a funded test user.
// Idempotent. Run: node dist/scripts/seed-e2e.js  (env loaded)
import { readFileSync } from "node:fs";
import { sql } from "@vpnhub/db";
import { encryptSecret } from "@vpnhub/shared";

const PKI = "/opt/vpnhub-app/infra/pki";

async function main() {
  const caCert = readFileSync(`${PKI}/ca.crt`, "utf8");
  const agentToken = readFileSync(`${PKI}/gw1.token`, "utf8").trim();
  const agentTokenEnc = encryptSecret(agentToken);

  // --- gateway gw1 (the real LAN gateway) ---
  const gw = await sql`
    INSERT INTO vpn_gateways (hostname, location, agent_endpoint, agent_ca_cert,
      agent_token, wg_endpoint, wg_port, wg_public_key, ovpn_endpoint,
      private_subnet, max_tunnels, status)
    VALUES ('vpnhub-gw-1', 'lan-test', 'https://10.1.3.247:9443/v1', ${caCert},
      ${agentTokenEnc}, '10.1.3.247', 51820,
      'N6W/psDmPbFxT/huWQK4WP4h7wB5q77SciZ77ldFxQ0=', '10.1.3.247',
      '10.99.0.0/24', 500, 'active')
    ON CONFLICT (hostname) DO UPDATE SET
      agent_endpoint = EXCLUDED.agent_endpoint,
      agent_ca_cert  = EXCLUDED.agent_ca_cert,
      agent_token    = EXCLUDED.agent_token,
      wg_public_key  = EXCLUDED.wg_public_key,
      private_subnet = EXCLUDED.private_subnet,
      status         = 'active'
    RETURNING id, hostname, private_subnet`;
  console.log("gateway:", gw[0].hostname, gw[0].private_subnet, gw[0].id);

  // --- test user (wallet auto-created by trigger) ---
  const u = await sql`
    INSERT INTO users (google_sub, email, name, status, email_verified)
    VALUES ('e2e-test-sub', 'e2e@vpnhub.local', 'E2E Test', 'active', true)
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, email`;
  const userId = u[0].id as string;
  console.log("user:", u[0].email, userId);

  // --- fund wallet to 100000 satang (1000 ฿) via a ledger entry ---
  const w = await sql`SELECT id, balance_satang FROM credit_wallets WHERE user_id = ${userId}`;
  const walletId = w[0].id as string;
  const target = 100000;
  await sql.begin(async (tx) => {
    await tx`UPDATE credit_wallets
             SET balance_satang = ${target},
                 lifetime_topup_satang = ${target},
                 version = version + 1
             WHERE id = ${walletId}`;
    await tx`INSERT INTO credit_transactions
             (user_id, wallet_id, type, amount_satang, balance_after,
              description, idempotency_key)
             VALUES (${userId}, ${walletId}, 'admin_adjustment', ${target},
              ${target}, 'E2E seed top-up', 'seed-topup-e2e')
             ON CONFLICT (idempotency_key) DO NOTHING`;
  });
  console.log(`wallet: ${walletId} balance=${target} satang`);
  console.log("SEED: OK");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("SEED FAIL:", e);
    await sql.end();
    process.exit(1);
  });
