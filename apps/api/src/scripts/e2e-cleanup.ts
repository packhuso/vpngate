// E2E cleanup: removeTunnel (deletes peer on real gateway + marks deleted).
import { readFileSync } from "node:fs";
import { sql } from "@vpnhub/db";
import { removeTunnel } from "@vpnhub/provisioning";

async function main() {
  const { tunnelId } = JSON.parse(readFileSync("/tmp/e2e.json", "utf8"));
  const r = await removeTunnel(tunnelId);
  console.log("removeTunnel:", JSON.stringify(r));

  const [t] = await sql<{ status: string }[]>`
    SELECT status FROM tunnels WHERE id = ${tunnelId}`;
  if (t.status !== "deleted") throw new Error(`expected deleted, got ${t?.status}`);
  console.log("E2E CLEANUP: PASS");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("E2E CLEANUP FAIL:", e);
    await sql.end();
    process.exit(1);
  });
