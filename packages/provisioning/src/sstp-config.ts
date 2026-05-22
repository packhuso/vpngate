// getSstpConfig — Mikrotik RouterOS script for an SSTP tunnel. Unlike OpenVPN,
// SSTP needs no file upload: credentials (username/password) embed directly in
// the /interface/sstp-client line. Creds are issued lazily by the gateway agent
// (which generated the password into chap-secrets) and cached on the tunnel row
// (ovpn_client_cert = username, ovpn_client_key_encrypted = password).
import { sql } from "@vpnhub/db";
import { encryptSecret, decryptSecret } from "@vpnhub/shared";
import { buildGatewayClient } from "./gateway-client";
import { NotFound, ValidationError } from "./errors";

interface SstpRow {
  id: string;
  name: string;
  status: string;
  protocol: string;
  wg_public_key: string; // reused as the SSTP username slot
  ovpn_client_cert: string | null; // cached SSTP username
  ovpn_client_key_encrypted: string | null; // cached SSTP password (encrypted)
  sstp_endpoint: string;
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string;
}

export interface SstpConfigResult {
  filename: string;
  conf: string;
}

export async function getSstpConfig(
  userId: string,
  tunnelId: string,
): Promise<SstpConfigResult> {
  const [t] = await sql<SstpRow[]>`
    SELECT t.id, t.name, t.status, t.protocol, t.wg_public_key,
           t.ovpn_client_cert, t.ovpn_client_key_encrypted,
           g.sstp_endpoint, g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId} AND t.user_id = ${userId} AND t.deleted_at IS NULL`;
  if (!t) throw NotFound("tunnel");
  if (t.protocol !== "sstp") throw ValidationError("tunnel is not SSTP");
  if (t.status === "provisioning") {
    throw ValidationError("tunnel is still provisioning, try again in a moment");
  }
  if (!t.sstp_endpoint) throw ValidationError("gateway has no SSTP endpoint");

  let user = t.ovpn_client_cert;
  let pass = t.ovpn_client_key_encrypted ? decryptSecret(t.ovpn_client_key_encrypted) : null;
  if (!user || !pass) {
    // agent's IssueClientCert returns SSTP creds (clientCert=user, clientKey=pass)
    const issued = await buildGatewayClient(t).issueOvpnClientCert(
      t.wg_public_key,
      `sstp-creds-${tunnelId}-${Date.now()}`,
    );
    user = issued.clientCert;
    pass = issued.clientKey;
    await sql`
      UPDATE tunnels SET ovpn_client_cert = ${user},
        ovpn_client_key_encrypted = ${encryptSecret(pass)}
      WHERE id = ${tunnelId}`;
  }

  const host = String(t.sstp_endpoint).split(":")[0];
  const safeName = t.name.replace(/[^A-Za-z0-9_-]/g, "_") || "tunnel";
  const ifName = "sstp-vpnhub";

  const pubIps = await sql<{ ip: string }[]>`
    SELECT host(ip_address) AS ip FROM public_ips
    WHERE tunnel_id = ${tunnelId} AND status = 'allocated' ORDER BY ip_address`;

  const header =
    `# VPN Hub — SSTP client for Mikrotik (RouterOS 7.x). Paste/import this script.\n` +
    `# SSTP runs over TLS:443 (firewall-friendly). Self-signed server cert →\n` +
    `# verify-server-certificate=no.\n\n`;

  const client =
    `/interface/sstp-client\n` +
    `add name=${ifName} connect-to=${host} \\\n` +
    `    user="${user}" password="${pass}" \\\n` +
    `    verify-server-certificate=no add-default-route=no disabled=no\n\n`;

  const mssClamp =
    `/ip/firewall/mangle\n` +
    `add chain=forward action=change-mss new-mss=1360 passthrough=yes \\\n` +
    `    protocol=tcp tcp-flags=syn tcp-mss=1361-65535 out-interface=${ifName} \\\n` +
    `    comment="vpnhub: clamp MSS (PMTUD-safe)"\n` +
    `add chain=forward action=change-mss new-mss=1360 passthrough=yes \\\n` +
    `    protocol=tcp tcp-flags=syn tcp-mss=1361-65535 in-interface=${ifName} \\\n` +
    `    comment="vpnhub: clamp MSS (PMTUD-safe)"\n\n`;

  let conf = header + client + mssClamp;
  if (pubIps.length > 0) {
    const ips = pubIps.map((p) => p.ip);
    conf +=
      `# Pure-routing: hold each public IP on a loopback bridge and source\n` +
      `# outbound from it via the SSTP tunnel.\n` +
      `/interface/bridge add name=lo-vpnhub\n` +
      `/ip/address\n` +
      ips.map((ip) => `add interface=lo-vpnhub address=${ip}/32\n`).join("") +
      `/routing/table add fib name=vpnhub-egress\n` +
      `/ip/route add gateway=${ifName} routing-table=vpnhub-egress\n` +
      `/routing/rule\n` +
      ips.map((ip) => `add src-address=${ip}/32 action=lookup table=vpnhub-egress\n`).join("");
  }
  return { filename: `${safeName}.sstp.rsc`, conf };
}
