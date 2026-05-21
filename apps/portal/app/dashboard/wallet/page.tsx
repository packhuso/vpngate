"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Gift, TrendingUp, TrendingDown } from "lucide-react";

interface Wallet {
  balanceSatang: number;
  lifetimeTopupSatang: number;
  lifetimeSpentSatang: number;
}
interface Tx {
  id: string; type: string;
  amountSatang: number; balanceAfter: number;
  description: string; createdAt: string;
}

const fmt = (s: number) =>
  `฿ ${(s / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INFLOW_TYPES = new Set(["topup", "code_redemption", "refund"]);
const OUTFLOW_TYPES = new Set(["subscription_charge", "ip_charge"]);
type Direction = "all" | "in" | "out";

export default function WalletPage() {
  const [w, setW] = useState<Wallet | null>(null);
  const [direction, setDirection] = useState<Direction>("all");
  const [txs, setTxs] = useState<Tx[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const [code, setCode] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadWallet = useCallback(async () => {
    const r = await fetch("/v1/wallet", { credentials: "same-origin" });
    if (r.ok) setW(await r.json());
  }, []);

  const loadTxs = useCallback(async () => {
    const q = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    const r = await fetch(`/v1/billing/transactions?${q.toString()}`, { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      setTxs(d.transactions); setTxTotal(d.total);
    }
  }, [offset]);

  useEffect(() => { void loadWallet(); }, [loadWallet]);
  useEffect(() => { void loadTxs(); }, [loadTxs]);

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setRedeemBusy(true); setRedeemMsg(null);
    try {
      const r = await fetch("/v1/codes/redeem", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "redeem failed");
      setRedeemMsg({ ok: true, text: `+${(j.creditAddedSatang / 100).toFixed(2)} ฿ added` });
      setCode("");
      await loadWallet(); await loadTxs();
    } catch (e) { setRedeemMsg({ ok: false, text: (e as Error).message }); }
    finally { setRedeemBusy(false); }
  }

  if (!w) return <div>Loading wallet…</div>;

  const filtered = txs.filter((t) => {
    if (direction === "in") return t.amountSatang > 0 || INFLOW_TYPES.has(t.type);
    if (direction === "out") return t.amountSatang < 0 || OUTFLOW_TYPES.has(t.type);
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Wallet</h1>
        <p className="page-subtitle">ดูยอดเงิน, redeem code, และประวัติทุกรายการ</p>
      </header>

      {/* 3 KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            Wallet balance
          </div>
          <div style={{ fontSize: 32, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)" }}>{fmt(w.balanceSatang)}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <TrendingUp size={14} strokeWidth={2} color="var(--color-success)" /> Lifetime topup
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)", color: "var(--color-success)" }}>{fmt(w.lifetimeTopupSatang)}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <TrendingDown size={14} strokeWidth={2} color="var(--color-danger)" /> Lifetime spent
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-mono)", color: "var(--color-danger)" }}>{fmt(w.lifetimeSpentSatang)}</div>
        </div>
      </div>

      {/* Redeem code */}
      <div className="card">
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Gift size={18} strokeWidth={2} /> Redeem code
        </h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          มี credit code? กรอกที่นี่เพื่อเติมเงินเข้า wallet
        </p>
        <form onSubmit={redeem} style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <input className="input mono" required
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            style={{ flex: "1 1 240px", letterSpacing: 1 }} />
          <button disabled={redeemBusy} type="submit" className="btn btn-primary">
            <Gift size={16} />{redeemBusy ? "…" : "Redeem"}
          </button>
        </form>
        {redeemMsg && (
          <p style={{ marginTop: 8, fontSize: 13, color: redeemMsg.ok ? "var(--color-success)" : "var(--color-danger)" }}>
            {redeemMsg.ok ? "✓" : "⚠"} {redeemMsg.text}
          </p>
        )}
      </div>

      {/* Transaction history */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <h2 className="section-title">ประวัติทุกรายการ <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({txTotal})</span></h2>
          <div style={{ display: "flex", gap: 4 }}>
            {(["all", "in", "out"] as Direction[]).map((d) => (
              <button key={d} onClick={() => setDirection(d)}
                className={direction === d ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}>
                {d === "all" ? "ทั้งหมด" : d === "in" ? <><ArrowDownToLine size={12} />เงินเข้า</> : <><ArrowUpFromLine size={12} />เงินออก</>}
              </button>
            ))}
          </div>
        </div>

        <table className="table-default mono">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Description</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th style={{ textAlign: "right" }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>
                {direction === "all" ? "ยังไม่มีรายการ" : direction === "in" ? "ยังไม่มีเงินเข้า" : "ยังไม่มีเงินออก"}
              </td></tr>
            )}
            {filtered.map((t) => (
              <tr key={t.id}>
                <td style={{ color: "var(--color-text-muted)" }}>{new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td style={{ fontSize: 11 }}>
                  <span className="badge badge-neutral">{t.type}</span>
                </td>
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
            แสดง {offset + 1}–{Math.min(offset + LIMIT, txTotal)} จาก {txTotal} รายการ
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))} className="btn btn-secondary btn-sm">← ก่อนหน้า</button>
            <button disabled={offset + LIMIT >= txTotal} onClick={() => setOffset(offset + LIMIT)} className="btn btn-secondary btn-sm">ถัดไป →</button>
          </span>
        </div>
      </div>
    </div>
  );
}
