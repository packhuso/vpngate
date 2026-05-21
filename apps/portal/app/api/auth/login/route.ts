import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { buildAuthUrl } from "@vpnhub/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/login → CSRF state cookie + redirect to Google
export function GET() {
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildAuthUrl(state));
  res.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
