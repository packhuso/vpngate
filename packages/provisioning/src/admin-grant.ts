// Admin grant — allocate a SPECIFIC IP or block from a pool to a customer WITHOUT
// charging the wallet (free grant; admin sets the recurring price). The item
// becomes owned-but-unassigned: user_id set, tunnel_id NULL, status 'allocated'.
// Mirrors buyPublicIp/buyIpBlock minus the wallet read/deduct + credit_transactions.
import { sql } from "@vpnhub/db";
import { BLOCK_SIZE_TO_PREFIX } from "@vpnhub/billing";
import { ValidationError, NotFound } from "./errors";
import { parseCidr, isAligned, cidrContains, intToIp4 } from "./sale-plans";

const DAY_MS = 86_400_000;

function validPrice(p: number) {
  if (!Number.isInteger(p) || p < 0) {
    throw ValidationError("priceSatang must be a non-negative integer");
  }
}

export interface AdminGrantIpInput {
  userId: string;
  ip: string;
  priceSatang: number; // recurring price; 0 = free forever
  adminId?: string | null;
}

/** Grant a specific available single IP to a customer (free, owned, unassigned). */
export async function adminGrantIp(input: AdminGrantIpInput): Promise<{ ip: string }> {
  const { userId, ip, adminId } = input;
  const priceSatang = Number(input.priceSatang);
  if (!userId || !ip) throw ValidationError("userId and ip required");
  validPrice(priceSatang);
  return sql.begin(async (tx) => {
    const [u] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} AND deleted_at IS NULL`;
    if (!u) throw NotFound("user");

    const pools = await tx<{ id: string; block: string }[]>`
      SELECT id, block::text AS block FROM ip_pool`;
    const pool = pools.find((p) => cidrContains(p.block, `${ip}/32`));
    if (!pool) throw ValidationError(`${ip} is not in any ip_pool`);

    const [exist] = await tx<{ status: string }[]>`
      SELECT status FROM public_ips WHERE ip_address = ${ip}::inet`;
    if (exist && ["allocated", "suspended", "reserved", "blacklisted"].includes(exist.status)) {
      throw ValidationError(`${ip} is not available (status=${exist.status})`);
    }

    const nextBilling = new Date(Date.now() + 31 * DAY_MS).toISOString();
    await tx`
      INSERT INTO public_ips (ip_address, pool_id, user_id, tunnel_id,
        status, price_satang, next_billing_at, allocated_at)
      VALUES (${ip}::inet, ${pool.id}, ${userId}, NULL, 'allocated',
        ${priceSatang}, ${nextBilling}, NOW())
      ON CONFLICT (ip_address) DO UPDATE SET
        user_id = EXCLUDED.user_id, tunnel_id = NULL, block_id = NULL,
        status = 'allocated', price_satang = EXCLUDED.price_satang,
        next_billing_at = EXCLUDED.next_billing_at, allocated_at = NOW(),
        released_at = NULL`;

    await tx`UPDATE ip_pool
             SET available_count = available_count - 1,
                 allocated_count = allocated_count + 1
             WHERE id = ${pool.id}`;

    await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
               resource_type, resource_id, success, metadata)
             VALUES ('admin', ${adminId ?? null}, 'ip.admin_grant', 'public_ip', NULL,
               true, ${JSON.stringify({ ip, priceSatang, grantedTo: userId })}::jsonb)`;
    return { ip };
  });
}

export interface AdminGrantBlockInput {
  userId: string;
  cidr: string;
  priceSatang: number;
  adminId?: string | null;
}

/** Grant a specific available aligned block to a customer (free, owned, unassigned). */
export async function adminGrantBlock(
  input: AdminGrantBlockInput,
): Promise<{ cidr: string; blockId: string }> {
  const { userId, cidr, adminId } = input;
  const priceSatang = Number(input.priceSatang);
  if (!userId || !cidr) throw ValidationError("userId and cidr required");
  validPrice(priceSatang);
  if (!isAligned(cidr)) throw ValidationError(`${cidr} is not an aligned block`);
  const { net, size, prefix } = parseCidr(cidr);
  if (!BLOCK_SIZE_TO_PREFIX[size]) throw ValidationError(`unsupported block size /${prefix}`);
  const members = Array.from({ length: size }, (_, i) => intToIp4(net + i));

  return sql.begin(async (tx) => {
    const [u] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} AND deleted_at IS NULL`;
    if (!u) throw NotFound("user");

    const pools = await tx<{ id: string; block: string }[]>`
      SELECT id, block::text AS block FROM ip_pool`;
    const pool = pools.find((p) => cidrContains(p.block, cidr));
    if (!pool) throw ValidationError(`${cidr} is not within any ip_pool`);

    // every member IP must be free (no row with a "taken" status)
    const taken = await tx<{ ip: string }[]>`
      SELECT host(ip_address) AS ip FROM public_ips
      WHERE pool_id = ${pool.id} AND ip_address << ${cidr}::cidr
        AND status IN ('allocated', 'suspended', 'reserved', 'blacklisted')`;
    if (taken.length > 0) {
      throw ValidationError(`${cidr} has ${taken.length} IP(s) already in use`);
    }

    const nextBilling = new Date(Date.now() + 31 * DAY_MS).toISOString();
    const [block] = await tx<{ id: string }[]>`
      INSERT INTO ip_blocks (user_id, pool_id, block, block_size, price_satang,
        status, next_billing_at)
      VALUES (${userId}, ${pool.id}, ${cidr}::cidr, ${size}, ${priceSatang},
        'active', ${nextBilling})
      RETURNING id`;

    for (const ip of members) {
      await tx`
        INSERT INTO public_ips (ip_address, pool_id, user_id, tunnel_id,
          block_id, status, allocated_at)
        VALUES (${ip}::inet, ${pool.id}, ${userId}, NULL,
          ${block.id}, 'allocated', NOW())
        ON CONFLICT (ip_address) DO UPDATE SET
          user_id = EXCLUDED.user_id, tunnel_id = NULL,
          block_id = EXCLUDED.block_id, status = 'allocated',
          allocated_at = NOW(), released_at = NULL, next_billing_at = NULL`;
    }

    await tx`UPDATE ip_pool
             SET available_count = available_count - ${size},
                 allocated_count = allocated_count + ${size}
             WHERE id = ${pool.id}`;

    await tx`INSERT INTO audit_logs (actor_type, actor_id, action,
               resource_type, resource_id, success, metadata)
             VALUES ('admin', ${adminId ?? null}, 'ipblock.admin_grant', 'ip_block',
               ${block.id}, true,
               ${JSON.stringify({ cidr, priceSatang, grantedTo: userId })}::jsonb)`;
    return { cidr, blockId: block.id };
  });
}
