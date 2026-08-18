// Change a tunnel's speed tier immediately. Charges the new tier's current
// catalog price in full, resets next_billing_at to +31 days, and pushes the
// new shaping rate to the gateway. No refund of the old tier's remaining
// billing period — the customer accepts this trade to switch instantly.
//
// The new price is snapshotted into tunnels.price_satang so future admin
// changes to the catalog don't affect this customer (same grandfathering as
// the initial buy — see billing-scheduler.chargeOneTunnel).
import { sql } from "@vpnhub/db";
import {
  tierRateKbit,
  nextBillingAt,
  type SpeedTier,
} from "@vpnhub/billing";
import {
  ProvisionError,
  InsufficientCredit,
  NotFound,
  ValidationError,
} from "./errors";
import { speedTierPrice, tierAllowed } from "./pricing";
import { buildGatewayClient } from "./gateway-client";

// deno-lint-ignore no-explicit-any
type Tx = any;

const VALID_TIERS: SpeedTier[] = ["tier_100mb", "tier_500mb", "tier_1gb"];

export interface ChangeTierInput {
  userId: string;
  tunnelId: string;
  newTier: SpeedTier;
}

export interface ChangeTierResult {
  tunnelId: string;
  oldTier: SpeedTier;
  newTier: SpeedTier;
  chargedSatang: number;
  balanceAfter: number;
  nextBillingAt: string;
}

