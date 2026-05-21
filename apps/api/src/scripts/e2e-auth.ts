// E2E for the auth machinery (no browser/Google needed):
// upsert user → createSession → resolveSession → cookie parse →
// NestJS SessionGuard (valid + missing) → cleanup.
import { sql } from "@vpnhub/db";
import {
  closeAuthRedis,
  createSession,
  resolveSession,
  destroySession,
  tokenFromCookieHeader,
  upsertGoogleUser,
} from "@vpnhub/auth";
import { SessionGuard } from "../auth/session.guard";

function ctxWithCookie(cookie?: string) {
  const req: { headers: { cookie?: string }; user?: unknown } = {
    headers: cookie ? { cookie } : {},
  };
  return {
    req,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as never,
  };
}

async function main() {
  const sub = "e2e-auth-sub-1";
  const user = await upsertGoogleUser({
    sub,
    email: "e2e-auth@vpnhub.local",
    emailVerified: true,
    name: "E2E Auth",
  });
  console.log("upsertGoogleUser:", user.email, user.id, "isAdmin", user.isAdmin);

  // wallet auto-created by trigger on first insert
  const [w] = await sql`SELECT id FROM credit_wallets WHERE user_id = ${user.id}`;
  if (!w) throw new Error("wallet not auto-created");
  console.log("wallet auto-created ✓");

  const s = await createSession(user, { ip: "203.0.113.9", userAgent: "e2e" });
  const resolved = await resolveSession(s.token);
  if (!resolved || resolved.userId !== user.id) throw new Error("resolve failed");
  console.log("createSession+resolveSession ✓ userId matches");

  const [sessRow] = await sql`
    SELECT 1 FROM user_sessions
    WHERE user_id = ${user.id} AND revoked_at IS NULL AND expires_at > NOW()`;
  if (!sessRow) throw new Error("user_sessions row missing");
  console.log("user_sessions row present ✓");

  const parsed = tokenFromCookieHeader(`foo=bar; session=${s.token}; x=y`);
  if (parsed !== s.token) throw new Error("cookie parse failed");
  console.log("tokenFromCookieHeader ✓");

  const guard = new SessionGuard();
  const ok = ctxWithCookie(`session=${s.token}`);
  if ((await guard.canActivate(ok.ctx)) !== true) throw new Error("guard should allow");
  if ((ok.req.user as { userId: string }).userId !== user.id)
    throw new Error("guard did not attach user");
  console.log("SessionGuard allows valid session + attaches user ✓");

  let denied = false;
  try {
    await guard.canActivate(ctxWithCookie().ctx);
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("guard should reject missing session");
  console.log("SessionGuard rejects missing session (401) ✓");

  await destroySession(s.token);
  if ((await resolveSession(s.token)) !== null) throw new Error("destroy failed");
  console.log("destroySession ✓");

  // cleanup synthetic user (cascade clears wallet/sessions)
  await sql`DELETE FROM users WHERE google_sub = ${sub}`;
  console.log("E2E AUTH: PASS");
}

main()
  .then(async () => {
    await closeAuthRedis();
    await sql.end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("E2E AUTH FAIL:", e);
    await closeAuthRedis().catch(() => {});
    await sql.end().catch(() => {});
    process.exit(1);
  });
