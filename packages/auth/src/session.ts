// Opaque session token in an HTTP-only cookie; payload in Redis with TTL
// (design §6.2). Mirrored to user_sessions for audit/revocation. Shared by
// the Next.js portal AND the NestJS API so there is one session source.
import { createHash, randomBytes } from "node:crypto";
import IORedis from "ioredis";
import { sql } from "@vpnhub/db";
import { authConfig } from "./config";
import type { AppUser } from "./users";

let redis: IORedis | undefined;
function r(): IORedis {
  if (!redis) redis = new IORedis(authConfig.redisUrl(), { maxRetriesPerRequest: 2 });
  return redis;
}

/** Close the auth Redis client (lets one-shot scripts exit cleanly). */
export async function closeAuthRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = undefined;
  }
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const rkey = (t: string) => `sess:${sha(t)}`;

export interface SessionPayload {
  userId: string;
  email: string;
  isAdmin: boolean;
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export async function createSession(
  user: AppUser,
  meta: SessionMeta = {},
): Promise<{ token: string; cookieName: string; maxAge: number }> {
  const token = randomBytes(32).toString("base64url");
  const ttl = authConfig.sessionTtlSeconds();
  const payload: SessionPayload = {
    userId: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
  };
  await r().set(rkey(token), JSON.stringify(payload), "EX", ttl);
  await sql`
    INSERT INTO user_sessions (user_id, token_hash, user_agent, ip_address,
      expires_at)
    VALUES (${user.id}, ${sha(token)}, ${meta.userAgent ?? null},
      ${meta.ip ?? null}::inet, NOW() + (${ttl} || ' seconds')::interval)`;
  return { token, cookieName: authConfig.cookieName, maxAge: ttl };
}

export async function resolveSession(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const cached = await r().get(rkey(token));
  if (cached) return JSON.parse(cached) as SessionPayload;

  // Redis miss → fall back to DB (then rehydrate cache).
  const [row] = await sql<
    { user_id: string; email: string }[]
  >`
    SELECT s.user_id, u.email
    FROM user_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha(token)}
      AND s.revoked_at IS NULL AND s.expires_at > NOW()
      AND u.deleted_at IS NULL AND u.status = 'active'
    LIMIT 1`;
  if (!row) return null;
  const { isAdmin } = await import("./users");
  const payload: SessionPayload = {
    userId: row.user_id,
    email: row.email,
    isAdmin: await isAdmin(row.email),
  };
  await r().set(rkey(token), JSON.stringify(payload), "EX", 3600);
  return payload;
}

export async function destroySession(token: string | undefined | null) {
  if (!token) return;
  await r().del(rkey(token));
  await sql`UPDATE user_sessions SET revoked_at = NOW()
            WHERE token_hash = ${sha(token)} AND revoked_at IS NULL`;
}

/** Parse a Cookie header → the session token (used by the NestJS guard). */
export function tokenFromCookieHeader(header?: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === authConfig.cookieName) return decodeURIComponent(v.join("="));
  }
  return null;
}
