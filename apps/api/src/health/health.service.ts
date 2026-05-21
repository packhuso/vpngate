import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { sql } from "@vpnhub/db";

type Check = { status: "ok" | "error"; detail?: string };

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly log = new Logger(HealthService.name);
  private readonly redis = new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  async check() {
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);
    const healthy = postgres.status === "ok" && redis.status === "ok";
    return {
      status: healthy ? "ok" : "degraded",
      time: new Date().toISOString(),
      checks: { postgres, redis },
    };
  }

  private async checkPostgres(): Promise<Check> {
    try {
      const r = await sql`SELECT 1 AS ok`;
      return r[0]?.ok === 1 ? { status: "ok" } : { status: "error" };
    } catch (e) {
      return { status: "error", detail: (e as Error).message };
    }
  }

  private async checkRedis(): Promise<Check> {
    try {
      if (this.redis.status !== "ready") await this.redis.connect();
      const pong = await this.redis.ping();
      return pong === "PONG" ? { status: "ok" } : { status: "error" };
    } catch (e) {
      return { status: "error", detail: (e as Error).message };
    }
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }
}
