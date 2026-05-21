import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { sql } from "@vpnhub/db";
import { SessionGuard } from "../auth/session.guard";

@Controller("notifications")
@UseGuards(SessionGuard)
export class NotificationsController {
  // GET /v1/notifications?unreadOnly=&limit=
  @Get()
  async list(
    @Req() req: { user: { userId: string } },
    @Query("unreadOnly") unreadOnly?: string,
    @Query("limit") limit?: string,
  ) {
    const lim = Math.min(Math.max(Number(limit ?? 30), 1), 100);
    const onlyUnread = unreadOnly === "1" || unreadOnly === "true";
    const rows = await sql<
      {
        id: string;
        type: string;
        title: string;
        body: string | null;
        severity: string;
        metadata: unknown;
        read_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT id, type, title, body, severity, metadata, read_at, created_at
      FROM notifications
      WHERE user_id = ${req.user.userId}
        AND ${onlyUnread ? sql`read_at IS NULL` : sql`true`}
      ORDER BY created_at DESC
      LIMIT ${lim}`;
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        severity: n.severity,
        metadata: n.metadata,
        readAt: n.read_at,
        createdAt: n.created_at,
      })),
    };
  }

  // GET /v1/notifications/unread-count — for the bell badge
  @Get("unread-count")
  async unreadCount(@Req() req: { user: { userId: string } }) {
    const [r] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM notifications
      WHERE user_id = ${req.user.userId} AND read_at IS NULL`;
    return { count: Number(r.n) };
  }

  // POST /v1/notifications/read { ids?: string[] } — mark read (all if omitted)
  @Post("read")
  @HttpCode(200)
  async markRead(
    @Req() req: { user: { userId: string } },
    @Body() body: { ids?: string[] },
  ) {
    if (Array.isArray(body?.ids) && body.ids.length > 0) {
      await sql`
        UPDATE notifications SET read_at = NOW()
        WHERE user_id = ${req.user.userId}
          AND id = ANY(${body.ids}::uuid[]) AND read_at IS NULL`;
    } else {
      await sql`
        UPDATE notifications SET read_at = NOW()
        WHERE user_id = ${req.user.userId} AND read_at IS NULL`;
    }
    return { ok: true };
  }
}
