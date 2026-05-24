import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { sql } from "@vpnhub/db";
import {
  buildGatewayClient,
  cidrContains,
  cidrsOverlap,
  isAligned,
  parseCidr,
  getPricing,
  savePricing,
  getConnectionEvents,
  getOnlineStatus,
  type SavePricingInput,
} from "@vpnhub/provisioning";
import { AdminGuard } from "../auth/admin.guard";

const VALID_BLOCK_SIZES = [2, 4, 8, 16, 32, 64, 128, 256] as const;

/** Push a blackhole add/remove for a pool CIDR to every active gateway.
 *  Best-effort: failures are logged, not fatal (drift will reconcile). */
async function pushBlackholeAllGateways(cidr: string, add: boolean) {
  const gws = await sql<
    { agent_endpoint: string; agent_ca_cert: string; agent_token: string }[]
  >`SELECT agent_endpoint, agent_ca_cert, agent_token
    FROM vpn_gateways WHERE status = 'active'`;
  for (const gw of gws) {
    try {
      await buildGatewayClient(gw).setBlackhole(
        cidr,
        add,
        `pool-blackhole-${cidr}-${add}-${Date.now()}`,
      );
    } catch (e) {
      console.error(`[blackhole] ${add ? "add" : "del"} ${cidr} failed:`, (e as Error).message);
    }
  }
}

