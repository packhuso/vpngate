import { cookies } from "next/headers";
import { formatBaht, BILLING_CYCLE_DAYS } from "@vpnhub/shared";
import { authConfig, resolveSession } from "@vpnhub/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(authConfig.cookieName)?.value;
  const sess = await resolveSession(token);

  return (
    <main style={{ maxWidth: 720, margin: "10vh auto", padding: "0 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: "var(--color-primary)", color: "#fff",
          display: "grid", placeItems: "center",
          fontWeight: 700, fontSize: 22,
        }}>V</div>
        <h1 style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.025em", margin: 0 }}>VPN Hub</h1>
      </div>
      <p style={{ color: "var(--color-text-muted)", lineHeight: 1.7, fontSize: 16, marginTop: 16 }}>
        Public IPv4 routing สำหรับเครื่องที่อยู่หลัง CGNAT. Pure WireGuard routing —
        tunnel ของคุณจะได้ public IP จริง ไม่มี NAT
      </p>

      <div className="card" style={{ marginTop: 28, display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Tier 100 Mbps</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
            {formatBaht(10000)} <span style={{ fontSize: 12, color: "var(--color-text-muted)", fontWeight: 400 }}>/ {BILLING_CYCLE_DAYS}d</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Public IP /32</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
            {formatBaht(10000)} <span style={{ fontSize: 12, color: "var(--color-text-muted)", fontWeight: 400 }}>/ {BILLING_CYCLE_DAYS}d</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        {sess ? (
          <a href="/dashboard" className="btn btn-primary" style={{ padding: "10px 20px", fontSize: 15 }}>
            Go to dashboard →
          </a>
        ) : (
          <a href="/api/auth/login" className="btn btn-secondary" style={{ padding: "10px 20px", fontSize: 15 }}>
            Sign in with Google
          </a>
        )}
        {sess && (
          <span style={{ marginLeft: 12, color: "var(--color-text-muted)", fontSize: 13 }}>
            signed in as {sess.email}
          </span>
        )}
      </div>
    </main>
  );
}
