import { sql } from "@vpnhub/db";
import { reconcileAllGateways } from "@vpnhub/provisioning";
async function main() {
  const r = await reconcileAllGateways();
  console.log(JSON.stringify(r, null, 2));
}
main().then(() => sql.end()).catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
