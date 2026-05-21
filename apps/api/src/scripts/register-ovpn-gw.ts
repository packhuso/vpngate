import { readFileSync } from "node:fs";
import { sql } from "@vpnhub/db";
import { encryptSecret } from "@vpnhub/shared";

async function main() {
  const PKI = "/opt/vpnhub-app/infra/pki";
  const caCert = readFileSync(`${PKI}/ca.crt`, "utf8");
  const token = readFileSync(`${PKI}/gw2.token`, "utf8").trim();
  const encToken = encryptSecret(token);

  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM vpn_gateways WHERE hostname = 'vpnhub-gw-2'`;
  if (existing) { console.log("already registered:", existing.id); await sql.end(); return; }

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO vpn_gateways (
      hostname, location, agent_endpoint, agent_ca_cert, agent_token,
      ovpn_endpoint, ovpn_port, private_subnet, max_tunnels, current_tunnels,
      status, local_asn, bgp_router_id, bgp_peer_ip, bgp_enabled
    ) VALUES (
      'vpnhub-gw-2', 'Colo', 'https://10.2.1.4:9443/v1',
      ${caCert}, ${encToken},
      '185.213.250.91', 1194, '10.99.1.0/24'::cidr, 500, 0,
      'active', 65002, '185.213.250.91'::inet, '185.213.250.89'::inet, false
    ) RETURNING id`;
  console.log("registered OpenVPN gateway:", row.id);
  console.log("  agent_endpoint: https://10.2.1.4:9443/v1");
  console.log("  ovpn_endpoint:  185.213.250.91:1194");
  console.log("  private_subnet: 10.99.1.0/24");
  console.log("  wg_public_key:  NULL (OVPN-only → availableProtocols marks openvpn)");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
