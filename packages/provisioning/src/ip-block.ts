// IP block lifecycle — blocks are owned independently from tunnels.
// Lifecycle: pool → owned (tunnel_id=NULL on child IPs) → assigned (tunnel_id=X)
// Billing on the block is independent from any tunnel assignment.
import { sql } from "@vpnhub/db";
import { BLOCK_SIZE_TO_PREFIX, IP_BLOCK_SATANG, tierRateKbit } from "@vpnhub/billing";
import { buildGatewayClient } from "./gateway-client";
import {
  InsufficientCredit,
  NoIpAvailable,
  NotFound,
  ValidationError,
} from "./errors";
import { findFreeBlock, ip4ToInt, intToIp4, type SalePlan } from "./sale-plans";

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

export interface BuyBlockResult {
  blockId: string;
  cidr: string;
  ips: string[];
  newBalanceSatang: number;
}

/** Buy a contiguous N-IP block — owned by user, NOT assigned to any tunnel. */
export async function buyIpBlock(
  userId: string,
  blockSize: number,
): Promise<BuyBlockResult> {
  const price = IP_BLOCK_SATANG[blockSize];
  const prefix = BLOCK_SIZE_TO_PREFIX[blockSize];
  if (!price || !prefix) {
    throw ValidationError(`unsupported block_size ${blockSize}`);
  }

  return sql.begin(async (tx) => {
    const wRows: { id: string; balance_satang: string }[] =
      await tx`SELECT id, balance_satang FROM credit_wallets
               WHERE user_id = ${userId} FOR UPDATE`;
    const w = wRows[0];
    if (!w) throw NotFound("wallet");
    if (Number(w.balance_satang) < price) {
      throw InsufficientCredit(price, Number(w.balance_satang));
    }

    const pools: { id: string; block: string }[] =
      await tx`SELECT id, block::text AS block FROM ip_pool`;
    let chosen:
      | { poolId: string; ips: string[]; cidr: string }
      | null = null;

    for (const pool of pools) {
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
      const taken: { ip: string }[] = await tx`
        SELECT host(ip_address) AS ip FROM public_ips
        WHERE pool_id = ${pool.id}
          AND status IN ('allocated', 'suspended', 'blacklisted', 'reserved')`;
      const takenSet = new Set(taken.map((r) => ip4ToInt(r.ip)));

      const found = findFreeBlock(pool.block, plans, blockSize, takenSet);
      if (found) {
        chosen = {
          poolId: pool.id,
          ips: found.ips,
          cidr: `${intToIp4(found.net)}/${prefix}`,
        };
        break;
      }
    }
    if (!chosen) throw NoIpAvailable();

    const nextBilling = new Date(Date.now() + 31 * DAY_MS).toISOString();
    const blockRows: { id: string }[] = await tx`
      INSERT INTO ip_blocks (user_id, pool_id, block, block_size, price_satang,
        status, next_billing_at)
      VALUES (${userId}, ${chosen.poolId}, ${chosen.cidr}::cidr,
        ${blockSize}, ${price}, 'active', ${nextBilling})
      RETURNING id`;
    const block = blockRows[0];

    for (const ip of chosen.ips) {
      await tx`
        INSERT INTO public_ips (ip_address, pool_id, user_id, tunnel_id,
          block_id, status, allocated_at)
        VALUES (${ip}::inet, ${chosen.poolId}, ${userId}, NULL,
          ${block.id}, 'allocated', NOW())
        ON CONFLICT (ip_address) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          tunnel_id = NULL,
          block_id = EXCLUDED.block_id,
          status = 'allocated',
          allocated_at = NOW(),
          released_at = NULL,
          next_billing_at = NULL`;
    }

    await tx`UPDATE ip_pool
             SET available_count = available_count - ${blockSize},
                 allocated_count = allocated_count + ${blockSize}
             WHERE id = ${chosen.poolId}`;

    const newBalance = Number(w.balance_satang) - price;
    await tx`UPDATE credit_wallets
             SET balance_satang = ${newBalance},
                 lifetime_spent_satang = lifetime_spent_satang + ${price},
                 version = version + 1
             WHERE id = ${w.id}`;
    const cycle = nextBilling.slice(0, 10);
    await tx`INSERT INTO credit_transactions (user_id, wallet_id, type,
               amount_satang, balance_after, description, idempotency_key)
             VALUES (${userId}, ${w.id}, 'ip_charge',
               ${-price}, ${newBalance},
               ${"Public IP block " + chosen.cidr},
               ${"buy-block-" + block.id + "-" + Date.now()})`;

    await tx`INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
               resource_id, success, metadata)
             VALUES ('user', ${userId}, 'ipblock.buy', 'ip_block',
               ${block.id}, true,
               ${JSON.stringify({ cidr: chosen.cidr, priceSatang: price })}::jsonb)`;

    return {
      blockId: block.id,
      cidr: chosen.cidr,
      ips: chosen.ips,
      newBalanceSatang: newBalance,
    };
  });
}

