// Prove the issued client cert chains to the CA embedded in the profile (i.e.
// the server will accept this client). Extracts <ca>/<cert> from the assembled
// .ovpn and runs `openssl verify`.
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { sql } from "@vpnhub/db";
import { getOvpnConfig } from "@vpnhub/provisioning";

async function main() {
  const [t] = await sql<{ id: string; user_id: string }[]>`
    SELECT id, user_id FROM tunnels
    WHERE protocol = 'openvpn' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1`;
  if (!t) throw new Error("no openvpn tunnel");
  const { conf } = await getOvpnConfig(t.user_id, t.id);
  const ca = conf.match(/<ca>\n([\s\S]*?)\n<\/ca>/)?.[1] ?? "";
  const cert = conf.match(/<cert>\n([\s\S]*?)\n<\/cert>/)?.[1] ?? "";
  writeFileSync("/tmp/ovpn-ca.pem", ca + "\n");
  writeFileSync("/tmp/ovpn-cert.pem", cert + "\n");
  const out = execSync("openssl verify -CAfile /tmp/ovpn-ca.pem /tmp/ovpn-cert.pem", {
    encoding: "utf8",
  });
  console.log(out.trim());
  // also show the cert subject/issuer + that it's a client cert
  const txt = execSync(
    "openssl x509 -in /tmp/ovpn-cert.pem -noout -subject -issuer -ext extendedKeyUsage",
    { encoding: "utf8" },
  );
  console.log(txt.trim());
}
main().then(() => sql.end()).catch(async (e) => { console.error("ERR", e?.message ?? e); await sql.end(); process.exit(1); });
