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
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { ProvisionError, deleteTunnel } from "@vpnhub/provisioning";
import { SessionGuard } from "../auth/session.guard";
import { TunnelsService } from "./tunnels.service";

interface CreateTunnelBody {
  speedTier: "tier_100mb" | "tier_500mb" | "tier_1gb";
  name: string;
  description?: string;
  gatewayHostname?: string;
  protocol?: "wireguard" | "openvpn" | "sstp";
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

  // GET /v1/tunnels/:id/sstp-credentials — issues + caches the SSTP creds on
  // first call so the detail page can show them without downloading the .rsc.
  @Get(":id/sstp-credentials")
  async sstpCredentials(
    @Req() req: { user: { userId: string } },
    @Param("id") id: string,
  ) {
    try {
      return await this.tunnels.sstpCredentials(req.user.userId, id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // GET /v1/tunnels/:id/config?format=wireguard|mikrotik
  @Get(":id/config")
  async config(
    @Req() req: { user: { userId: string } } & {
      query: { format?: string };
    },
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const q = req.query?.format;
    const fmt =
      q === "mikrotik"
        ? "mikrotik"
        : q === "openvpn" || q === "ovpn"
          ? "openvpn"
          : q === "sstp"
            ? "sstp"
            : "wireguard";
    const r = await this.tunnels.getConfig(req.user.userId, id, fmt);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${r.filename}"`,
    );
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
    try {
      const r = await this.tunnels.provision({
        userId: req.user.userId,
        speedTier: body.speedTier,
        name: body.name,
        description: body.description,
        gatewayHostname: body.gatewayHostname,
        protocol: body.protocol ?? "wireguard",
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

  // DELETE /v1/tunnels/:id — releases public IPs (no refund), removes peer.
  @Delete(":id")
  async remove(
    @Req() req: { user: { userId: string } },
    @Param("id") id: string,
  ) {
    try {
      return await deleteTunnel(id, req.user.userId);
    } catch (e) {
      if (e instanceof ProvisionError) {
        throw new BadRequestException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }
}
