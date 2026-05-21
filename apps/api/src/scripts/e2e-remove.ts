// Cleanup a tunnel by id (TUNNEL_ID env): removeTunnel → real gateway peer
// deleted + tunnel marked deleted.
import { sql } from "@vpnhub/db";
import { removeTunnel } from "@vpnhub/provisioning";

async function main() {
  const id = process.env.TUNNEL_ID;
  if (!id) throw new Error("TUNNEL_ID env required");
  console.log("removeTunnel:", JSON.stringify(await removeTunnel(id)));
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("remove FAIL:", e);
    await sql.end();
    process.exit(1);
  });
