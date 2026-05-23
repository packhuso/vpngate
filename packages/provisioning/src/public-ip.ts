// Public IP lifecycle — IPs are owned independently from tunnels.
// Lifecycle: pool → owned (tunnel_id=NULL) → assigned (tunnel_id=X) → released
// Billing on the IP is independent from any tunnel assignment.
import { sql } from "@vpnhub/db";
import { tierRateKbit } from "@vpnhub/billing";
import { buildGatewayClient } from "./gateway-client";
import { ipPrice } from "./pricing";
import {
  InsufficientCredit,
  NoIpAvailable,
  NotFound,
  ValidationError,
} from "./errors";
import {
  findFreeSingleIp,
  ip4ToInt,
  isIpSellableAsSingle,
  type SalePlan,
} from "./sale-plans";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const DAY_MS = 86_400_000;

interface GwInfo {
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string;
}

interface TunnelSyncInfo {
  tunnelId: string;
  pubKey: string;
  privateIp: string;
  gw: GwInfo;
  ips: string[];
  speedLimitKbit: number;
}

async function loadTunnelSync(
  tx: Tx,
  tunnelId: string,
): Promise<TunnelSyncInfo | null> {
  const tRows: { wg_public_key: string; private_ip: string; gateway_id: string; speed_tier: string }[] =
    await tx`SELECT wg_public_key, host(private_ip) AS private_ip, gateway_id,
                    speed_tier
             FROM tunnels WHERE id = ${tunnelId} AND deleted_at IS NULL`;
  const t = tRows[0];
  if (!t) return null;
  const gwRows: GwInfo[] = await tx`
    SELECT agent_endpoint, agent_ca_cert, agent_token
    FROM vpn_gateways WHERE id = ${t.gateway_id}`;
  const gw = gwRows[0];
  // singles → "/32"; block members → ONE row as the block's CIDR (e.g. /30).
  // The agent groups these as kernel routes + wg allowed-IPs so a 32-IP block
  // is a single /27 route instead of 32 separate /32s.
  const cidrRows: { cidr: string }[] = await tx`
    SELECT host(ip_address) || '/32' AS cidr
    FROM public_ips
    WHERE tunnel_id = ${tunnelId} AND status = 'allocated' AND block_id IS NULL
    UNION ALL
    SELECT DISTINCT b.block::text AS cidr
    FROM public_ips p JOIN ip_blocks b ON b.id = p.block_id
    WHERE p.tunnel_id = ${tunnelId} AND p.status = 'allocated'
    ORDER BY cidr`;
  return {
    tunnelId,
    pubKey: t.wg_public_key,
    privateIp: t.private_ip,
    gw,
    ips: cidrRows.map((r) => r.cidr),
    speedLimitKbit: tierRateKbit(t.speed_tier),
  };
}

async function pushSyncs(syncs: TunnelSyncInfo[], idempotencyTag: string) {
  for (const s of syncs) {
    const t0 = Date.now();
    try {
      await buildGatewayClient(s.gw).updatePeerIps(
        s.pubKey,
        s.privateIp,
        s.ips,
        `${idempotencyTag}-${s.tunnelId}`,
        s.speedLimitKbit,
      );
      console.log(
        `[gw-push] ${idempotencyTag} tunnel=${s.tunnelId.slice(0, 8)} ` +
          `ips=[${s.ips.join(",")}] ok (${Date.now() - t0}ms)`,
      );
    } catch (e) {
      console.error(
        `[gw-push] ${idempotencyTag} tunnel=${s.tunnelId.slice(0, 8)} ` +
          `FAILED after ${Date.now() - t0}ms: ${(e as Error).message}`,
      );
      throw e;
    }
  }
}

export interface BuyIpResult {
  ip: string;
  newBalanceSatang: number;
}

/** Buy a specific public IP — owner-only, NOT assigned to any tunnel yet.
 *  Refuses if the IP is in a block-only sale plan range. */
