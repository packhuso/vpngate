import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  ProvisionError,
  deleteTunnel,
  changeTunnelTier,
  provisionGreTunnel,
  activateGreTunnel,
  deleteGreTunnel,
} from "@vpnhub/provisioning";
import { SessionGuard } from "../auth/session.guard";
import { sql } from "@vpnhub/db";
import { TunnelsService } from "./tunnels.service";

interface CreateTunnelBody {
  speedTier: "tier_100mb" | "tier_500mb" | "tier_1gb";
  name: string;
  description?: string;
  gatewayHostname?: string;
  protocol?: "wireguard" | "gre";
  // GRE-only — required when protocol === "gre". Domain (e.g. "my.dyn.com")
  // or numeric IPv4. We resolve and cache the IP at create time.
  remoteEndpointHost?: string;
}

@Controller("tunnels")
@UseGuards(SessionGuard) // design §6.2 — session required
export class TunnelsController {
  constructor(private readonly tunnels: TunnelsService) {}

  // GET /v1/tunnels — current user's tunnels
  @Get()
  async list(@Req() req: { user: { userId: string } }) {
    return { tunnels: await this.tunnels.listForUser(req.user.userId) };
  }

  // GET /v1/tunnels/options — which protocols can be created right now
  // (data-driven: a protocol is offered only when an active gateway serves it).
  @Get("options")
  async options() {
    return this.tunnels.availableProtocols();
  }

  // GET /v1/tunnels/:id/config?format=wireguard|mikrotik
  @Get(":id/config")
  async config(
    @Req() req: { user: { userId: string } } & { query: { format?: string } },
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const fmt = req.query?.format === "mikrotik" ? "mikrotik" : "wireguard";
    const r = await this.tunnels.getConfig(req.user.userId, id, fmt);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(r.conf);
  }

  // POST /v1/tunnels — userId comes from the authenticated session, not body.
  @Post()
  @HttpCode(202)
  async create(
    @Req() req: { user: { userId: string } },
    @Body() body: CreateTunnelBody,
  ) {
    if (!body?.speedTier || !body?.name) {
      throw new BadRequestException("speedTier, name required");
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(body.name)) {
      throw new BadRequestException(
        "ชื่อใช้ได้เฉพาะ a-z A-Z 0-9 - _ เท่านั้น (ภาษาไทยให้ใส่ในช่อง Description)",
      );
    }
    const protocol = body.protocol ?? "wireguard";
    if (protocol === "gre") {
      if (!body.remoteEndpointHost) {
        throw new BadRequestException("remoteEndpointHost required for GRE tunnels");
      }
      try {
        const r = await provisionGreTunnel({
          userId: req.user.userId,
          speedTier: body.speedTier,
          name: body.name,
          description: body.description,
          gatewayHostname: body.gatewayHostname,
          remoteEndpointHost: body.remoteEndpointHost,
        });
        // Push to agent async — reply to caller immediately with the ID.
        // On agent failure the tunnel stays status='provisioning'; drift
        // will re-push, or the user can delete + retry.
        void activateGreTunnel(r.tunnelId).catch((e) => {
          console.error(`[gre-activate] tunnel=${r.tunnelId}: ${(e as Error).message}`);
        });
        return {
          tunnelId: r.tunnelId,
          status: "provisioning",
          gateway: r.gatewayHostname,
          privateIp: r.gatewayEndIp,
          protocol: "gre",
          gre: {
            peerId: r.peerId,
            gatewayEndIp: r.gatewayEndIp,
            customerEndIp: r.customerEndIp,
            pointToPointCidr: r.pointToPointCidr,
            greKey: r.greKey,
            remoteEndpointHost: r.remoteEndpointHost,
            remoteEndpointIp: r.remoteEndpointIp,
          },
        };
      } catch (e) {
        if (e instanceof ProvisionError) {
          throw new BadRequestException({ code: e.code, message: e.message });
        }
        throw e;
      }
    }
    try {
      const r = await this.tunnels.provision({
        userId: req.user.userId,
        speedTier: body.speedTier,
        name: body.name,
        description: body.description,
        gatewayHostname: body.gatewayHostname,
        protocol: "wireguard",
      });
      return {
        tunnelId: r.tunnelId,
        status: r.status,
        gateway: r.gatewayHostname,
        privateIp: r.privateIp,
      };
    } catch (e) {
      if (e instanceof ProvisionError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }

  // POST /v1/tunnels/:id/ping?count=N — gateway pings the peer's private IP.
  // count = 1..10 (default 4); 1-packet pings let the portal animate live.
  @Post(":id/ping")
  @HttpCode(200)
  async ping(
    @Req() req: { user: { userId: string } } & { query: { count?: string } },
    @Param("id") id: string,
  ) {
    const c = Number(req.query?.count);
    const count = Number.isFinite(c) && c > 0 ? Math.min(Math.floor(c), 10) : undefined;
    try {
      return await this.tunnels.pingTunnel(req.user.userId, id, count);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // GET /v1/tunnels/:id/traffic?from=ISO&to=ISO&bucket=5m|1h|1d
  // Owner-only time-series aggregation for the portal chart.
  @Get(":id/traffic")
  async traffic(
    @Req() req: { user: { userId: string } } & { query: { from?: string; to?: string; bucket?: string } },
    @Param("id") id: string,
  ) {
    const q = req.query ?? {};
    const from = q.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = q.to ?? new Date().toISOString();
    const bucket = q.bucket === "1h" ? "1h" : q.bucket === "1d" ? "1d" : "5m";
    try {
      return await this.tunnels.getTraffic(req.user.userId, id, from, to, bucket);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // PATCH /v1/tunnels/:id — edit mutable metadata (description). Owner-only.
  @Patch(":id")
  @HttpCode(200)
  async patch(
    @Req() req: { user: { userId: string } },
    @Param("id") id: string,
    @Body() body: { description?: string | null },
  ) {
    try {
      return await this.tunnels.updateDescription(
        req.user.userId, id, body?.description ?? null,
      );
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // POST /v1/tunnels/:id/change-tier — instant upgrade/downgrade. Full-charges
  // new tier's current catalog price, resets billing cycle to +31d, snapshots
  // the new price for grandfathering. No refund of old cycle's remaining time.
  @Post(":id/change-tier")
  @HttpCode(200)
  async changeTier(
    @Req() req: { user: { userId: string } },
    @Param("id") id: string,
    @Body() body: { speedTier: "tier_100mb" | "tier_500mb" | "tier_1gb" },
  ) {
    try {
      return await changeTunnelTier({
        userId: req.user.userId,
        tunnelId: id,
        newTier: body?.speedTier,
      });
    } catch (e) {
      if (e instanceof ProvisionError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }

  // DELETE /v1/tunnels/:id — releases public IPs (no refund), removes peer.
  @Delete(":id")
  async remove(
    @Req() req: { user: { userId: string } },
    @Param("id") id: string,
  ) {
    // Route by protocol so GRE goes through its own cleanup (agent DELETE +
    // interface removal). Both flows honour user ownership.
    const [t] = await sql<{ protocol: string }[]>`
      SELECT protocol FROM tunnels
      WHERE id = ${id} AND user_id = ${req.user.userId} AND deleted_at IS NULL`;
    if (!t) throw new BadRequestException("tunnel not found");
    try {
      if (t.protocol === "gre") {
        await deleteGreTunnel(id, req.user.userId);
        return { deleted: true, protocol: "gre" };
      }
      return await deleteTunnel(id, req.user.userId);
    } catch (e) {
      if (e instanceof ProvisionError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }
}
