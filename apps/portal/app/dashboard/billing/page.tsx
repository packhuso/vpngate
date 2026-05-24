"use client";
import { useCallback, useEffect, useState } from "react";
import { fmtDate, fmtDateTime } from "../../_lib/datetime";
import { Wallet, Repeat, Calendar, AlertTriangle, Cable, Globe, Boxes } from "lucide-react";

interface Item {
  kind: "tunnel" | "ip" | "block";
  label: string;
  priceSatang: number;
  nextBillingAt: string | null;
  suspended: boolean;
  deleteAfter: string | null;
  status?: string;
  speedTier?: string;
  blockSize?: number;
  tunnel?: string | null;
  id?: string;
  ip?: string;
}
interface Summary {
  balanceSatang: number;
  lifetimeTopupSatang: number;
  lifetimeSpentSatang: number;
  mrr: { totalSatang: number; tunnelsSatang: number; ipsSatang: number; blocksSatang: number };
  counts: { tunnels: number; ips: number; blocks: number };
  items: Item[];
  atRisk: Item[];
  runwayDays: number | null;
}
interface Tx {
  id: string; type: string;
  amountSatang: number; balanceAfter: number;
  description: string; idempotencyKey: string | null;
  createdAt: string;
}

const fmt = (s: number) =>
  `฿${(s / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysFromNow = (s: string | null) => {
  if (!s) return null;
  return Math.ceil((new Date(s).getTime() - Date.now()) / 86_400_000);
};

function KindBadge({ it }: { it: Item }) {
  if (it.kind === "tunnel") return <span className="badge badge-primary"><Cable size={11} strokeWidth={2.2} />tunnel</span>;
  if (it.kind === "ip") return <span className="badge badge-success"><Globe size={11} strokeWidth={2.2} />IP <span style={{ opacity: 0.7 }}>· 1 IP</span></span>;
  const count = it.blockSize ?? 0;
  return <span className="badge badge-info"><Boxes size={11} strokeWidth={2.2} />IP <span style={{ opacity: 0.7 }}>· {count} IPs</span></span>;
}

export default function BillingPage() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txOffset, setTxOffset] = useState(0);
  const [txType, setTxType] = useState("");
  const TX_LIMIT = 25;

  const load = useCallback(async () => {
    const r = await fetch("/v1/billing/summary", { credentials: "same-origin" });
    if (r.ok) setSum(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadTxs = useCallback(async () => {
    const q = new URLSearchParams({ limit: String(TX_LIMIT), offset: String(txOffset) });
    if (txType) q.set("type", txType);
    const r = await fetch(`/v1/billing/transactions?${q.toString()}`, { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      setTxs(d.transactions); setTxTotal(d.total);
    }
  }, [txOffset, txType]);
  useEffect(() => { void loadTxs(); }, [loadTxs]);

  if (!sum) return <div>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Billing</h1>
        <p className="page-subtitle">สรุปค่าใช้จ่ายรายเดือน, รายการที่ active, และประวัติการเรียกเก็บ</p>
      </header>

      {/* 4 KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <Wallet size={14} strokeWidth={2} /> Wallet balance
          </div>
          <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)" }}>{fmt(sum.balanceSatang)}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <Repeat size={14} strokeWidth={2} /> Monthly recurring
          </div>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)" }}>{fmt(sum.mrr.totalSatang)}</div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>
            tunnels {fmt(sum.mrr.tunnelsSatang)} · IP {fmt(sum.mrr.ipsSatang)} · IP Blocks {fmt(sum.mrr.blocksSatang)}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <Calendar size={14} strokeWidth={2} /> Estimated runway
          </div>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)" }}>
            {sum.runwayDays === null ? "—" : `${sum.runwayDays} day${sum.runwayDays === 1 ? "" : "s"}`}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>at current monthly rate</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Active items</div>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)" }}>{sum.items.length}</div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>
            tunnels {sum.counts.tunnels} · IP {sum.counts.ips} · IP Blocks {sum.counts.blocks}
          </div>
        </div>
      </div>

      {/* At-risk panel */}
      {sum.atRisk.length > 0 && (
        <div className="card" style={{ borderColor: "var(--color-danger)", background: "var(--color-danger-soft)" }}>
          <h2 className="section-title" style={{ color: "var(--color-danger)", display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={18} strokeWidth={2} /> {sum.atRisk.length} item(s) at risk
          </h2>
          <p style={{ fontSize: 13, color: "var(--color-danger)", marginTop: 4 }}>
            เงินไม่พอจะถูกระงับ และลบหลัง 3 วัน — เติมเงินด่วน
          </p>
          <table className="table-default" style={{ marginTop: 12 }}>
            <thead>
              <tr><th>Kind</th><th>Item</th><th>Price/cycle</th><th>Delete after</th></tr>
            </thead>
            <tbody>
              {sum.atRisk.map((it, i) => (
                <tr key={i}>
                  <td><KindBadge it={it} /></td>
                  <td className="mono">{it.label}</td>
                  <td>{fmt(it.priceSatang)}</td>
                  <td style={{ color: "var(--color-danger)" }}>
                    {fmtDate(it.deleteAfter)} ({daysFromNow(it.deleteAfter)} day(s) left)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Active items */}
      <div className="card">
        <h2 className="section-title">Active items <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({sum.items.length})</span></h2>
        <table className="table-default" style={{ marginTop: 12 }}>
          <thead>
            <tr><th>Kind</th><th>Item</th><th>Status</th><th>Price/cycle</th><th>Next bill</th></tr>
          </thead>
          <tbody>
            {sum.items.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>No recurring items yet.</td></tr>
            )}
            {sum.items.map((it, i) => {
              const days = daysFromNow(it.nextBillingAt);
              const overdue = days !== null && days < 0;
              return (
                <tr key={i}>
                  <td><KindBadge it={it} /></td>
                  <td className="mono">
                    {it.label}
                    {it.tunnel && <span style={{ color: "var(--color-text-muted)" }}> · {it.tunnel}</span>}
                  </td>
                  <td>
                    {it.suspended
                      ? <span className="badge badge-danger">suspended</span>
                      : <span className="badge badge-success">{it.status ?? "active"}</span>}
                  </td>
                  <td className="mono">{fmt(it.priceSatang)}</td>
                  <td className="mono" style={{ color: overdue ? "var(--color-warning)" : "inherit" }}>
                    {fmtDate(it.nextBillingAt)}
                    {days !== null && <span style={{ color: "var(--color-text-muted)" }}> · {days >= 0 ? `in ${days}d` : `${-days}d ago`}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Transaction history */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <h2 className="section-title">Transaction history <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({txTotal})</span></h2>
          <select className="input" value={txType} onChange={(e) => { setTxType(e.target.value); setTxOffset(0); }} style={{ width: 200 }}>
            <option value="">all types</option>
            <option value="topup">topup</option>
            <option value="subscription_charge">subscription_charge</option>
            <option value="ip_charge">ip_charge</option>
            <option value="admin_adjustment">admin_adjustment</option>
            <option value="code_redemption">code_redemption</option>
            <option value="refund">refund</option>
          </select>
        </div>
        <table className="table-default mono">
          <thead>
            <tr><th>Date</th><th>Type</th><th>Description</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ textAlign: "right" }}>Balance</th></tr>
          </thead>
          <tbody>
            {txs.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>No transactions.</td></tr>
            )}
            {txs.map((t) => (
              <tr key={t.id}>
                <td style={{ color: "var(--color-text-muted)" }}>{fmtDateTime(t.createdAt)}</td>
                <td style={{ fontSize: 11 }}><span className="badge badge-neutral">{t.type}</span></td>
                <td>{t.description}</td>
                <td style={{ textAlign: "right", color: t.amountSatang < 0 ? "var(--color-danger)" : "var(--color-success)", fontWeight: 500 }}>
                  {t.amountSatang > 0 ? "+" : ""}{fmt(t.amountSatang)}
                </td>
                <td style={{ textAlign: "right", color: "var(--color-text-muted)" }}>{fmt(t.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
          <span style={{ color: "var(--color-text-muted)" }}>
            Showing {txOffset + 1}–{Math.min(txOffset + TX_LIMIT, txTotal)} of {txTotal}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button disabled={txOffset === 0} onClick={() => setTxOffset(Math.max(0, txOffset - TX_LIMIT))} className="btn btn-secondary btn-sm">← prev</button>
            <button disabled={txOffset + TX_LIMIT >= txTotal} onClick={() => setTxOffset(txOffset + TX_LIMIT)} className="btn btn-secondary btn-sm">next →</button>
          </span>
        </div>
      </div>
    </div>
  );
}
