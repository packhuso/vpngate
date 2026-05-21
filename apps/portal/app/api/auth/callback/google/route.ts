import { NextRequest, NextResponse } from "next/server";
import {
  authConfig,
  createSession,
  exchangeCode,
  upsertGoogleUser,
} from "@vpnhub/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/callback/google?code&state
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = req.cookies.get("oauth_state")?.value;

  const base = authConfig.portalBaseUrl();
  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(`${base}/?error=oauth_state`);
  }

  try {
    const profile = await exchangeCode(code);
    const ip =
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const user = await upsertGoogleUser(profile, ip);
    const sess = await createSession(user, {
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });

    const res = NextResponse.redirect(`${base}/dashboard`);
    res.cookies.set(sess.cookieName, sess.token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: sess.maxAge,
    });
    res.cookies.delete("oauth_state");
    return res;
  } catch (e) {
    console.error("oauth callback failed:", e);
    return NextResponse.redirect(`${base}/?error=oauth_failed`);
  }
}
