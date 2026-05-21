// One-shot: buy + assign a public IP (PUB_IP env) to a tunnel (TUNNEL_ID env
// or the most-recent active tunnel) and verify gateway state. Uses the new
// split flow: buyPublicIp(userId, ip) then moveIp(userId, ip, tunnelId).
import { sql } from "@vpnhub/db";
import { buyPublicIp, moveIp } from "@vpnhub/provisioning";

async function main() {
  const ip = process.env.PUB_IP;
  if (!ip) throw new Error("PUB_IP env required");
  let id = process.env.TUNNEL_ID;
  let userId: string;
  if (!id) {
    const [t] = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM tunnels WHERE status='active' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`;
    if (!t) throw new Error("no active tunnel");
    id = t.id;
    userId = t.user_id;
  } else {
    const [t] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM tunnels WHERE id = ${id}`;
    if (!t) throw new Error("tunnel not found");
    userId = t.user_id;
  }
  const buy = await buyPublicIp(userId, ip);
  const assign = await moveIp(userId, ip, id);
  console.log(JSON.stringify({ buy, assign }));
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("ASSIGN FAIL:", e);
    await sql.end();
    process.exit(1);
  });
