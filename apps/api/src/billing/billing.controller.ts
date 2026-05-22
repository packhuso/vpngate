import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { sql } from "@vpnhub/db";
import { type SpeedTier } from "@vpnhub/billing";
import { getPricing } from "@vpnhub/provisioning";
import { SessionGuard } from "../auth/session.guard";

interface TunnelRow {
  id: string;
  name: string;
  speed_tier: SpeedTier;
  status: string;
  next_billing_at: Date;
  suspended_at: Date | null;
  delete_after: Date | null;
}
interface IpRow {
  ip: string;
  status: string;
  next_billing_at: Date | null;
  suspended_at: Date | null;
  delete_after: Date | null;
  tunnel_name: string | null;
}
interface BlockRow {
  id: string;
  cidr: string;
  block_size: number;
  price_satang: string;
  status: string;
  next_billing_at: Date;
  suspended_at: Date | null;
  delete_after: Date | null;
}

@Controller("billing")
@UseGuards(SessionGuard)
export class BillingController {
  // GET /v1/billing/summary — MRR, active items, items at risk
  @Get("summary")
  async summary(@Req() req: { user: { userId: string } }) {
    const userId = req.user.userId;

    const [w] = await sql<
      {
        balance_satang: string;
        lifetime_topup_satang: string;
        lifetime_spent_satang: string;
      }[]
    >`SELECT balance_satang, lifetime_topup_satang, lifetime_spent_satang
      FROM credit_wallets WHERE user_id = ${userId}`;
    const balance = Number(w?.balance_satang ?? 0);

    const tunnels = await sql<TunnelRow[]>`
      SELECT id, name, speed_tier, status, next_billing_at,
             suspended_at, delete_after
      FROM tunnels
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY next_billing_at ASC`;
    const ips = await sql<IpRow[]>`
      SELECT host(p.ip_address) AS ip, p.status, p.next_billing_at,
             p.suspended_at, p.delete_after, t.name AS tunnel_name
      FROM public_ips p
      LEFT JOIN tunnels t ON t.id = p.tunnel_id
      WHERE p.user_id = ${userId} AND p.block_id IS NULL
        AND p.status IN ('allocated', 'suspended')
      ORDER BY p.next_billing_at ASC NULLS LAST`;
    const blocks = await sql<BlockRow[]>`
      SELECT id, block::text AS cidr, block_size, price_satang::text AS price_satang,
             status, next_billing_at, suspended_at, delete_after
      FROM ip_blocks
      WHERE user_id = ${userId} AND status IN ('active', 'suspended')
      ORDER BY next_billing_at ASC`;

    // Pricing comes from the admin-configurable tables (migration 0010).
    const pricing = await getPricing();
    const tierPrice = new Map(pricing.speed.map((s) => [s.tier, s.priceSatang]));
    const ipUnit = pricing.ip.find((i) => i.blockSize === 1)?.priceSatang ?? 0;
    const blockPrice = new Map(pricing.ip.map((i) => [i.blockSize, i.priceSatang]));

    // Compute MRR (next-cycle obligation) — sum of recurring prices for each
    // active item, regardless of when the cycle hits.
    const mrrTunnels = tunnels.reduce(
      (n, t) => n + (tierPrice.get(t.speed_tier) ?? 0),
      0,
    );
    const mrrIps = ips.length * ipUnit;
    const mrrBlocks = blocks.reduce(
      (n, b) => n + (blockPrice.get(b.block_size) ?? Number(b.price_satang)),
      0,
    );
    const mrr = mrrTunnels + mrrIps + mrrBlocks;

    const formatItem = <T extends { suspended_at: Date | null; delete_after: Date | null }>(
      o: T,
      kind: string,
      label: string,
      priceSatang: number,
      nextBillingAt: Date | null,
      extra: Record<string, unknown> = {},
    ) => ({
      kind,
      label,
      priceSatang,
      nextBillingAt,
      suspended: !!o.suspended_at,
      deleteAfter: o.delete_after,
      ...extra,
    });

    const items = [
      ...tunnels.map((t) =>
        formatItem(t, "tunnel", t.name, tierPrice.get(t.speed_tier) ?? 0,
          t.next_billing_at, { id: t.id, status: t.status, speedTier: t.speed_tier }),
      ),
      ...ips.map((p) =>
        formatItem(p, "ip", `${p.ip}/32`, ipUnit,
          p.next_billing_at, { ip: p.ip, status: p.status, tunnel: p.tunnel_name }),
      ),
      ...blocks.map((b) =>
        formatItem(b, "block", b.cidr,
          blockPrice.get(b.block_size) ?? Number(b.price_satang),
          b.next_billing_at, { id: b.id, status: b.status, blockSize: b.block_size }),
      ),
    ].sort((a, b) => {
      const ax = a.nextBillingAt ? new Date(a.nextBillingAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bx = b.nextBillingAt ? new Date(b.nextBillingAt).getTime() : Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });

    const atRisk = items.filter(
      (x) => x.suspended || (x.deleteAfter && new Date(x.deleteAfter) > new Date()),
    );

    return {
      balanceSatang: balance,
      lifetimeTopupSatang: Number(w?.lifetime_topup_satang ?? 0),
      lifetimeSpentSatang: Number(w?.lifetime_spent_satang ?? 0),
      mrr: {
        totalSatang: mrr,
        tunnelsSatang: mrrTunnels,
        ipsSatang: mrrIps,
        blocksSatang: mrrBlocks,
      },
      counts: {
        tunnels: tunnels.length,
        ips: ips.length,
        blocks: blocks.length,
      },
      items,
      atRisk,
      runwayDays:
        mrr > 0
          ? Math.floor((balance / mrr) * 31) // days at current MRR
          : null,
    };
  }

  // GET /v1/billing/pricing — current packages (speed prices, IP prices, and the
  // protocol×tier allow matrix) so the portal can show prices + offer only the
  // tiers an admin enabled for the chosen protocol.
  @Get("pricing")
  async pricing() {
    return getPricing();
  }

  // GET /v1/billing/transactions?limit=50&offset=0&type=
  @Get("transactions")
  async transactions(
    @Req() req: { user: { userId: string } },
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("type") type?: string,
  ) {
    const lim = Math.min(Math.max(Number(limit ?? 50), 1), 200);
    const off = Math.max(Number(offset ?? 0), 0);
    const rows = await sql<
      {
        id: string;
        type: string;
        amount_satang: string;
        balance_after: string;
        description: string;
        idempotency_key: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, type, amount_satang, balance_after, description,
             idempotency_key, created_at
      FROM credit_transactions
      WHERE user_id = ${req.user.userId}
        AND ${type ? sql`type = ${type}` : sql`true`}
      ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`;
    const [c] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM credit_transactions
      WHERE user_id = ${req.user.userId}
        AND ${type ? sql`type = ${type}` : sql`true`}`;
    return {
      transactions: rows.map((t) => ({
        id: t.id,
        type: t.type,
        amountSatang: Number(t.amount_satang),
        balanceAfter: Number(t.balance_after),
        description: t.description,
        idempotencyKey: t.idempotency_key,
        createdAt: t.created_at,
      })),
      total: Number(c.n),
      limit: lim,
      offset: off,
    };
  }
}
