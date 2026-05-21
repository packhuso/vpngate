// Manual E2E: provision an OpenVPN tunnel on the live node, then assemble its
// .ovpn (lazy cert issuance via the agent over mTLS). Validates structure.
// Reuses the e2e user; tops up if needed. Prints the tunnel id (cleanup is left
// to the operator — or pass DELETE=1 to remove it afterward).
import { sql } from "@vpnhub/db";
import {
  createTunnel,
  activateTunnel,
  getOvpnConfig,
  removeTunnel,
} from "@vpnhub/provisioning";

async function main() {
  // pick a DEDICATED OpenVPN node (ovpn endpoint + NO WireGuard) so we don't
  // accidentally land on a WG node that carries a stale ovpn_endpoint.
  const [gw] = await sql<{ hostname: string }[]>`
    SELECT hostname FROM vpn_gateways
    WHERE status = 'active' AND ovpn_endpoint IS NOT NULL
      AND wg_public_key IS NULL LIMIT 1`;
  if (!gw) throw new Error("no dedicated OpenVPN gateway registered");
  console.log("ovpn gateway:", gw.hostname);

  // reuse an existing OpenVPN tunnel if present, else provision a fresh one
  let tunnelId: string;
  let userId: string;
  const [existing] = await sql<{ id: string; user_id: string; status: string }[]>`
    SELECT id, user_id, status FROM tunnels
    WHERE protocol = 'openvpn' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1`;

  if (existing && existing.status === "active") {
    tunnelId = existing.id;
    userId = existing.user_id;
    console.log("reusing active tunnel", tunnelId);
  } else {
    const [u] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = 'e2e@vpnhub.local'`;
    if (!u) throw new Error("e2e user missing — run seed-e2e first");
    userId = u.id;
    // ensure balance for the 100mb tier (10000 satang)
    await sql`
      UPDATE credit_wallets SET balance_satang = balance_satang + 100000
      WHERE user_id = ${userId} AND balance_satang < 10000`;
    const r = await createTunnel({
      userId,
      speedTier: "tier_100mb",
      name: "ovpn-test",
      gatewayHostname: gw.hostname,
      protocol: "openvpn",
    });
    tunnelId = r.tunnelId;
    console.log("created tunnel", tunnelId, "privateIp", r.privateIp);
    const a = await activateTunnel(tunnelId);
    console.log("activate:", JSON.stringify(a));
  }

  // the actual thing under test: assemble the .ovpn (issues a client cert on the
  // node the first time, then caches it on the tunnel row)
  const cfg = await getOvpnConfig(userId, tunnelId);
  const conf = cfg.conf;
  const checks = {
    filename: cfg.filename,
    hasRemote: /^remote\s+\S+\s+\d+/m.test(conf),
    hasCA: /<ca>[\s\S]*BEGIN CERTIFICATE[\s\S]*<\/ca>/.test(conf),
    hasCert: /<cert>[\s\S]*BEGIN CERTIFICATE[\s\S]*<\/cert>/.test(conf),
    hasKey: /<key>[\s\S]*BEGIN (EC )?PRIVATE KEY[\s\S]*<\/key>/.test(conf),
    hasTlsCrypt: /<tls-crypt>[\s\S]*-----BEGIN[\s\S]*<\/tls-crypt>/.test(conf),
    bytes: conf.length,
  };
  console.log("CONFIG CHECKS:", JSON.stringify(checks, null, 2));
  console.log("--- head ---\n" + conf.split("\n").slice(0, 14).join("\n"));

  // second call must reuse the cached cert (no new agent round-trip needed)
  const cfg2 = await getOvpnConfig(userId, tunnelId);
  const stableCert =
    cfg2.conf.match(/<cert>[\s\S]*?<\/cert>/)?.[0] ===
    conf.match(/<cert>[\s\S]*?<\/cert>/)?.[0];
  console.log("cert stable across downloads:", stableCert);

  const ok =
    checks.hasRemote &&
    checks.hasCA &&
    checks.hasCert &&
    checks.hasKey &&
    checks.hasTlsCrypt &&
    stableCert;
  console.log(ok ? "OVPN CONFIG TEST: PASS" : "OVPN CONFIG TEST: FAIL");

  if (process.env.DELETE === "1") {
    await removeTunnel(tunnelId);
    console.log("removed tunnel", tunnelId);
  }
  if (!ok) process.exit(1);
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("ERR", e?.stack ?? e?.message ?? e);
    await sql.end();
    process.exit(1);
  });