@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  // ── packages: pricing + protocol×tier allow matrix (migration 0010) ──
  @Get("pricing")
  async getPricing() {
    return getPricing();
  }

  @Post("pricing")
  async savePricing(
    @Req() req: { user: { email: string } },
    @Body() body: SavePricingInput,
  ) {
    const before = await getPricing();
    try {
      await savePricing(body ?? {});
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const after = await getPricing();

    // Diff before→after so the audit entry shows exactly what the admin changed.
    const speedChanges = after.speed.flatMap((a) => {
      const b = before.speed.find((x) => x.tier === a.tier);
      return b && b.priceSatang !== a.priceSatang
        ? [{ tier: a.tier, from: b.priceSatang, to: a.priceSatang }]
        : [];
    });
    const ipChanges = after.ip.flatMap((a) => {
      const b = before.ip.find((x) => x.blockSize === a.blockSize);
      return b && b.priceSatang !== a.priceSatang
        ? [{ blockSize: a.blockSize, from: b.priceSatang, to: a.priceSatang }]
        : [];
    });
    const allowChanges = after.allow.flatMap((a) => {
      const b = before.allow.find((x) => x.protocol === a.protocol && x.tier === a.tier);
      return b && b.enabled !== a.enabled
        ? [{ protocol: a.protocol, tier: a.tier, from: b.enabled, to: a.enabled }]
        : [];
    });

    if (speedChanges.length || ipChanges.length || allowChanges.length) {
      const [admin] = await sql<{ id: string }[]>`
        SELECT id FROM admin_users
        WHERE lower(email) = lower(${req.user.email}) AND active = true`;
      await sql`
        INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
          resource_id, success, metadata)
        VALUES ('admin', ${admin?.id ?? null}, 'pricing.update', 'pricing', NULL, true,
          ${JSON.stringify({ speed: speedChanges, ip: ipChanges, allow: allowChanges })}::jsonb)`;
    }
    return after;
  }

  // ── overview KPIs ─────────────────────────────────────────────
  @Get("overview")
  async overview() {
    const [u] = await sql<{ n: string }[]>`SELECT count(*)::text n FROM users WHERE deleted_at IS NULL`;
    const [t] = await sql<{ n: string }[]>`SELECT count(*)::text n FROM tunnels WHERE status='active' AND deleted_at IS NULL`;
    const [ips] = await sql<{ a: string; r: string }[]>`SELECT (SELECT count(*) FROM public_ips WHERE status='allocated')::text a, (SELECT count(*) FROM public_ips WHERE status='available')::text r`;
    const [w] = await sql<{ s: string }[]>`SELECT COALESCE(SUM(balance_satang),0)::text s FROM credit_wallets`;
    const [pool] = await sql<{ blk: string; sz: string }[]>`SELECT count(*)::text blk, COALESCE(SUM(available_count)::text,'0') sz FROM ip_pool`;
    return {
      users: Number(u.n),
      activeTunnels: Number(t.n),
      ipsAllocated: Number(ips.a),
      ipsAvailable: Number(ips.r),
      ipPoolBlocks: Number(pool.blk),
      ipPoolAvailable: Number(pool.sz),
      totalWalletBalanceSatang: Number(w.s),
    };
  }

  // ── users ─────────────────────────────────────────────────────
  @Get("users")
  async searchUsers(@Query("q") q?: string) {
    const like = `%${(q ?? "").toLowerCase()}%`;
    const rows = await sql<
      {
        id: string;
        email: string;
        name: string | null;
        status: string;
        last_login_at: Date | null;
        balance_satang: string;
        created_at: Date;
      }[]
    >`
      SELECT u.id, u.email, u.name, u.status, u.last_login_at,
             COALESCE(w.balance_satang::text,'0') balance_satang, u.created_at
      FROM users u
      LEFT JOIN credit_wallets w ON w.user_id = u.id
      WHERE u.deleted_at IS NULL
        AND (${q ? sql`lower(u.email) LIKE ${like} OR lower(u.name) LIKE ${like}` : sql`true`})
      ORDER BY u.last_login_at DESC NULLS LAST LIMIT 50`;
    return {
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        lastLoginAt: u.last_login_at,
        balanceSatang: Number(u.balance_satang),
        createdAt: u.created_at,
      })),
    };
  }

  // GET /v1/admin/tunnels/:id/connection-events — connect/disconnect/ip_change history
  @Get("tunnels/:id/connection-events")
  async tunnelConnectionEvents(
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ) {
    return { events: await getConnectionEvents(id, Number(limit ?? 50)) };
  }

  @Get("users/:id")
  async userDetail(@Param("id") id: string) {
    const [u] = await sql<
      {
        id: string;
        email: string;
        name: string | null;
        status: string;
        balance_satang: string;
        lifetime_topup_satang: string;
        lifetime_spent_satang: string;
        wallet_id: string;
      }[]
    >`
      SELECT u.id, u.email, u.name, u.status,
             w.id wallet_id, w.balance_satang, w.lifetime_topup_satang,
             w.lifetime_spent_satang
      FROM users u JOIN credit_wallets w ON w.user_id = u.id
      WHERE u.id = ${id}`;
    if (!u) throw new BadRequestException("user not found");
    const tunnelRows = await sql<
      { id: string; name: string; status: string; speed_tier: string; price_satang: string | null; private_ip: string; created_at: Date }[]
    >`
      SELECT id, name, status, speed_tier, price_satang,
             host(private_ip) AS private_ip, created_at
      FROM tunnels WHERE user_id = ${id} AND deleted_at IS NULL
      ORDER BY created_at DESC`;
    const onlineMap = await getOnlineStatus(tunnelRows.map((t) => t.id));
    const tunnels = tunnelRows.map((t) => ({
      ...t,
      online: onlineMap[t.id]?.online ?? false,
      last_seen_at: onlineMap[t.id]?.lastSeenAt ?? null,
    }));
    // Standalone single IPs (block members are billed via their block).
    const ips = await sql`
      SELECT host(p.ip_address) AS ip, p.status, p.price_satang,
             t.name AS tunnel_name
      FROM public_ips p
      LEFT JOIN tunnels t ON t.id = p.tunnel_id
      WHERE p.user_id = ${id} AND p.block_id IS NULL
        AND p.status IN ('allocated', 'suspended')
      ORDER BY p.ip_address`;
    const blocks = await sql`
      SELECT id, block::text AS cidr, block_size, price_satang, status
      FROM ip_blocks WHERE user_id = ${id} AND status IN ('active', 'suspended')
      ORDER BY block`;
    return {
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        walletId: u.wallet_id,
        balanceSatang: Number(u.balance_satang),
        lifetimeTopupSatang: Number(u.lifetime_topup_satang),
        lifetimeSpentSatang: Number(u.lifetime_spent_satang),
      },
      tunnels,
      ips,
      blocks,
    };
  }

  // ── per-item price override (grandfathered price for a bought item) ──
  // Sets the LOCKED price the customer is charged next cycle. Audited.
  private async overridePrice(
    adminEmail: string,
    kind: "tunnel" | "ip" | "block",
    ref: string,
    priceSatang: number,
  ) {
    if (!Number.isInteger(priceSatang) || priceSatang < 0) {
      throw new BadRequestException("priceSatang must be a non-negative integer");
    }
    return sql.begin(async (tx) => {
      const [admin] = await tx<{ id: string }[]>`
        SELECT id FROM admin_users WHERE lower(email)=lower(${adminEmail}) AND active=true`;
      let before: number | null = null;
      let userId: string | null = null;
      if (kind === "tunnel") {
        const [r] = await tx<{ price_satang: string | null; user_id: string }[]>`
          SELECT price_satang, user_id FROM tunnels WHERE id = ${ref} AND deleted_at IS NULL FOR UPDATE`;
        if (!r) throw new BadRequestException("tunnel not found");
        before = r.price_satang == null ? null : Number(r.price_satang);
        userId = r.user_id;
        await tx`UPDATE tunnels SET price_satang = ${priceSatang} WHERE id = ${ref}`;
      } else if (kind === "ip") {
        const [r] = await tx<{ price_satang: string | null; user_id: string | null; block_id: string | null }[]>`
          SELECT price_satang, user_id, block_id FROM public_ips WHERE ip_address = ${ref}::inet FOR UPDATE`;
        if (!r) throw new BadRequestException("ip not found");
        if (r.block_id) throw new BadRequestException("IP belongs to a block — edit the block price instead");
        before = r.price_satang == null ? null : Number(r.price_satang);
        userId = r.user_id;
        await tx`UPDATE public_ips SET price_satang = ${priceSatang} WHERE ip_address = ${ref}::inet`;
      } else {
        const [r] = await tx<{ price_satang: string | null; user_id: string }[]>`
          SELECT price_satang, user_id FROM ip_blocks WHERE id = ${ref} FOR UPDATE`;
        if (!r) throw new BadRequestException("block not found");
        before = r.price_satang == null ? null : Number(r.price_satang);
        userId = r.user_id;
        await tx`UPDATE ip_blocks SET price_satang = ${priceSatang} WHERE id = ${ref}`;
      }
      await tx`
        INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
          resource_id, success, metadata)
        VALUES ('admin', ${admin?.id ?? null}, 'pricing.item_override', ${kind}, ${ref}, true,
          ${JSON.stringify({ userId, from: before, to: priceSatang })}::jsonb)`;
      return { ok: true, kind, ref, priceSatang };
    });
  }

  @Post("tunnels/:id/price")
  @HttpCode(200)
  async setTunnelPrice(
    @Req() req: { user: { email: string } },
    @Param("id") id: string,
    @Body() body: { priceSatang: number },
  ) {
    return this.overridePrice(req.user.email, "tunnel", id, body?.priceSatang);
  }

  @Post("ips/:ip/price")
  @HttpCode(200)
  async setIpPrice(
    @Req() req: { user: { email: string } },
    @Param("ip") ip: string,
    @Body() body: { priceSatang: number },
  ) {
    return this.overridePrice(req.user.email, "ip", ip, body?.priceSatang);
  }

  @Post("ip-blocks/:id/price")
  @HttpCode(200)
  async setBlockPrice(
    @Req() req: { user: { email: string } },
    @Param("id") id: string,
    @Body() body: { priceSatang: number },
  ) {
    return this.overridePrice(req.user.email, "block", id, body?.priceSatang);
  }

  // ── credit adjust (replaces SQL admin top-up) ──────────────────
  @Post("users/:id/credit-adjust")
  @HttpCode(200)
  async adjustCredit(
    @Req() req: { user: { email: string } },
    @Param("id") userId: string,
    @Body() body: { amountSatang: number; reason: string },
  ) {
    if (!body?.amountSatang || !body?.reason) {
      throw new BadRequestException("amountSatang (non-zero) and reason required");
    }
    return sql.begin(async (tx) => {
      const [admin] = await tx<{ id: string }[]>`
        SELECT id FROM admin_users WHERE lower(email)=lower(${req.user.email}) AND active=true`;
      if (!admin) throw new BadRequestException("admin not found");
      const [w] = await tx<{ id: string; balance_satang: string }[]>`
        SELECT id, balance_satang FROM credit_wallets
        WHERE user_id = ${userId} FOR UPDATE`;
      if (!w) throw new BadRequestException("wallet not found");
      const newBalance = Number(w.balance_satang) + body.amountSatang;
      if (newBalance < 0) {
        throw new BadRequestException("would make balance negative");
      }
      await tx`
        UPDATE credit_wallets
        SET balance_satang = ${newBalance},
            lifetime_topup_satang = lifetime_topup_satang + GREATEST(${body.amountSatang}, 0),
            lifetime_spent_satang = lifetime_spent_satang + GREATEST(${-body.amountSatang}, 0),
            version = version + 1
        WHERE id = ${w.id}`;
      await tx`
        INSERT INTO credit_transactions (user_id, wallet_id, type,
          amount_satang, balance_after, description, admin_user_id)
        VALUES (${userId}, ${w.id}, 'admin_adjustment',
          ${body.amountSatang}, ${newBalance}, ${body.reason}, ${admin.id})`;
      await tx`
        INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
          resource_id, success, metadata)
        VALUES ('admin', ${admin.id}, 'wallet.adjust', 'user', ${userId}, true,
          ${JSON.stringify({ amountSatang: body.amountSatang, reason: body.reason })}::jsonb)`;
      return { newBalanceSatang: newBalance };
    });
  }

  // ── ip pool view + sale_mode ─────────────────────────────────
  @Get("ips/pools")
  async pools() {
    const rows = await sql<
      {
        id: string;
        block: string;
        block_size: number;
        available_count: number;
        allocated_count: number;
      }[]
    >`SELECT id, block::text AS block, block_size, available_count, allocated_count
      FROM ip_pool ORDER BY block::inet`;
    return { pools: rows };
  }

  // POST /v1/admin/ips/pools — adds a pool AND auto-creates a default
  // sale plan covering the entire pool with the chosen mode/size.
  // Body: { block, defaultSaleMode, defaultBlockSize?, asn?, upstreamProvider?, notes? }
  @Post("ips/pools")
  @HttpCode(200)
  async addPool(
    @Req() req: { user: { email: string } },
    @Body()
    body: {
      block: string;
      defaultSaleMode: "single" | "block";
      defaultBlockSize?: number;
      asn?: string;
      upstreamProvider?: string;
      notes?: string;
    },
  ) {
    if (!body?.block || !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(body.block)) {
      throw new BadRequestException("block (e.g. 203.169.2.0/24) required");
    }
    if (!isAligned(body.block)) {
      throw new BadRequestException(
        `${body.block} is not aligned (host bits are not zero)`,
      );
    }
    const { size, prefix } = parseCidr(body.block);
    if (prefix < 16 || prefix > 32) {
      throw new BadRequestException("prefix must be /16 .. /32");
    }
    if (body.defaultSaleMode !== "single" && body.defaultSaleMode !== "block") {
      throw new BadRequestException("defaultSaleMode must be 'single' or 'block'");
    }
    const defaultBlockSize =
      body.defaultSaleMode === "block" ? body.defaultBlockSize ?? 0 : null;
    if (body.defaultSaleMode === "block") {
      if (
        !defaultBlockSize ||
        !VALID_BLOCK_SIZES.includes(defaultBlockSize as 2)
      ) {
        throw new BadRequestException(
          `defaultBlockSize required for 'block' mode; must be one of ${VALID_BLOCK_SIZES.join(", ")}`,
        );
      }
      if (size < defaultBlockSize) {
        throw new BadRequestException(
          `pool ${body.block} (${size} IPs) smaller than chosen block size ${defaultBlockSize}`,
        );
      }
    }

    const existing = await sql<{ block: string }[]>`
      SELECT block::text AS block FROM ip_pool`;
    for (const e of existing) {
      if (cidrsOverlap(e.block, body.block)) {
        throw new BadRequestException(
          `${body.block} overlaps existing pool ${e.block}`,
        );
      }
    }

    const [admin] = await sql<{ id: string }[]>`
      SELECT id FROM admin_users WHERE lower(email)=lower(${req.user.email})`;

    const result = await sql.begin(async (tx) => {
      const [pool] = await tx<{ id: string }[]>`
        INSERT INTO ip_pool (block, block_size, asn, upstream_provider, notes,
          added_by_admin, available_count, allocated_count)
        VALUES (${body.block}::cidr, ${size},
          ${body.asn ?? null}, ${body.upstreamProvider ?? null},
          ${body.notes ?? null}, ${admin?.id ?? null}, ${size}, 0)
        RETURNING id`;
      const [plan] = await tx<{ id: string }[]>`
        INSERT INTO ip_sale_plans (pool_id, cidr, sale_mode, block_size)
        VALUES (${pool.id}, ${body.block}::cidr, ${body.defaultSaleMode},
          ${defaultBlockSize})
        RETURNING id`;
      return { poolId: pool.id, planId: plan.id };
    });
    await sql`INSERT INTO audit_logs (actor_type, actor_id, action,
      resource_type, resource_id, success, metadata)
      VALUES ('admin', ${admin?.id ?? null}, 'pool.add', 'ip_pool',
        ${result.poolId}, true,
        ${JSON.stringify({
          block: body.block,
          asn: body.asn,
          upstream: body.upstreamProvider,
          defaultSaleMode: body.defaultSaleMode,
          defaultBlockSize,
        })}::jsonb)`;
    // Install a blackhole route for the whole pool so unallocated IPs don't
    // loop with the upstream router (allocated /32s override it).
    await pushBlackholeAllGateways(body.block, true);
    return {
      id: result.poolId,
      block: body.block,
      size,
      planId: result.planId,
    };
  }

  // GET /v1/admin/ips/pools/:poolId/preflight — what would happen if we delete?
  @Get("ips/pools/:poolId/preflight")
  async deletePoolPreflight(@Param("poolId") poolId: string) {
    const [pool] = await sql<
      { id: string; block: string; available_count: number; allocated_count: number }[]
    >`SELECT id, block::text AS block, available_count, allocated_count
      FROM ip_pool WHERE id = ${poolId}`;
    if (!pool) throw new BadRequestException("pool not found");

    const allocatedRows = await sql<
      { ip: string; user_email: string | null; tunnel_name: string | null }[]
    >`
      SELECT host(p.ip_address) AS ip, u.email AS user_email, t.name AS tunnel_name
      FROM public_ips p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN tunnels t ON t.id = p.tunnel_id
      WHERE p.pool_id = ${poolId} AND p.status = 'allocated'
      ORDER BY p.ip_address LIMIT 20`;
    const [allocatedCount] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM public_ips
      WHERE pool_id = ${poolId} AND status = 'allocated'`;
    const [planCount] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ip_sale_plans WHERE pool_id = ${poolId}`;
    const [blockCount] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ip_blocks
      WHERE pool_id = ${poolId} AND status = 'active'`;

    const blocked = Number(allocatedCount.n) > 0 || Number(blockCount.n) > 0;
    return {
      pool: { id: pool.id, block: pool.block },
      canDelete: !blocked,
      allocatedIps: Number(allocatedCount.n),
      activeBlocks: Number(blockCount.n),
      salePlansWillCascade: Number(planCount.n),
      sampleAllocated: allocatedRows.map((r) => ({
        ip: r.ip,
        ownerEmail: r.user_email,
        tunnelName: r.tunnel_name,
      })),
      blockedReason: blocked
        ? Number(allocatedCount.n) > 0
          ? `${allocatedCount.n} IP(s) ยังถูก assign ให้ user อยู่ — ต้องให้ release/refund ก่อน`
          : `${blockCount.n} block(s) ยัง active — ต้องให้ release ก่อน`
        : null,
    };
  }

  // DELETE /v1/admin/ips/pools/:poolId — refuses if any IP is currently
  // assigned to a user. Sale plans (admin metadata) cascade automatically.
  @Delete("ips/pools/:poolId")
  @HttpCode(200)
  async deletePool(
    @Req() req: { user: { email: string } },
    @Param("poolId") poolId: string,
  ) {
    const [pool] = await sql<{ id: string; block: string }[]>`
      SELECT id, block::text AS block FROM ip_pool WHERE id = ${poolId}`;
    if (!pool) throw new BadRequestException("pool not found");

    const [alloc] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM public_ips
      WHERE pool_id = ${poolId} AND status = 'allocated'`;
    if (Number(alloc.n) > 0) {
      throw new BadRequestException(
        `cannot delete pool ${pool.block} — ${alloc.n} IP(s) ยังถูก assign ให้ user อยู่`,
      );
    }
    const [blocks] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ip_blocks
      WHERE pool_id = ${poolId} AND status = 'active'`;
    if (Number(blocks.n) > 0) {
      throw new BadRequestException(
        `cannot delete pool ${pool.block} — ${blocks.n} block(s) ยัง active`,
      );
    }

    const [admin] = await sql<{ id: string }[]>`
      SELECT id FROM admin_users WHERE lower(email)=lower(${req.user.email})`;
    const result = await sql.begin(async (tx) => {
      // sale plans cascade via FK ON DELETE CASCADE.
      // ip_blocks + public_ips have FK without cascade — clean manually.
      // Preflight already blocks if any allocated IPs / active blocks exist,
      // so what remains here is historical (released) data, safe to purge.
      const [planCount] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ip_sale_plans WHERE pool_id = ${poolId}`;
      const [ipRows] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM public_ips WHERE pool_id = ${poolId}`;
      const [blockRows] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ip_blocks WHERE pool_id = ${poolId}`;
      await tx`DELETE FROM public_ips WHERE pool_id = ${poolId}`;
      await tx`DELETE FROM ip_blocks WHERE pool_id = ${poolId}`;
      await tx`DELETE FROM ip_pool WHERE id = ${poolId}`;
      return {
        cascadedPlans: Number(planCount.n),
        removedIpRows: Number(ipRows.n),
        removedBlockRows: Number(blockRows.n),
      };
    });
    await sql`INSERT INTO audit_logs (actor_type, actor_id, action,
      resource_type, resource_id, success, metadata)
      VALUES ('admin', ${admin?.id ?? null}, 'pool.delete', 'ip_pool',
        ${poolId}, true,
        ${JSON.stringify({ block: pool.block, ...result })}::jsonb)`;
    // Remove the pool's blackhole route from all gateways.
    await pushBlackholeAllGateways(pool.block, false);
    return { deleted: true, ...result };
  }

  // GET /v1/admin/ips?pool=<id> — enumerate ALL /32s in the pool, merged
  // with public_ips state (available IPs don't have rows; we synthesize them).
  // Hard cap at 4096 IPs (i.e. /20) to avoid pathological responses.
  @Get("ips")
  async allIps(@Query("pool") poolId?: string) {
    if (!poolId) {
      const rows = await sql<
        {
          ip: string;
          status: string;
          sale_mode: string;
          user_email: string | null;
          tunnel_name: string | null;
          block_id: string | null;
        }[]
      >`
        SELECT host(p.ip_address) AS ip, p.status, p.sale_mode,
               u.email AS user_email, t.name AS tunnel_name, p.block_id
        FROM public_ips p
        LEFT JOIN users u ON u.id = p.user_id
        LEFT JOIN tunnels t ON t.id = p.tunnel_id
        ORDER BY p.ip_address LIMIT 4096`;
      return { ips: rows, truncated: rows.length === 4096 };
    }

    const [pool] = await sql<{ block: string }[]>`
      SELECT block::text AS block FROM ip_pool WHERE id = ${poolId}`;
    if (!pool) throw new BadRequestException("pool not found");

    const { net, size } = parseCidr(pool.block);
    const cap = Math.min(size, 4096);
    const intToIp4 = (n: number): string =>
      [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

    // existing rows for this pool (allocated/reserved/blacklisted/etc.)
    const existing = await sql<
      {
        ip: string;
        status: string;
        sale_mode: string;
        user_email: string | null;
        tunnel_name: string | null;
        block_id: string | null;
      }[]
    >`
      SELECT host(p.ip_address) AS ip, p.status, p.sale_mode,
             u.email AS user_email, t.name AS tunnel_name, p.block_id
      FROM public_ips p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN tunnels t ON t.id = p.tunnel_id
      WHERE p.pool_id = ${poolId}
      ORDER BY p.ip_address`;
    const byIp = new Map(existing.map((r) => [r.ip, r]));

    // sale plans for color-coding (which range each IP belongs to)
    const planRows = await sql<
      { cidr: string; sale_mode: string; block_size: number | null }[]
    >`SELECT cidr::text AS cidr, sale_mode, block_size
      FROM ip_sale_plans WHERE pool_id = ${poolId}`;
    const planSegments = planRows.map((p) => {
      const { net: pnet, size: psize } = parseCidr(p.cidr);
      return { net: pnet, size: psize, mode: p.sale_mode, blockSize: p.block_size };
    });

    const ipv4ToInt = (ip: string): number =>
      ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    const planFor = (ipInt: number) =>
      planSegments.find((s) => ipInt >= s.net && ipInt < s.net + s.size) ?? null;

    const ips = [];
    for (let off = 0; off < cap; off++) {
      const ip = intToIp4(net + off);
      const existingRow = byIp.get(ip);
      const plan = planFor(net + off);
      ips.push(
        existingRow
          ? {
              ...existingRow,
              plan_mode: plan?.mode ?? null,
              plan_block_size: plan?.blockSize ?? null,
            }
          : {
              ip,
              status: "available",
              sale_mode: "single",
              user_email: null,
              tunnel_name: null,
              block_id: null,
              plan_mode: plan?.mode ?? null,
              plan_block_size: plan?.blockSize ?? null,
            },
      );
    }
    return { ips, truncated: size > 4096, poolSize: size };
  }

  @Post("ips/sale-mode")
  @HttpCode(200)
  async setSaleMode(
    @Req() req: { user: { email: string } },
    @Body() body: { ips: string[]; mode: "single" | "block_only" | "reserved" },
  ) {
    if (!Array.isArray(body?.ips) || !["single", "block_only", "reserved"].includes(body?.mode)) {
      throw new BadRequestException("ips[] and mode required");
    }
    let touched = 0;
    for (const ip of body.ips) {
      const [pool] = await sql<{ id: string }[]>`
        SELECT id FROM ip_pool WHERE block >>= ${ip}::inet LIMIT 1`;
      if (!pool) continue;
      await sql`
        INSERT INTO public_ips (ip_address, pool_id, status, sale_mode)
        VALUES (${ip}::inet, ${pool.id}, 'available', ${body.mode})
        ON CONFLICT (ip_address) DO UPDATE SET sale_mode = ${body.mode}
          WHERE public_ips.status = 'available'`;
      touched++;
    }
    return { updated: touched };
  }

  // ── ip sale plans (per pool) ─────────────────────────────────
  @Get("ips/pools/:poolId/sale-plans")
  async listSalePlans(@Param("poolId") poolId: string) {
    const [pool] = await sql<{ id: string; block: string }[]>`
      SELECT id, block::text AS block FROM ip_pool WHERE id = ${poolId}`;
    if (!pool) throw new BadRequestException("pool not found");

    const plans = await sql<
      {
        id: string;
        cidr: string;
        sale_mode: "single" | "block";
        block_size: number | null;
        created_at: Date;
      }[]
    >`SELECT id, cidr::text AS cidr, sale_mode, block_size, created_at
      FROM ip_sale_plans WHERE pool_id = ${poolId}
      ORDER BY cidr::inet`;

    // augment with usage counts per plan
    const augmented = await Promise.all(
      plans.map(async (p) => {
        const [count] = await sql<{ total: string; used: string }[]>`
          SELECT
            (${parseCidr(p.cidr).size})::text AS total,
            (SELECT count(*)::text FROM public_ips
              WHERE pool_id = ${poolId}
                AND ip_address << ${p.cidr}::cidr
                AND status = 'allocated') AS used`;
        return {
          id: p.id,
          cidr: p.cidr,
          saleMode: p.sale_mode,
          blockSize: p.block_size,
          createdAt: p.created_at,
          totalIps: Number(count.total),
          usedIps: Number(count.used),
        };
      }),
    );

    return {
      pool: { id: pool.id, block: pool.block },
      plans: augmented,
    };
  }

  @Post("ips/pools/:poolId/sale-plans")
  @HttpCode(200)
  async addSalePlan(
    @Req() req: { user: { email: string } },
    @Param("poolId") poolId: string,
    @Body()
    body: {
      cidr: string;
      saleMode: "single" | "block";
      blockSize?: number;
    },
  ) {
    if (!body?.cidr || !body?.saleMode) {
      throw new BadRequestException("cidr and saleMode required");
    }
    if (body.saleMode !== "single" && body.saleMode !== "block") {
      throw new BadRequestException("saleMode must be 'single' or 'block'");
    }
    const blockSize = body.saleMode === "block" ? body.blockSize ?? 0 : null;
    if (body.saleMode === "block") {
      if (!blockSize || !VALID_BLOCK_SIZES.includes(blockSize as 2)) {
        throw new BadRequestException(
          `blockSize required for 'block' mode; must be one of ${VALID_BLOCK_SIZES.join(", ")}`,
        );
      }
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(body.cidr)) {
      throw new BadRequestException("invalid cidr format");
    }
    if (!isAligned(body.cidr)) {
      throw new BadRequestException(
        `${body.cidr} is not an aligned CIDR (host bits are not zero)`,
      );
    }

    const [pool] = await sql<{ id: string; block: string }[]>`
      SELECT id, block::text AS block FROM ip_pool WHERE id = ${poolId}`;
    if (!pool) throw new BadRequestException("pool not found");
    if (!cidrContains(pool.block, body.cidr)) {
      throw new BadRequestException(
        `${body.cidr} is not within pool ${pool.block}`,
      );
    }
    if (body.saleMode === "block" && blockSize) {
      const planSize = parseCidr(body.cidr).size;
      if (planSize < blockSize) {
        throw new BadRequestException(
          `plan range ${body.cidr} (${planSize} IPs) smaller than block size ${blockSize}`,
        );
      }
    }

    const existing = await sql<{ cidr: string }[]>`
      SELECT cidr::text AS cidr FROM ip_sale_plans WHERE pool_id = ${poolId}`;
    for (const e of existing) {
      if (cidrsOverlap(e.cidr, body.cidr)) {
        throw new BadRequestException(
          `${body.cidr} overlaps existing plan ${e.cidr}`,
        );
      }
    }

    const [admin] = await sql<{ id: string }[]>`
      SELECT id FROM admin_users WHERE lower(email)=lower(${req.user.email})`;
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO ip_sale_plans (pool_id, cidr, sale_mode, block_size)
      VALUES (${poolId}, ${body.cidr}::cidr, ${body.saleMode},
        ${blockSize ?? null})
      RETURNING id`;
    await sql`INSERT INTO audit_logs (actor_type, actor_id, action,
      resource_type, resource_id, success, metadata)
      VALUES ('admin', ${admin?.id ?? null}, 'sale_plan.add', 'ip_pool',
        ${poolId}, true,
        ${JSON.stringify({ cidr: body.cidr, saleMode: body.saleMode, blockSize })}::jsonb)`;

    return { id: inserted.id };
  }

  @Delete("ips/pools/:poolId/sale-plans/:planId")
  @HttpCode(200)
  async deleteSalePlan(
    @Req() req: { user: { email: string } },
    @Param("poolId") poolId: string,
    @Param("planId") planId: string,
  ) {
    const [plan] = await sql<
      { id: string; cidr: string; pool_id: string }[]
    >`SELECT id, cidr::text AS cidr, pool_id FROM ip_sale_plans WHERE id = ${planId}`;
    if (!plan || plan.pool_id !== poolId) {
      throw new BadRequestException("plan not found in this pool");
    }
    const [used] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM public_ips
      WHERE pool_id = ${poolId}
        AND ip_address << ${plan.cidr}::cidr
        AND status = 'allocated'`;
    if (Number(used.n) > 0) {
      throw new BadRequestException(
        `cannot delete plan ${plan.cidr} — ${used.n} IP(s) currently allocated within it`,
      );
    }

    const [admin] = await sql<{ id: string }[]>`
      SELECT id FROM admin_users WHERE lower(email)=lower(${req.user.email})`;
    await sql`DELETE FROM ip_sale_plans WHERE id = ${planId}`;
    await sql`INSERT INTO audit_logs (actor_type, actor_id, action,
      resource_type, resource_id, success, metadata)
      VALUES ('admin', ${admin?.id ?? null}, 'sale_plan.delete', 'ip_pool',
        ${poolId}, true, ${JSON.stringify({ cidr: plan.cidr })}::jsonb)`;
    return { deleted: true };
  }

  // ── audit log ─────────────────────────────────────────────────
  @Get("audit")
  async audit(
    @Query("action") action?: string,
    @Query("limit") limit?: string,
  ) {
    const lim = Math.min(Math.max(Number(limit ?? 50), 1), 500);
    const rows = await sql<
      {
        id: string;
        actor_type: string;
        actor_email: string | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        success: boolean;
        metadata: unknown;
        created_at: Date;
      }[]
    >`
      SELECT id, actor_type, actor_email, action, resource_type, resource_id,
             success, metadata, created_at
      FROM audit_logs
      WHERE ${action ? sql`action LIKE ${action + "%"}` : sql`true`}
      ORDER BY created_at DESC LIMIT ${lim}`;
    return { logs: rows };
  }
}