export async function changeTunnelTier(
  input: ChangeTierInput,
): Promise<ChangeTierResult> {
  const { userId, tunnelId, newTier } = input;
  if (!userId || !tunnelId) throw ValidationError("userId and tunnelId required");
  if (!VALID_TIERS.includes(newTier)) throw ValidationError(`invalid tier ${newTier}`);

  const now = new Date();
  const nextCycle = nextBillingAt(now);
  const newPrice = await speedTierPrice(newTier); // throws if tier disabled in catalog

  // Do the wallet+db mutation in a transaction; push to gateway after commit
  // so a slow/failing gateway can't hold the wallet lock.
  const { oldTier, newBalance, gwEndpoint, gwCaCert, gwToken, pubKey, privateIp, ips, protocol } =
    await sql.begin(async (tx: Tx) => {
      const tRows: {
        id: string;
        user_id: string;
        name: string;
        speed_tier: SpeedTier;
        status: string;
        wg_public_key: string;
        private_ip: string;
        gateway_id: string;
        protocol: string;
      }[] = await tx`
        SELECT id, user_id, name, speed_tier, status,
               wg_public_key, host(private_ip) AS private_ip, gateway_id, protocol
        FROM tunnels
        WHERE id = ${tunnelId} AND user_id = ${userId} AND deleted_at IS NULL
        FOR UPDATE`;
      const t = tRows[0];
      if (!t) throw NotFound("tunnel");
      if (t.speed_tier === newTier) {
        throw ValidationError(`tunnel is already on ${newTier}`);
      }
      if (t.status === "provisioning") {
        throw ValidationError("tunnel is still provisioning, try again in a moment");
      }
      // Protocol-tier allow matrix (admin-configurable in Packages)
      const [proto] = await tx<{ protocol: string }[]>`
        SELECT protocol FROM tunnels WHERE id = ${tunnelId}`;
      if (!(await tierAllowed(proto?.protocol ?? "wireguard", newTier))) {
        throw ValidationError(
          `${newTier} is not available for ${proto?.protocol} — see Packages page`,
        );
      }

      // Wallet: full-charge new tier, no refund of old cycle
      const wRows: { id: string; balance_satang: string }[] = await tx`
        SELECT id, balance_satang FROM credit_wallets
        WHERE user_id = ${userId} FOR UPDATE`;
      const w = wRows[0];
      if (!w) throw NotFound("wallet");
      const bal = Number(w.balance_satang);
      if (bal < newPrice) throw InsufficientCredit(newPrice, bal);

      const newBal = bal - newPrice;
      // Idempotency: user double-clicking within same second → single charge.
      // Key uses now-truncated-to-second so a genuine tier-change 2s later works.
      const idem =
        `tier-change-${tunnelId}-${t.speed_tier}-${newTier}-${Math.floor(now.getTime() / 1000)}`;
      const inserted: { id: string }[] = await tx`
        INSERT INTO credit_transactions (user_id, wallet_id, type,
          amount_satang, balance_after, description, idempotency_key)
        VALUES (${userId}, ${w.id}, 'subscription_charge',
          ${-newPrice}, ${newBal},
          ${`Tier change: ${t.name} ${t.speed_tier} → ${newTier}`},
          ${idem})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) {
        // Same request already charged — return current state without re-charge
        const [wNow] = await tx<{ balance_satang: string }[]>`
          SELECT balance_satang FROM credit_wallets WHERE id = ${w.id}`;
        return {
          oldTier: t.speed_tier, newBalance: Number(wNow.balance_satang),
          gwEndpoint: "", gwCaCert: "", gwToken: "",
          pubKey: "", privateIp: "", ips: [],
        };
      }

      await tx`UPDATE credit_wallets
               SET balance_satang = ${newBal},
                   lifetime_spent_satang = lifetime_spent_satang + ${newPrice},
                   version = version + 1
               WHERE id = ${w.id}`;
      await tx`UPDATE tunnels
               SET speed_tier = ${newTier},
                   price_satang = ${newPrice},
                   next_billing_at = ${nextCycle.toISOString()},
                   last_billed_at = ${now.toISOString()},
                   status = 'active',
                   suspended_at = NULL,
                   delete_after = NULL
               WHERE id = ${tunnelId}`;

      // Gather gateway info + peer's public IPs to push new shaping rate
      const [gw] = await tx<{
        agent_endpoint: string; agent_ca_cert: string; agent_token: string;
      }[]>`SELECT agent_endpoint, agent_ca_cert, agent_token
           FROM vpn_gateways WHERE id = ${t.gateway_id}`;
      const cidrRows = await tx<{ cidr: string }[]>`
        SELECT host(ip_address) || '/32' AS cidr
        FROM public_ips
        WHERE tunnel_id = ${tunnelId} AND status = 'allocated' AND block_id IS NULL
        UNION ALL
        SELECT DISTINCT b.block::text AS cidr
        FROM public_ips p JOIN ip_blocks b ON b.id = p.block_id
        WHERE p.tunnel_id = ${tunnelId} AND p.status = 'allocated'
        ORDER BY cidr`;

      await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
                 resource_type, resource_id, success, metadata)
               VALUES ('user', ${userId}, 'tunnel.tier_change', 'tunnel',
                 ${tunnelId}, true,
                 ${JSON.stringify({
                   fromTier: t.speed_tier,
                   toTier: newTier,
                   priceSatang: newPrice,
                 })}::jsonb)`;

      return {
        oldTier: t.speed_tier,
        newBalance: newBal,
        gwEndpoint: gw?.agent_endpoint ?? "",
        gwCaCert: gw?.agent_ca_cert ?? "",
        gwToken: gw?.agent_token ?? "",
        pubKey: t.wg_public_key,
        privateIp: t.private_ip,
        ips: cidrRows.map((r: { cidr: string }) => r.cidr),
        protocol: t.protocol,
      };
    });

  // Push new speedLimitKbit to gateway. Best-effort — if it fails, drift will
  // reconcile within ~10 min. Tunnel state in DB is already correct.
  if (gwEndpoint) {
    try {
      const client = buildGatewayClient({
        agent_endpoint: gwEndpoint,
        agent_ca_cert: gwCaCert,
        agent_token: gwToken,
      });
      const kbit = tierRateKbit(newTier);
      if (protocol === "gre") {
        // GRE tunnel: patch the interface's HTB rate directly. peerId is
        // derived from the tunnel UUID (matches activateGreTunnel).
        const peerId = tunnelId.replace(/-/g, "").slice(0, 8);
        await client.patchGrePeer(
          peerId,
          { speedLimitKbit: kbit },
          `tier-change-${tunnelId}-${now.getTime()}`,
        );
      } else if (pubKey) {
        await client.updatePeerIps(
          pubKey, privateIp, ips,
          `tier-change-${tunnelId}-${now.getTime()}`,
          kbit,
        );
      }
    } catch (e) {
      console.error(
        `[tier-change] gateway push failed for ${tunnelId}: ${(e as Error).message} ` +
          `(DB updated; drift will reconcile)`,
      );
    }
  }

  return {
    tunnelId,
    oldTier,
    newTier,
    chargedSatang: newPrice,
    balanceAfter: newBalance,
    nextBillingAt: nextCycle.toISOString(),
  };
}
