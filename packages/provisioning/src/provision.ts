// createTunnel — the money-safe provisioning transaction (design Section 7.1).
import { sql } from "@vpnhub/db";
import { encryptSecret, generateWireguardKeypair } from "@vpnhub/shared";
import { TIER_PRICE_SATANG, type SpeedTier } from "@vpnhub/billing";
import { allocatePrivateIp } from "./ip";
import {
  InsufficientCredit,
  NoGatewayAvailable,
  ValidationError,
} from "./errors";

export type TunnelProtocol = "wireguard" | "openvpn" | "sstp";

export interface CreateTunnelInput {
  userId: string;
  speedTier: SpeedTier;
  name: string;
  description?: string; // free-text label (any language) — display only
  gatewayHostname?: string;
  protocol?: TunnelProtocol; // default "wireguard"
}

// The name is used verbatim as a config-file name, so keep it ASCII. A separate
// `description` field carries any-language labels.
export const TUNNEL_NAME_RE = /^[A-Za-z0-9 ._-]{1,100}$/;

export interface CreateTunnelResult {
  tunnelId: string;
  gatewayId: string;
  gatewayHostname: string;
  privateIp: string;
  publicKey: string;
}

const DAY_MS = 86_400_000;

export async function createTunnel(
  input: CreateTunnelInput,
): Promise<CreateTunnelResult> {
  const price = TIER_PRICE_SATANG[input.speedTier];
  if (price == null) throw ValidationError(`bad speedTier ${input.speedTier}`);
  if (!TUNNEL_NAME_RE.test(input.name ?? "")) {
    throw ValidationError(
      "name must be 1-100 chars, ASCII letters/digits/space/._- only (use Description for other languages)",
    );
  }
  const description = (input.description ?? "").slice(0, 300) || null;
  const protocol: TunnelProtocol = input.protocol ?? "wireguard";
  if (protocol !== "wireguard" && protocol !== "openvpn" && protocol !== "sstp") {
    throw ValidationError(`bad protocol ${protocol}`);
  }
  // Each gateway advertises the protocols it serves via a per-protocol column:
  // WG=wg_public_key, OpenVPN=ovpn_endpoint, SSTP=sstp_endpoint. Select only
  // gateways that serve the chosen protocol.
  const protoFilter =
    protocol === "openvpn"
      ? sql`AND ovpn_endpoint IS NOT NULL`
      : protocol === "sstp"
        ? sql`AND sstp_endpoint IS NOT NULL`
        : sql`AND wg_public_key IS NOT NULL`;

  return sql.begin(async (tx) => {
    const [wallet] = await tx`
      SELECT id, balance_satang FROM credit_wallets
      WHERE user_id = ${input.userId} FOR UPDATE`;
    if (!wallet) throw ValidationError("wallet not found for user");
    if (Number(wallet.balance_satang) < price) {
      throw InsufficientCredit(price, Number(wallet.balance_satang));
    }

    const gw = input.gatewayHostname
      ? await tx`SELECT id, hostname, private_subnet FROM vpn_gateways
                 WHERE hostname = ${input.gatewayHostname}
                   AND status = 'active' ${protoFilter} FOR UPDATE`
      : await tx`SELECT id, hostname, private_subnet FROM vpn_gateways
                 WHERE status = 'active' AND current_tunnels < max_tunnels
                   ${protoFilter}
                 ORDER BY current_tunnels ASC LIMIT 1 FOR UPDATE`;
    if (!gw[0]) throw NoGatewayAvailable();
    const gateway = gw[0];

    // Count ALL rows (incl. soft-deleted): UNIQUE(gateway_id, private_ip)
    // has no deleted_at predicate, so a soft-deleted tunnel still holds its
    // private IP. (Reclaiming freed IPs is a later, separate concern.)
    const usedRows = await tx<{ ip: string }[]>`
      SELECT host(private_ip) AS ip FROM tunnels
      WHERE gateway_id = ${gateway.id}`;
    const used = new Set(usedRows.map((r) => r.ip));
    const privateIp = allocatePrivateIp(gateway.private_subnet, used);

    const kp = generateWireguardKeypair();
    const encPriv = encryptSecret(kp.privateKey);
    const nextBilling = new Date(Date.now() + 31 * DAY_MS);
    const nextBillingIso = nextBilling.toISOString();

    const [tunnel] = await tx`
      INSERT INTO tunnels (user_id, gateway_id, name, description, protocol,
        speed_tier, private_ip, wg_public_key, wg_private_key_encrypted, status,
        next_billing_at)
      VALUES (${input.userId}, ${gateway.id}, ${input.name}, ${description},
        ${protocol}, ${input.speedTier}, ${privateIp}, ${kp.publicKey},
        ${encPriv}, 'provisioning', ${nextBillingIso})
      RETURNING id`;
    const tunnelId = tunnel.id as string;

    const newBalance = Number(wallet.balance_satang) - price;
    await tx`
      UPDATE credit_wallets
      SET balance_satang = ${newBalance},
          lifetime_spent_satang = lifetime_spent_satang + ${price},
          version = version + 1
      WHERE id = ${wallet.id}`;

    const cycle = nextBilling.toISOString().slice(0, 10);
    await tx`
      INSERT INTO credit_transactions (user_id, wallet_id, type,
        amount_satang, balance_after, description, idempotency_key)
      VALUES (${input.userId}, ${wallet.id}, 'subscription_charge',
        ${-price}, ${newBalance}, ${"Tunnel " + input.name + " (" + input.speedTier + ")"},
        ${"buy-tunnel-" + tunnelId + "-" + Date.now()})`;

    await tx`UPDATE vpn_gateways SET current_tunnels = current_tunnels + 1
             WHERE id = ${gateway.id}`;

    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
        resource_id, success, metadata)
      VALUES ('system', ${input.userId}, 'tunnel.create', 'tunnel',
        ${tunnelId}, true,
        ${JSON.stringify({ gateway: gateway.hostname, privateIp, priceSatang: price })}::jsonb)`;

    return {
      tunnelId,
      gatewayId: gateway.id,
      gatewayHostname: gateway.hostname,
      privateIp,
      publicKey: kp.publicKey,
    };
  });
}
