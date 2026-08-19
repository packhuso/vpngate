"use client";
import { useCallback, useEffect, useState } from "react";
import { Save, Package, Check } from "lucide-react";

interface SpeedPrice { tier: string; priceSatang: number; sortOrder: number }
interface IpPrice { blockSize: number; priceSatang: number }
interface AllowCell { protocol: string; tier: string; enabled: boolean }
interface Pricing { speed: SpeedPrice[]; ip: IpPrice[]; allow: AllowCell[] }

const TIER_LABEL: Record<string, string> = {
  tier_100mb: "100 Mbps",
  tier_500mb: "500 Mbps",
  tier_1gb: "1 Gbps",
};
const PROTO_LABEL: Record<string, string> = {
  wireguard: "WireGuard",
};
const ipLabel = (sz: number) =>
  sz === 1 ? "/32 — 1 IP (single)" : `/${32 - Math.log2(sz)} — ${sz} IPs (block)`;
const baht = (satang: number) => satang / 100;

export default function AdminPricing() {
  const [cfg, setCfg] = useState<Pricing | null>(null);
  const [speed, setSpeed] = useState<Record<string, number>>({}); // tier → baht
  const [ip, setIp] = useState<Record<number, number>>({}); // blockSize → baht
  const [allow, setAllow] = useState<Record<string, boolean>>({}); // `${proto}:${tier}` → bool
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const hydrate = useCallback((p: Pricing) => {
    setCfg(p);
    setSpeed(Object.fromEntries(p.speed.map((s) => [s.tier, baht(s.priceSatang)])));
    setIp(Object.fromEntries(p.ip.map((i) => [i.blockSize, baht(i.priceSatang)])));
    setAllow(Object.fromEntries(p.allow.map((a) => [`${a.protocol}:${a.tier}`, a.enabled])));
  }, []);

  const load = useCallback(async () => {
    const r = await fetch("/v1/admin/pricing", { credentials: "same-origin" });
    if (r.ok) hydrate(await r.json());
  }, [hydrate]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!cfg) return;
    setBusy(true); setMsg(null);
    try {
      const body = {
        speed: cfg.speed.map((s) => ({ tier: s.tier, priceSatang: Math.round((speed[s.tier] ?? 0) * 100) })),
        ip: cfg.ip.map((i) => ({ blockSize: i.blockSize, priceSatang: Math.round((ip[i.blockSize] ?? 0) * 100) })),
        allow: cfg.allow.map((a) => ({ protocol: a.protocol, tier: a.tier, enabled: allow[`${a.protocol}:${a.tier}`] ?? false })),
      };
      const r = await fetch("/v1/admin/pricing", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? "save failed");
      hydrate(j);
      setMsg({ ok: true, text: "บันทึกแล้ว" });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  }

  if (!cfg) return <div className="card">Loading…</div>;

  const protocols = [...new Set(cfg.allow.map((a) => a.protocol))];
  const tiers = cfg.speed.map((s) => s.tier);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Packages</h1>
        <p className="page-subtitle">กำหนดราคาแพ็กเกจ speed / IP และเลือกว่า protocol ไหนขาย tier ไหนได้</p>
      </header>

      {/* Speed tier prices */}
      <div className="card">
        <h2 className="section-title" style={{ marginBottom: 4 }}>ราคา Speed (ต่อ 31 วัน)</h2>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 0, marginBottom: 14 }}>
          ราคาเดียวต่อ tier ใช้กับทุก protocol
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {cfg.speed.map((s) => (
            <label key={s.tier} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{TIER_LABEL[s.tier] ?? s.tier}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--color-text-muted)" }}>฿</span>
                <input className="input" type="number" min={0} step={1} value={speed[s.tier] ?? 0}
                  onChange={(e) => setSpeed((m) => ({ ...m, [s.tier]: Number(e.target.value) }))}
                  style={{ width: "100%" }} />
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Allow matrix */}
      <div className="card">
        <h2 className="section-title" style={{ marginBottom: 4 }}>อนุญาตขาย (Protocol × Tier)</h2>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 0, marginBottom: 14 }}>
          ติ๊กช่องที่อยากเปิดขาย — ปล่อยว่างเพื่อซ่อน tier นั้นจากหน้าซื้อ tunnel
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 10px", color: "var(--color-text-muted)", fontWeight: 500 }}>Protocol</th>
                {tiers.map((t) => (
                  <th key={t} style={{ textAlign: "center", padding: "8px 10px", color: "var(--color-text-muted)", fontWeight: 500 }}>{TIER_LABEL[t] ?? t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {protocols.map((p) => (
                <tr key={p} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>{PROTO_LABEL[p] ?? p}</td>
                  {tiers.map((t) => {
                    const key = `${p}:${t}`;
                    const on = allow[key] ?? false;
                    return (
                      <td key={t} style={{ textAlign: "center", padding: "8px 10px" }}>
                        <button type="button"
                          onClick={() => setAllow((m) => ({ ...m, [key]: !on }))}
                          aria-label={`${p} ${t}`}
                          style={{
                            width: 26, height: 26, borderRadius: 7, cursor: "pointer",
                            display: "grid", placeItems: "center",
                            border: `1px solid ${on ? "var(--color-primary)" : "var(--color-border-2)"}`,
                            background: on ? "var(--color-primary)" : "var(--color-surface)",
                            color: "#fff",
                          }}>
                          {on && <Check size={15} strokeWidth={3} />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* IP prices */}
      <div className="card">
        <h2 className="section-title" style={{ marginBottom: 4 }}>ราคา Public IP (ต่อ 31 วัน)</h2>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 0, marginBottom: 14 }}>
          single /32 และแต่ละขนาด block
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {cfg.ip.map((i) => (
            <label key={i.blockSize} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{ipLabel(i.blockSize)}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--color-text-muted)" }}>฿</span>
                <input className="input" type="number" min={0} step={1} value={ip[i.blockSize] ?? 0}
                  onChange={(e) => setIp((m) => ({ ...m, [i.blockSize]: Number(e.target.value) }))}
                  style={{ width: "100%" }} />
              </div>
            </label>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          <Save size={16} /> {busy ? "Saving…" : "บันทึกทั้งหมด"}
        </button>
        {msg && (
          <span style={{ fontSize: 13, color: msg.ok ? "var(--color-success, #16a34a)" : "var(--color-danger)" }}>
            {msg.ok ? "✓ " : "⚠ "}{msg.text}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-text-muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Package size={14} /> มีผลกับการสร้าง/ต่ออายุครั้งถัดไป
        </span>
      </div>
    </div>
  );
}
