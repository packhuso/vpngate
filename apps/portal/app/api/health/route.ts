import { NextResponse } from "next/server";

// GET /api/health — portal liveness (used by Caddy/uptime later)
export function GET() {
  return NextResponse.json({ status: "ok", app: "portal" });
}
