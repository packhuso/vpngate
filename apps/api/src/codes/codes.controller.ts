import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { AdminGuard } from "../auth/admin.guard";
import { CodesService } from "./codes.service";

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

interface RedeemBody {
  code: string;
}
interface CreateBatchBody {
  name: string;
  valueSatang: number;
  count: number;
  maxUsesPerUser?: number;
  maxUsesTotal?: number;
  expiresAt?: string | null;
  notes?: string;
}

@Controller()
export class CodesController {
  constructor(private readonly codes: CodesService) {}

  // POST /v1/codes/redeem — customer
  @Post("codes/redeem")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async redeem(
    @Req() req: {
      user: { userId: string };
      headers: Record<string, string | undefined>;
    },
    @Body() body: RedeemBody,
  ) {
    if (!body?.code) throw new BadRequestException("code required");
    const ip =
      req.headers["cf-connecting-ip"] ??
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim();
    return this.codes.redeem(
      req.user.userId,
      body.code,
      ip,
      req.headers["user-agent"],
    );
  }

  // ── admin ───────────────────────────────────────────────────────────────
  @Get("admin/codes/batches")
  @UseGuards(AdminGuard)
  async listBatches() {
    const batches = await this.codes.listBatches();
    return {
      batches: batches.map((b) => ({
        id: b.id,
        name: b.name,
        codeCount: b.code_count,
        redeemedCount: b.redeemed_count,
        valueSatang: Number(b.credit_value_satang),
        totalRedeemedSatang: Number(b.total_credit_redeemed_satang),
        status: b.status,
        expiresAt: b.expires_at,
        createdAt: b.created_at,
      })),
    };
  }

  @Get("admin/codes/batches/:id")
  @UseGuards(AdminGuard)
  async batchDetail(@Param("id") id: string) {
    return { codes: await this.codes.listCodesInBatch(id) };
  }

  // GET /v1/admin/codes/batches/:id/export.csv → CSV download
  @Get("admin/codes/batches/:id/export.csv")
  @UseGuards(AdminGuard)
  async exportBatchCsv(@Param("id") id: string, @Res() res: Response) {
    const { sql } = await import("@vpnhub/db");
    const [batch] = await sql<{ name: string; credit_value_satang: string }[]>`
      SELECT name, credit_value_satang FROM credit_code_batches WHERE id = ${id}`;
    if (!batch) throw new BadRequestException("batch not found");

    const codes = await this.codes.listCodesInBatch(id);
    const valueBaht = (Number(batch.credit_value_satang) / 100).toFixed(2);

    const lines: string[] = [];
    lines.push("code,value_baht,status,uses,max_uses_total,max_uses_per_user,redeemed_by,redeemed_at,batch_name");
    for (const c of codes) {
      if (c.redemptions.length === 0) {
        lines.push([
          csvEscape(c.code),
          valueBaht,
          csvEscape(c.currentUses === 0 ? "unused" : c.status),
          c.currentUses,
          c.maxUsesTotal,
          c.maxUsesPerUser,
          "",
          "",
          csvEscape(batch.name),
        ].join(","));
      } else {
        for (const r of c.redemptions) {
          lines.push([
            csvEscape(c.code),
            valueBaht,
            csvEscape("redeemed"),
            c.currentUses,
            c.maxUsesTotal,
            c.maxUsesPerUser,
            csvEscape(r.userEmail ?? "(deleted)"),
            csvEscape(new Date(r.redeemedAt).toISOString()),
            csvEscape(batch.name),
          ].join(","));
        }
      }
    }

    const safeName = batch.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "batch";
    const today = new Date().toISOString().slice(0, 10);
    // BOM so Excel opens UTF-8 correctly (Thai chars in emails / batch names)
    const body = "﻿" + lines.join("\n") + "\n";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="codes-${safeName}-${today}.csv"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(body);
  }

  @Post("admin/codes/batches")
  @UseGuards(AdminGuard)
  async createBatch(
    @Req() req: { user: { userId: string; email: string } },
    @Body() body: CreateBatchBody,
  ) {
    if (!body?.name || !body?.valueSatang || !body?.count) {
      throw new BadRequestException("name, valueSatang, count required");
    }
    // Resolve adminId — admin_users row by email
    const { sql } = await import("@vpnhub/db");
    const [admin] = await sql<{ id: string }[]>`
      SELECT id FROM admin_users WHERE lower(email) = lower(${req.user.email})
        AND active = true`;
    if (!admin) throw new BadRequestException("admin row not found");
    return this.codes.createBatch(admin.id, {
      name: body.name,
      valueSatang: body.valueSatang,
      count: body.count,
      maxUsesPerUser: body.maxUsesPerUser,
      maxUsesTotal: body.maxUsesTotal,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      notes: body.notes,
    });
  }

  // ── per-code admin actions ────────────────────────────────────────────
  // POST /v1/admin/codes/:codeId/status { status: active|paused|revoked }
  @Post("admin/codes/:codeId/status")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async setCodeStatus(
    @Param("codeId") codeId: string,
    @Body() body: { status: "active" | "paused" | "revoked" },
  ) {
    if (!["active", "paused", "revoked"].includes(body?.status)) {
      throw new BadRequestException("status must be active | paused | revoked");
    }
    return this.codes.setCodeStatus(codeId, body.status);
  }

  // POST /v1/admin/codes/:codeId/expiry { expiresAt: ISO | null }
  @Post("admin/codes/:codeId/expiry")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async setCodeExpiry(
    @Param("codeId") codeId: string,
    @Body() body: { expiresAt: string | null },
  ) {
    return this.codes.setCodeExpiry(codeId, body?.expiresAt ?? null);
  }

  // ── batch-level cascade actions ──────────────────────────────────────
  // POST /v1/admin/codes/batches/:id/status { status }
  @Post("admin/codes/batches/:id/status")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async setBatchStatus(
    @Param("id") id: string,
    @Body() body: { status: "active" | "paused" | "revoked" },
  ) {
    if (!["active", "paused", "revoked"].includes(body?.status)) {
      throw new BadRequestException("status must be active | paused | revoked");
    }
    return this.codes.setBatchCodesStatus(id, body.status);
  }

  // POST /v1/admin/codes/batches/:id/expiry { expiresAt: ISO | null }
  @Post("admin/codes/batches/:id/expiry")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async setBatchExpiry(
    @Param("id") id: string,
    @Body() body: { expiresAt: string | null },
  ) {
    return this.codes.setBatchCodesExpiry(id, body?.expiresAt ?? null);
  }
}
