// On-demand drift run for E2E tests (instead of waiting 10 min).
import { sql } from "@vpnhub/db";
import { reconcileAllGateways } from "@vpnhub/provisioning";

async function main() {
  console.log(JSON.stringify(await reconcileAllGateways(), null, 2));
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("drift FAIL:", e);
    await sql.end();
    process.exit(1);
  });
