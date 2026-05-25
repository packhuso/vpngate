import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Wallet, Cable, Globe, Shield, KeyRound, Lock, ArrowRight } from "lucide-react";
import { authConfig, resolveSession } from "@vpnhub/auth";
import { sql } from "@vpnhub/db";
import YourIp from "./your-ip-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fmt = (s: number) =>
  `฿ ${(s / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function Dashboard() {
  const token = (await cookies()).get(authConfig.cookieName)?.value;
  const sess = await resolveSession(token);
  if (!sess) redirect("/");

  const [w] = await sql<{ balance_satang: string }[]>`
    SELECT balance_satang FROM credit_wallets WHERE user_id = ${sess.userId}`;
  const protos = await sql<{ protocol: string; n: number }[]>`
    SELECT protocol, count(*)::int AS n FROM tunnels
    WHERE user_id = ${sess.userId} AND deleted_at IS NULL GROUP BY protocol`;
  const myIps = await sql<{ ip: string }[]>`
    SELECT host(ip_address) AS ip FROM public_ips WHERE user_id = ${sess.userId}`;

  const cnt = (p: string) => Number(protos.find((r) => r.protocol === p)?.n ?? 0);
  const totalTunnels = protos.reduce((s, r) => s + Number(r.n), 0);
  const ipCount = myIps.length;
  const balance = fmt(Number(w?.balance_satang ?? 0));
  const vpnIps = myIps.map((r) => r.ip); // for the live "Your IP" on-VPN check

  const byProto = [
    { key: "wireguard", label: "WireGuard", Icon: Shield, color: "var(--color-primary)" },
    { key: "openvpn", label: "OpenVPN", Icon: KeyRound, color: "#0ea5e9" },
    { key: "sstp", label: "SSTP", Icon: Lock, color: "#d97706" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">ภาพรวมบัญชีของคุณ</p>
      </header>

      {/* Your IP — fetched live client-side (always current, never cached) */}
      <YourIp vpnIps={vpnIps} />

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <StatCard href="/dashboard/wallet" icon={<Wallet size={18} strokeWidth={2} />}
          label="Wallet balance" value={balance} accent="var(--color-primary)" cta="เติม / ดูประวัติ" mono />
        <StatCard href="/dashboard/tunnels" icon={<Cable size={18} strokeWidth={2} />}
          label="Tunnels" value={`${totalTunnels}`} accent="#16a34a" cta="จัดการ tunnels" />
        <StatCard href="/dashboard/ips" icon={<Globe size={18} strokeWidth={2} />}
          label="Public IPs" value={`${ipCount}`} accent="#0ea5e9" cta="จัดการ public IPs" />
      </div>

      {/* Tunnels by type */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 className="section-title">Tunnels by type</h2>
          <Link href="/dashboard/tunnels" style={{ fontSize: 13, color: "var(--color-primary)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
            ดูทั้งหมด <ArrowRight size={14} />
          </Link>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          {byProto.map((p) => (
            <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--color-border)", borderRadius: 10, background: "var(--color-bg)" }}>
              <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 9, background: "var(--color-surface)", color: p.color, border: "1px solid var(--color-border)" }}>
                <p.Icon size={17} strokeWidth={2} />
              </span>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{cnt(p.key)}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2 }}>{p.label}</div>
              </div>
            </div>
          ))}
        </div>
        {totalTunnels === 0 && (
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 12 }}>
            ยังไม่มี tunnel — <Link href="/dashboard/tunnels" style={{ color: "var(--color-primary)" }}>สร้างตัวแรก</Link>
          </p>
        )}
      </div>
    </div>
  );
}

function StatCard({
  href, icon, label, value, accent, cta, mono,
}: {
  href: string; icon: React.ReactNode; label: string; value: string;
  accent: string; cta: string; mono?: boolean;
}) {
  return (
    <Link href={href} className="card" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "grid", placeItems: "center", width: 36, height: 36, borderRadius: 10, background: "var(--color-bg)", color: accent, border: "1px solid var(--color-border)" }}>
          {icon}
        </span>
        <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 12, fontFamily: mono ? "var(--font-mono)" : undefined }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-primary)", marginTop: 8, display: "inline-flex", alignItems: "center", gap: 4 }}>
        {cta} <ArrowRight size={13} />
      </div>
    </Link>
  );
}