export async function buyPublicIp(
  userId: string,
  ip: string,
): Promise<BuyIpResult> {
  const SINGLE_IP_SATANG = await ipPrice(1); // admin-configurable (migration 0010)
  return sql.begin(async (tx) => {
    const poolRows: { id: string }[] =
      await tx`SELECT id FROM ip_pool WHERE block >>= ${ip}::inet LIMIT 1`;
    const pool = poolRows[0];
    if (!pool) throw ValidationError(`${ip} is not in any ip_pool block`);

    const planRows: {
      id: string;
      cidr: string;
      sale_mode: "single" | "block";
      block_size: number | null;
    }[] = await tx`SELECT id, cidr::text AS cidr, sale_mode, block_size
                   FROM ip_sale_plans WHERE pool_id = ${pool.id}`;
    const plans: SalePlan[] = planRows.map((p) => ({
      id: p.id,
      cidr: p.cidr,
      saleMode: p.sale_mode,
      blockSize: p.block_size,
    }));
    const sellable = isIpSellableAsSingle(ip, plans);
    if (!sellable.ok) throw ValidationError(sellable.reason);

    const wRows: { id: string; balance_satang: string }[] =
      await tx`SELECT id, balance_satang FROM credit_wallets
               WHERE user_id = ${userId} FOR UPDATE`;
    const w = wRows[0];
    if (!w) throw NotFound("wallet");
    if (Number(w.balance_satang) < SINGLE_IP_SATANG) {
      throw InsufficientCredit(SINGLE_IP_SATANG, Number(w.balance_satang));
    }

    const existingRows: { status: string; user_id: string | null }[] =
      await tx`SELECT status, user_id FROM public_ips WHERE ip_address = ${ip}::inet`;
    const existing = existingRows[0];
    if (existing && existing.status === "allocated") {
      throw ValidationError(`${ip} is already allocated`);
    }

    const nextBilling = new Date(Date.now() + 31 * DAY_MS).toISOString();
    await tx`
      INSERT INTO public_ips (ip_address, pool_id, user_id, tunnel_id,
        status, price_satang, next_billing_at, allocated_at)
      VALUES (${ip}::inet, ${pool.id}, ${userId}, NULL, 'allocated',
        ${SINGLE_IP_SATANG}, ${nextBilling}, NOW())
      ON CONFLICT (ip_address) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        tunnel_id = NULL,
        block_id = NULL,
        status = 'allocated',
        price_satang = EXCLUDED.price_satang,
        next_billing_at = EXCLUDED.next_billing_at,
        allocated_at = NOW(),
        released_at = NULL`;

    await tx`UPDATE ip_pool
             SET available_count = available_count - 1,
                 allocated_count = allocated_count + 1
             WHERE id = ${pool.id}`;

    const newBalance = Number(w.balance_satang) - SINGLE_IP_SATANG;
    await tx`UPDATE credit_wallets
             SET balance_satang = ${newBalance},
                 lifetime_spent_satang = lifetime_spent_satang + ${SINGLE_IP_SATANG},
                 version = version + 1
             WHERE id = ${w.id}`;
    const cycle = nextBilling.slice(0, 10);
    await tx`INSERT INTO credit_transactions (user_id, wallet_id, type,
               amount_satang, balance_after, description, idempotency_key)
             VALUES (${userId}, ${w.id}, 'ip_charge',
               ${-SINGLE_IP_SATANG}, ${newBalance},
               ${"Public IP " + ip},
               ${"buy-ip-" + ip + "-" + Date.now()})`;

    await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
               resource_type, resource_id, success, metadata)
             VALUES ('user', ${userId}, 'ip.buy', 'public_ip', NULL,
               true, ${JSON.stringify({ ip })}::jsonb)`;

    return { ip, newBalanceSatang: newBalance };
  });
}

/** Buy the next available /32 from any 'single' sale plan across all pools.
 *  Falls back to legacy "whole pool as single" when a pool has no plans. */
export async function buyFirstAvailableSingleIp(
  userId: string,
): Promise<BuyIpResult> {
  const pools = await sql<{ id: string; block: string }[]>`
    SELECT id, block::text AS block FROM ip_pool`;
  for (const pool of pools) {
    const planRows = await sql<
      {
        id: string;
        cidr: string;
        sale_mode: "single" | "block";
        block_size: number | null;
      }[]
    >`SELECT id, cidr::text AS cidr, sale_mode, block_size
      FROM ip_sale_plans WHERE pool_id = ${pool.id}`;
    const plans: SalePlan[] = planRows.map((p) => ({
      id: p.id,
      cidr: p.cidr,
      saleMode: p.sale_mode,
      blockSize: p.block_size,
    }));
    const taken = await sql<{ ip: string }[]>`
      SELECT host(ip_address) AS ip FROM public_ips
      WHERE pool_id = ${pool.id} AND status != 'available'`;
    const takenSet = new Set(taken.map((r) => ip4ToInt(r.ip)));
    const candidate = findFreeSingleIp(pool.block, plans, takenSet);
    if (candidate) return await buyPublicIp(userId, candidate);
  }
  throw NoIpAvailable();
}

/** Move an owned IP to a tunnel, between tunnels, or detach (toTunnelId=null).
 *  Same owner only. Refuses block members — use moveIpBlock for those. */
export async function moveIp(
  userId: string,
  ip: string,
  toTunnelId: string | null,
): Promise<{ ip: string; fromTunnelId: string | null; toTunnelId: string | null }> {
  const r = await sql.begin(async (tx) => {
    const [row] = await tx<
      {
        tunnel_id: string | null;
        user_id: string | null;
        block_id: string | null;
        status: string;
      }[]
    >`
      SELECT tunnel_id, user_id, block_id, status FROM public_ips
      WHERE ip_address = ${ip}::inet FOR UPDATE`;
    if (!row) throw NotFound(`public IP ${ip}`);
    if (row.user_id !== userId) throw ValidationError(`${ip} not owned by you`);
    if (row.status !== "allocated") {
      throw ValidationError(`${ip} is not allocated (status=${row.status})`);
    }
    if (row.block_id) {
      throw ValidationError(
        `${ip} belongs to a block — use moveIpBlock(${row.block_id}, ...)`,
      );
    }

    if (toTunnelId) {
      const [toT] = await tx<
        { user_id: string; status: string }[]
      >`SELECT user_id, status FROM tunnels
        WHERE id = ${toTunnelId} AND deleted_at IS NULL`;
      if (!toT) throw NotFound("target tunnel");
      if (toT.user_id !== userId) {
        throw ValidationError("cannot assign IP to another user's tunnel");
      }
      if (toT.status !== "active") {
        throw ValidationError(`target tunnel is ${toT.status}, must be active`);
      }
    }

    const fromTunnelId = row.tunnel_id;
    if (fromTunnelId === toTunnelId) {
      return { fromTunnelId, toTunnelId, syncs: [] };
    }

    await tx`UPDATE public_ips SET tunnel_id = ${toTunnelId}
             WHERE ip_address = ${ip}::inet`;
    await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
               resource_type, resource_id, success, metadata)
             VALUES ('user', ${userId},
               ${toTunnelId ? "ip.assign" : "ip.unassign"},
               'public_ip', NULL, true,
               ${JSON.stringify({ ip, from: fromTunnelId, to: toTunnelId })}::jsonb)`;

    const affected = [
      ...(fromTunnelId ? [fromTunnelId] : []),
      ...(toTunnelId ? [toTunnelId] : []),
    ];
    const syncs: TunnelSyncInfo[] = [];
    for (const tid of [...new Set(affected)]) {
      const s = await loadTunnelSync(tx, tid);
      if (s) syncs.push(s);
    }
    return { fromTunnelId, toTunnelId, syncs };
  });

  await pushSyncs(r.syncs, `ip-move-${ip}-${Date.now()}`);
  return { ip, fromTunnelId: r.fromTunnelId, toTunnelId: r.toTunnelId };
}

