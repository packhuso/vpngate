// getOvpnConfig — assembles an inline .ovpn profile for an OpenVPN tunnel.
//
// Lazy issuance: the client cert is created on first download via the gateway
// agent (POST /v1/ovpn/clients/:cn/cert), then cached on the tunnel row
// (ovpn_client_cert + ovpn_client_key_encrypted) and node material in
// config_blob ({ca, tc-encrypted}). Subsequent downloads reuse the stored
// identity — no agent round-trip. Handles tunnels created before cert support.
import { sql } from "@vpnhub/db";
import { encryptSecret, decryptSecret } from "@vpnhub/shared";
import { buildGatewayClient } from "./gateway-client";
import { NotFound, ValidationError } from "./errors";

interface OvpnRow {
  id: string;
  name: string;
  status: string;
  protocol: string;
  wg_public_key: string; // reused as the OpenVPN CN slot
  ovpn_client_cert: string | null;
  ovpn_client_key_encrypted: string | null;
  config_blob: string | null;
  gateway_id: string;
  ovpn_endpoint: string;
  ovpn_port: number;
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string;
}

interface NodeBlob {
  ca: string; // OpenVPN CA cert (PEM)
  tc: string; // tls-crypt key, AES-GCM encrypted
}

export interface OvpnConfigResult {
  filename: string;
  conf: string;
}

export async function getOvpnConfig(
  userId: string,
  tunnelId: string,
): Promise<OvpnConfigResult> {
  const [t] = await sql<OvpnRow[]>`
    SELECT t.id, t.name, t.status, t.protocol, t.wg_public_key,
           t.ovpn_client_cert, t.ovpn_client_key_encrypted, t.config_blob,
           t.gateway_id, g.ovpn_endpoint, g.ovpn_port,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId} AND t.user_id = ${userId}
      AND t.deleted_at IS NULL`;
  if (!t) throw NotFound("tunnel");
  if (t.protocol !== "openvpn") {
    throw ValidationError("tunnel is not an OpenVPN tunnel");
  }
  if (t.status === "provisioning") {
    throw ValidationError("tunnel is still provisioning, try again in a moment");
  }
  if (!t.ovpn_endpoint) {
    throw ValidationError("gateway has no OpenVPN endpoint");
  }

  let clientCert = t.ovpn_client_cert;
  let clientKey = t.ovpn_client_key_encrypted
    ? decryptSecret(t.ovpn_client_key_encrypted)
    : null;
  let node: NodeBlob | null = t.config_blob
    ? (JSON.parse(t.config_blob) as NodeBlob)
    : null;

  // Lazy issuance / backfill: ask the node to mint (or return) this CN's cert.
  if (!clientCert || !clientKey || !node?.ca || !node?.tc) {
    const client = buildGatewayClient(t);
    const issued = await client.issueOvpnClientCert(
      t.wg_public_key,
      `ovpn-cert-${tunnelId}-${Date.now()}`,
    );
    clientCert = issued.clientCert;
    clientKey = issued.clientKey;
    node = { ca: issued.caCert, tc: encryptSecret(issued.tlsCryptKey) };
    await sql`
      UPDATE tunnels
      SET ovpn_client_cert = ${clientCert},
          ovpn_client_key_encrypted = ${encryptSecret(clientKey)},
          config_blob = ${JSON.stringify(node)}
      WHERE id = ${tunnelId}`;
  }

  const host = String(t.ovpn_endpoint).split(":")[0]; // endpoint may be host or host:port
  const safeName = t.name.replace(/[^A-Za-z0-9_-]/g, "_") || "tunnel";

  // No tls-crypt: the channel is still fully secured + authenticated by mutual
  // TLS (client cert + server cert). Dropping tls-crypt maximizes client
  // compatibility — notably Mikrotik RouterOS, whose tls-crypt support is fragile
  // and only on 7.17+ (server log showed "tls-crypt unwrap error" → handshake
  // timeout). config_blob still keeps the tc key for a future re-enable.
  const conf =
    `client\n` +
    `dev tun\n` +
    `proto udp\n` +
    `remote ${host} ${t.ovpn_port || 1194}\n` +
    `resolv-retry infinite\n` +
    `nobind\n` +
    `persist-key\n` +
    `persist-tun\n` +
    `remote-cert-tls server\n` +
    `cipher AES-256-GCM\n` +
    `data-ciphers AES-256-GCM:CHACHA20-POLY1305\n` +
    `auth SHA256\n` +
    `verb 3\n` +
    `\n` +
    `<ca>\n${node.ca.trim()}\n</ca>\n` +
    `<cert>\n${clientCert.trim()}\n</cert>\n` +
    `<key>\n${clientKey.trim()}\n</key>\n`;

  return { filename: `${safeName}.ovpn`, conf };
}

