import { readFileSync } from "node:fs";
import { sql } from "@vpnhub/db";
import { encryptSecret } from "@vpnhub/shared";

async function main() {
  const PKI = "/opt/vpnhub-app/infra/pki";
  const caCert = readFileSync(`${PKI}/ca.crt`, "utf8");
  const token = readFileSync(`${PKI}/gw3.token`, "utf8").trim();
  const encToken = encryptSecret(token);

  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM vpn_gateways WHERE hostname = 'vpnhub-gw-3'`;
  if (existing) {
    await sql`UPDATE vpn_gateways SET agent_token=${encToken}, agent_ca_cert=${caCert},
                sstp_endpoint='185.213.250.92', local_asn=65003,
                bgp_router_id='185.213.250.92'::inet, bgp_peer_ip='185.213.250.89'::inet
              WHERE id=${existing.id}`;
    console.log("updated existing gw-3:", existing.id);
    await sql.end();
    return;
  }

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO vpn_gateways (
      hostname, location, agent_endpoint, agent_ca_cert, agent_token,
      sstp_endpoint, private_subnet, max_tunnels, current_tunnels,
      status, local_asn, bgp_router_id, bgp_peer_ip, bgp_enabled
    ) VALUES (
      'vpnhub-gw-3', 'Colo', 'https://10.2.1.5:9443/v1',
      ${caCert}, ${encToken},
      '185.213.250.92', '10.99.2.0/24'::cidr, 500, 0,
      'active', 65003, '185.213.250.92'::inet, '185.213.250.89'::inet, false
    ) RETURNING id`;
  console.log("registered SSTP gateway:", row.id);
  console.log("  agent_endpoint: https://10.2.1.5:9443/v1");
  console.log("  sstp_endpoint:  185.213.250.92");
  console.log("  private_subnet: 10.99.2.0/24, AS 65003");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