/** Release an owned IP back to the pool — no refund.
 *  Requires the IP to be detached from any tunnel first (unassign before release).
 *  Refuses block members. */
export async function releasePublicIp(
  userId: string,
  ip: string,
): Promise<{ ip: string }> {
  await sql.begin(async (tx) => {
    const rows: {
      user_id: string | null;
      tunnel_id: string | null;
      block_id: string | null;
      status: string;
    }[] = await tx`SELECT user_id, tunnel_id, block_id, status
                   FROM public_ips WHERE ip_address = ${ip}::inet FOR UPDATE`;
    const row = rows[0];
    if (!row) throw NotFound(`public IP ${ip}`);
    if (row.user_id !== userId) throw ValidationError(`${ip} not owned by you`);
    if (row.status !== "allocated") {
      throw ValidationError(`${ip} is not allocated (status=${row.status})`);
    }
    if (row.block_id) {
      throw ValidationError(`${ip} belongs to a block — release the block instead`);
    }
    if (row.tunnel_id) {
      throw ValidationError(
        `ปลด ${ip} ออกจาก tunnel ก่อนถึงจะ release ได้ (ไม่คืนเงิน)`,
      );
    }

    await tx`UPDATE public_ips
             SET status = 'available', tunnel_id = NULL, user_id = NULL,
                 released_at = NOW(), next_billing_at = NULL
             WHERE ip_address = ${ip}::inet`;
    await tx`UPDATE ip_pool
             SET available_count = available_count + 1,
                 allocated_count = GREATEST(allocated_count - 1, 0)
             FROM public_ips p
             WHERE p.ip_address = ${ip}::inet AND ip_pool.id = p.pool_id`;
    await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
               resource_type, resource_id, success, metadata)
             VALUES ('user', ${userId}, 'ip.release', 'public_ip', NULL,
               true, ${JSON.stringify({ ip })}::jsonb)`;
  });
  return { ip };
}