/** Move a block to a different tunnel, or detach (toTunnelId=null). */
export async function moveIpBlock(
  userId: string,
  blockId: string,
  toTunnelId: string | null,
): Promise<{ blockId: string; fromTunnelId: string | null; toTunnelId: string | null; ips: string[] }> {
  const r = await sql.begin(async (tx) => {
    const [block] = await tx<
      { id: string; user_id: string }[]
    >`SELECT id, user_id FROM ip_blocks
      WHERE id = ${blockId} AND status = 'active' FOR UPDATE`;
    if (!block) throw NotFound("ip_block");
    if (block.user_id !== userId) {
      throw ValidationError(`block ${blockId} not owned by you`);
    }

    if (toTunnelId) {
      const [toT] = await tx<{ user_id: string; status: string }[]>`
        SELECT user_id, status FROM tunnels
        WHERE id = ${toTunnelId} AND deleted_at IS NULL`;
      if (!toT) throw NotFound("target tunnel");
      if (toT.user_id !== userId) {
        throw ValidationError("cannot assign block to another user's tunnel");
      }
      if (toT.status !== "active") {
        throw ValidationError(`target tunnel is ${toT.status}, must be active`);
      }
    }

    const ipsRows = await tx<
      { ip: string; tunnel_id: string | null }[]
    >`SELECT host(ip_address) AS ip, tunnel_id FROM public_ips
      WHERE block_id = ${blockId}`;
    const fromTunnelId =
      [...new Set(ipsRows.map((r) => r.tunnel_id).filter(Boolean) as string[])][0]
      ?? null;
    if (fromTunnelId === toTunnelId) {
      return { ips: ipsRows.map((r) => r.ip), fromTunnelId, toTunnelId, syncs: [] };
    }

    await tx`UPDATE public_ips SET tunnel_id = ${toTunnelId}
             WHERE block_id = ${blockId}`;
    await tx`INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
               resource_id, success, metadata)
             VALUES ('user', ${userId},
               ${toTunnelId ? "ipblock.assign" : "ipblock.unassign"},
               'ip_block', ${blockId}, true,
               ${JSON.stringify({ from: fromTunnelId, to: toTunnelId })}::jsonb)`;

    const affected = [
      ...(fromTunnelId ? [fromTunnelId] : []),
      ...(toTunnelId ? [toTunnelId] : []),
    ];
    const syncs: TunnelSyncInfo[] = [];
    for (const tid of [...new Set(affected)]) {
      const s = await loadTunnelSync(tx, tid);
      if (s) syncs.push(s);
    }
    return {
      ips: ipsRows.map((r) => r.ip),
      fromTunnelId,
      toTunnelId,
      syncs,
    };
  });

  await pushSyncs(r.syncs, `block-move-${blockId}-${Date.now()}`);
  return {
    blockId,
    fromTunnelId: r.fromTunnelId,
    toTunnelId: r.toTunnelId,
    ips: r.ips,
  };
}

/** Release a block back to the pool — no refund.
 *  Requires the block to be detached from any tunnel first. */
export async function releaseIpBlock(
  userId: string,
  blockId: string,
): Promise<{ blockId: string; freedCount: number }> {
  return sql.begin(async (tx) => {
    const blockRows: {
      id: string;
      pool_id: string;
      block_size: number;
      user_id: string;
    }[] = await tx`SELECT id, pool_id, block_size, user_id FROM ip_blocks
                   WHERE id = ${blockId} AND status = 'active' FOR UPDATE`;
    const block = blockRows[0];
    if (!block) throw NotFound("ip_block");
    if (block.user_id !== userId) {
      throw ValidationError(`block ${blockId} not owned by you`);
    }

    const ipsRows: { ip: string; tunnel_id: string | null }[] =
      await tx`SELECT host(ip_address) AS ip, tunnel_id FROM public_ips
               WHERE block_id = ${blockId}`;
    const stillAttached = ipsRows.filter((r) => r.tunnel_id);
    if (stillAttached.length > 0) {
      throw ValidationError(
        `ปลด block นี้ออกจาก tunnel ก่อนถึงจะ release ได้ (ไม่คืนเงิน)`,
      );
    }

    await tx`UPDATE public_ips
             SET status = 'available', tunnel_id = NULL, user_id = NULL,
                 block_id = NULL, released_at = NOW(), next_billing_at = NULL
             WHERE block_id = ${blockId}`;
    await tx`UPDATE ip_blocks SET status = 'released' WHERE id = ${blockId}`;
    await tx`UPDATE ip_pool
             SET available_count = available_count + ${block.block_size},
                 allocated_count = GREATEST(allocated_count - ${block.block_size}, 0)
             WHERE id = ${block.pool_id}`;
    await tx`INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
               resource_id, success, metadata)
             VALUES ('user', ${userId}, 'ipblock.release', 'ip_block',
               ${blockId}, true,
               ${JSON.stringify({ freed: ipsRows.length })}::jsonb)`;
    return { blockId, freedCount: ipsRows.length };
  });
}
