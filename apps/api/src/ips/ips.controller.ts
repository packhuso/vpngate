import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { sql } from "@vpnhub/db";
import {
  ProvisionError,
  buyFirstAvailableSingleIp,
  buyIpBlock,
  buyPublicIp,
  moveIp,
  moveIpBlock,
  releaseIpBlock,
  releasePublicIp,
} from "@vpnhub/provisioning";
import { SessionGuard } from "../auth/session.guard";

@Controller("ips")
@UseGuards(SessionGuard)
export class IpsController {
  // GET /v1/ips — singles + blocks owned by current user (assigned OR not).
  @Get()
  async list(@Req() req: { user: { userId: string } }) {
    const singles = await sql<
      { ip: string; tunnel_id: string | null; allocated_at: Date }[]
    >`
      SELECT host(ip_address) AS ip, tunnel_id, allocated_at
      FROM public_ips
      WHERE user_id = ${req.user.userId}
        AND status = 'allocated' AND block_id IS NULL
      ORDER BY ip_address`;
    const blocks = await sql<
      {
        id: string;
        cidr: string;
        block_size: number;
        tunnel_id: string | null;
        ip_count: string;
      }[]
    >`
      SELECT b.id, b.block::text AS cidr, b.block_size,
        (SELECT tunnel_id FROM public_ips
          WHERE block_id = b.id LIMIT 1) AS tunnel_id,
        (SELECT count(*) FROM public_ips
          WHERE block_id = b.id AND status='allocated')::text AS ip_count
      FROM ip_blocks b
      WHERE b.user_id = ${req.user.userId} AND b.status = 'active'
      ORDER BY b.created_at DESC`;
    return {
      singles: singles.map((s) => ({
        ip: s.ip,
        tunnelId: s.tunnel_id,
        allocatedAt: s.allocated_at,
      })),
      blocks: blocks.map((b) => ({
        id: b.id,
        cidr: b.cidr,
        blockSize: b.block_size,
        tunnelId: b.tunnel_id,
        ipCount: Number(b.ip_count),
      })),
    };
  }

  // POST /v1/ips/single { ip? } — buy a single /32 (NOT assigned to a tunnel)
  @Post("single")
  @HttpCode(200)
  async buySingle(
    @Req() req: { user: { userId: string } },
    @Body() body: { ip?: string },
  ) {
    return this.wrap(() =>
      body?.ip
        ? buyPublicIp(req.user.userId, body.ip)
        : buyFirstAvailableSingleIp(req.user.userId),
    );
  }

  // POST /v1/ips/block { blockSize } — buy a block (NOT assigned)
  @Post("block")
  @HttpCode(200)
  async buyBlock(
    @Req() req: { user: { userId: string } },
    @Body() body: { blockSize: number },
  ) {
    if (!body?.blockSize) throw new BadRequestException("blockSize required");
    return this.wrap(() => buyIpBlock(req.user.userId, body.blockSize));
  }

  // DELETE /v1/ips/single/:ip — release back to pool (no refund)
  @Delete("single/:ip")
  async releaseSingle(
    @Req() req: { user: { userId: string } },
    @Param("ip") ip: string,
  ) {
    return this.wrap(() => releasePublicIp(req.user.userId, ip));
  }

  // DELETE /v1/ips/block/:blockId — release block (no refund)
  @Delete("block/:blockId")
  async releaseBlock(
    @Req() req: { user: { userId: string } },
    @Param("blockId") blockId: string,
  ) {
    return this.wrap(() => releaseIpBlock(req.user.userId, blockId));
  }

  // POST /v1/ips/single/:ip/move { toTunnelId|null }
  // toTunnelId = null/"" → unassign (keep ownership + billing)
  @Post("single/:ip/move")
  @HttpCode(200)
  async moveSingleIp(
    @Req() req: { user: { userId: string } },
    @Param("ip") ip: string,
    @Body() body: { toTunnelId: string | null },
  ) {
    const to = body?.toTunnelId || null;
    return this.wrap(() => moveIp(req.user.userId, ip, to));
  }

  // POST /v1/ips/block/:blockId/move { toTunnelId|null }
  @Post("block/:blockId/move")
  @HttpCode(200)
  async moveBlockIp(
    @Req() req: { user: { userId: string } },
    @Param("blockId") blockId: string,
    @Body() body: { toTunnelId: string | null },
  ) {
    const to = body?.toTunnelId || null;
    return this.wrap(() => moveIpBlock(req.user.userId, blockId, to));
  }

  private async wrap<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProvisionError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }
}