// getOvpnMikrotikScript — RouterOS 7.17+ setup script for an OpenVPN tunnel.
//
// Unlike WireGuard (where the private key is just a string), OpenVPN on RouterOS
// needs its CA + client cert/key + tls-crypt key imported as a FILE. RouterOS
// 7.17+ does this in one shot via `import-ovpn-configuration`, which also brings
// in tls-crypt (only supported 7.17+). So the workflow is: upload the .ovpn,
// then run this script — it imports the profile and (if the tunnel has public
// IPs) sets up the same pure-routing policy as the WireGuard script.
export async function getOvpnMikrotikScript(
  userId: string,
  tunnelId: string,
): Promise<OvpnConfigResult> {
  const [t] = await sql<
    {
      name: string;
      status: string;
      protocol: string;
      ovpn_endpoint: string;
      ovpn_port: number;
    }[]
  >`
    SELECT t.name, t.status, t.protocol, g.ovpn_endpoint, g.ovpn_port
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId} AND t.user_id = ${userId} AND t.deleted_at IS NULL`;
  if (!t) throw NotFound("tunnel");
  if (t.protocol !== "openvpn") throw ValidationError("tunnel is not OpenVPN");
  if (t.status === "provisioning") {
    throw ValidationError("tunnel is still provisioning, try again in a moment");
  }

  const pubIps = await sql<{ ip: string }[]>`
    SELECT host(ip_address) AS ip FROM public_ips
    WHERE tunnel_id = ${tunnelId} AND status = 'allocated'
    ORDER BY ip_address`;

  const safeName = t.name.replace(/[^A-Za-z0-9_-]/g, "_") || "tunnel";
  const ovpnFile = `${safeName}.ovpn`;
  const host = String(t.ovpn_endpoint).split(":")[0];
  const port = t.ovpn_port || 1194;
  const ifName = "ovpn-vpnhub";
  const conf = buildMikrotikOvpnScript({
    ovpnFile,
    host,
    port,
    ifName,
    publicIps: pubIps.map((p) => p.ip),
  });
  return { filename: `${safeName}.ovpn.rsc`, conf };
}

interface MikrotikOvpnArgs {
  ovpnFile: string;
  host: string;
  port: number;
  ifName: string;
  publicIps: string[];
}

function buildMikrotikOvpnScript(a: MikrotikOvpnArgs): string {
  const loName = "lo-vpnhub";
  const tableName = "vpnhub-egress";

  const header =
    `# VPN Hub — OpenVPN client for Mikrotik (RouterOS 7.x, UDP)\n` +
    `#\n` +
    `# STEP 1 — upload "${a.ovpnFile}" to the router first:\n` +
    `#   WinBox/WebFig > Files > drag-drop the file, OR  scp ${a.ovpnFile} admin@<router>:\n` +
    `# STEP 2 — paste/import this script (e.g. /import file=${a.ovpnFile}.rsc).\n` +
    `\n`;

  // import the profile + embedded certs + tls-crypt, then name the interface
  const importBlock =
    `/interface/ovpn-client/import-ovpn-configuration \\\n` +
    `    file-name=${a.ovpnFile} skip-cert-import=no\n` +
    `:delay 1s\n` +
    `# the import auto-creates the client by its remote; give it a stable name\n` +
    `/interface/ovpn-client set [find where connect-to="${a.host}"] \\\n` +
    `    name=${a.ifName} disabled=no\n` +
    `\n`;

  if (a.publicIps.length === 0) {
    return (
      header +
      importBlock +
      `# (no public IP assigned yet — the tunnel comes up with its private IP.\n` +
      `#  Assign a public IP in the portal, then re-download this script for the\n` +
      `#  policy-routing section.)\n`
    );
  }

  const loBridge =
    `/interface/bridge add name=${loName}\n` +
    `/ip/address\n` +
    a.publicIps.map((ip) => `add interface=${loName} address=${ip}/32\n`).join("") +
    `\n`;

  const polRouting =
    `/routing/table add fib name=${tableName}\n` +
    `/ip/route add gateway=${a.ifName} routing-table=${tableName}\n` +
    `/routing/rule\n` +
    a.publicIps
      .map((ip) => `add src-address=${ip}/32 action=lookup table=${tableName}\n`)
      .join("");

  return (
    header +
    importBlock +
    `# Pure-routing: hold each public IP on a loopback bridge and source outbound\n` +
    `# traffic from it via the OpenVPN tunnel (the gateway already iroutes each\n` +
    `# /32 to this client).\n` +
    loBridge +
    polRouting
  );
}
