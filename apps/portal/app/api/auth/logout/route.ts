import { NextRequest, NextResponse } from "next/server";
import { authConfig, destroySession } from "@vpnhub/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  const token = req.cookies.get(authConfig.cookieName)?.value;
  await destroySession(token);
  const res = NextResponse.redirect(`${authConfig.portalBaseUrl()}/`);
  res.cookies.delete(authConfig.cookieName);
  return res;
}

export const GET = handle;
export const POST = handle;
