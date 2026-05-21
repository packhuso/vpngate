"use client";
import { useEffect, useState } from "react";
import { Users, Cable, Globe, Wallet, Network } from "lucide-react";

interface KPI {
  users: number;
  activeTunnels: number;
  ipsAllocated: number;
  ipsAvailable: number;
  ipPoolBlocks: number;
  ipPoolAvailable: number;
  totalWalletBalanceSatang: number;
}

const fmtBaht = (s: number) =>
  `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
}
function KpiCard({ icon, label, value, sub }: KpiCardProps) {
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-muted)" }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function AdminOverview() {
  const [k, setK] = useState<KPI | null>(null);
  useEffect(() => {
    void fetch("/v1/admin/overview", { credentials: "same-origin" }).then((r) => r.json()).then(setK);
  }, []);
  if (!k) return <div>Loading overview…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Overview</h1>
        <p className="page-subtitle">สรุป KPI ของระบบ</p>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <KpiCard icon={<Users size={14} strokeWidth={2} />} label="Users" value={k.users} />
        <KpiCard icon={<Cable size={14} strokeWidth={2} />} label="Active tunnels" value={k.activeTunnels} />
        <KpiCard icon={<Globe size={14} strokeWidth={2} />} label="Public IPs"
          value={`${k.ipsAllocated} / ${k.ipsAvailable}`} sub="allocated / available" />
        <KpiCard icon={<Wallet size={14} strokeWidth={2} />} label="Total wallet" value={fmtBaht(k.totalWalletBalanceSatang)} />
        <KpiCard icon={<Network size={14} strokeWidth={2} />} label="IP pools" value={k.ipPoolBlocks} sub={`${k.ipPoolAvailable} IPs free`} />
      </div>
    </div>
  );
}
