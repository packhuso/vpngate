"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, AlertTriangle, Trash2, Radar, Gauge } from "lucide-react";
import PingDialog from "../ping-dialog-client";

const TIER_LABEL: Record<string, string> = {
  tier_100mb: "100 Mbps",
  tier_500mb: "500 Mbps",
  tier_1gb: "1 Gbps",
};
interface SpeedPrice { tier: string; priceSatang: number; sortOrder: number }
interface AllowCell { protocol: string; tier: string; enabled: boolean }
const bahtFmt = (satang: number) =>
  (satang / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });

interface PubIp { ip: string; blockId: string | null }
interface OtherTunnel { id: string; name: string }
interface Props {
  tunnelId: string;
  tunnelName: string;
  privateIp: string;
  currentTier: string;
  protocol: string;
  publicIps: PubIp[];
  others: OtherTunnel[];
}

export default function TunnelActions({ tunnelId, tunnelName, privateIp, currentTier, protocol, publicIps, others }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pingOpen, setPingOpen] = useState(false);

  // Change-tier state
  const [tierPrices, setTierPrices] = useState<SpeedPrice[]>([]);
  const [tierAllow, setTierAllow] = useState<AllowCell[]>([]);
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const [targetTier, setTargetTier] = useState<string>("");
  const [tierBusy, setTierBusy] = useState(false);
  const [tierErr, setTierErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [pRes, wRes] = await Promise.all([
        fetch("/v1/billing/pricing", { credentials: "same-origin" }),
        fetch("/v1/billing/summary", { credentials: "same-origin" }),
      ]);
      if (pRes.ok) {
        const d = await pRes.json();
        setTierPrices((d.speed ?? []).sort((a: SpeedPrice, b: SpeedPrice) => a.sortOrder - b.sortOrder));
        setTierAllow(d.allow ?? []);
      }
      if (wRes.ok) {
        const d = await wRes.json();
        setWalletBal(Number(d.balanceSatang ?? 0));
      }
    })();
  }, []);

  const availableTiers = tierPrices.filter((p) => {
    if (p.tier === currentTier) return false;
    const cell = tierAllow.find((c) => c.protocol === protocol && c.tier === p.tier);
    return cell?.enabled ?? true;
  });
  const selected = tierPrices.find((p) => p.tier === targetTier);
  const canAfford = selected != null && walletBal != null && walletBal >= selected.priceSatang;

  async function submitChangeTier() {
    if (!selected) return;
    const ok = confirm(
      `เปลี่ยน tier: ${TIER_LABEL[currentTier] ?? currentTier} → ${TIER_LABEL[selected.tier] ?? selected.tier}\n\n` +
      `• ตัดเงิน ฿${bahtFmt(selected.priceSatang)} ทันที\n` +
      `• เริ่มนับรอบใหม่ 31 วัน\n` +
      `• ไม่คืนเงินของรอบเดิมที่เหลือ\n\n` +
      `ยืนยันดำเนินการ?`,
    );
    if (!ok) return;
    setTierBusy(true); setTierErr(null);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}/change-tier`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speedTier: selected.tier }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "change-tier failed");
      router.refresh();
    } catch (e) { setTierErr((e as Error).message); }
    finally { setTierBusy(false); }
  }

  type Group =
    | { kind: "single"; ip: string }
    | { kind: "block"; blockId: string; ips: string[] };
  const groups: Group[] = [];
  const blockMap = new Map<string, string[]>();
  for (const p of publicIps) {
    if (p.blockId) {
      const arr = blockMap.get(p.blockId) ?? [];
      arr.push(p.ip);
      blockMap.set(p.blockId, arr);
    } else {
      groups.push({ kind: "single", ip: p.ip });
    }
  }
  for (const [blockId, ips] of blockMap) {
    groups.push({ kind: "block", blockId, ips: ips.sort() });
  }

  async function moveIp(ip: string, blockId: string | null, toTunnelId: string | null) {
    setBusy(true); setErr(null);
    try {
      const url = blockId
        ? `/v1/ips/block/${blockId}/move`
        : `/v1/ips/single/${encodeURIComponent(ip)}/move`;
      const r = await fetch(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toTunnelId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "move failed");
      router.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (publicIps.length > 0) {
      const sample = publicIps.slice(0, 5).map((p) => "  • " + p.ip).join("\n");
      alert(
        `❌ ลบ tunnel "${tunnelName}" ไม่ได้\n\n` +
        `ยังมี ${publicIps.length} public IP ผูกอยู่ — ปลด (unassign) ออกก่อน:\n\n` +
        sample + (publicIps.length > 5 ? `\n  ... อีก ${publicIps.length - 5} ตัว` : "") +
        `\n\nใช้ dropdown "Move →" ด้านบน เลือก "— unassign —"`
      );
      return;
    }
    if (!confirm(`Delete tunnel "${tunnelName}"?\n\n⚠ ไม่คืนเงินค่า tunnel subscription`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}`, { method: "DELETE", credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "delete failed");
      window.location.href = "/dashboard";
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <>
      {err && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>⚠ {err}</p>}

      {groups.length > 0 && (
        <div className="card">
          <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ArrowRightLeft size={18} strokeWidth={2} /> Move or unassign public IPs
          </h2>
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
            Unassign = ปลดออกจาก tunnel นี้แต่ยังเป็นของคุณ ค่าเช่าจะไม่หยุด
          </p>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            {groups.map((g) => (
              <div key={g.kind === "single" ? `s-${g.ip}` : `b-${g.blockId}`}
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span className="mono" style={{ flex: 1 }}>
                  {g.kind === "single" ? `${g.ip}/32` : `${g.ips[0]}/${32 - Math.log2(g.ips.length)} (${g.ips.length} IPs)`}
                </span>
                <select
                  className="input"
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    e.currentTarget.value = "";
                    if (!v) return;
                    const to = v === "__unassign__" ? null : v;
                    if (g.kind === "single") void moveIp(g.ip, null, to);
                    else void moveIp(g.ips[0], g.blockId, to);
                  }}
                  style={{ width: 200, padding: "4px 8px", fontSize: 12 }}>
                  <option value="">Move →</option>
                  <option value="__unassign__">— unassign —</option>
                  {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Gauge size={18} strokeWidth={2} /> เปลี่ยน Speed Tier
        </h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          Tier ปัจจุบัน: <strong style={{ color: "var(--color-text)" }}>{TIER_LABEL[currentTier] ?? currentTier}</strong>
          {walletBal != null && (
            <> · Wallet: <strong style={{ color: "var(--color-text)" }}>฿{bahtFmt(walletBal)}</strong></>
          )}
        </p>
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>
          ⚠ ตัดเงินตาม tier ใหม่ทันที · เริ่มนับรอบใหม่ 31 วัน · <strong>ไม่คืนเงินรอบเดิมที่เหลือ</strong>
        </p>
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <select
            className="input"
            value={targetTier}
            onChange={(e) => setTargetTier(e.target.value)}
            disabled={tierBusy || availableTiers.length === 0}
            style={{ flex: "1 1 240px" }}
          >
            <option value="">— เลือก tier ใหม่ —</option>
            {availableTiers.map((p) => (
              <option key={p.tier} value={p.tier}>
                {TIER_LABEL[p.tier] ?? p.tier} · ฿{bahtFmt(p.priceSatang)}/31d
              </option>
            ))}
          </select>
          <button
            onClick={submitChangeTier}
            disabled={tierBusy || !selected || !canAfford}
            className="btn btn-primary"
            title={
              !selected ? "เลือก tier ก่อน"
              : !canAfford ? `Wallet ไม่พอ (ต้องการ ฿${bahtFmt(selected.priceSatang)})`
              : ""
            }
          >
            <Gauge size={16} /> {tierBusy ? "กำลังเปลี่ยน…" : "เปลี่ยน + ตัดเงิน"}
          </button>
        </div>
        {tierErr && <p style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 8 }}>⚠ {tierErr}</p>}
        {selected && !canAfford && (
          <p style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 8 }}>
            Wallet ไม่พอ — ต้องการ ฿{bahtFmt(selected.priceSatang)}, มี ฿{bahtFmt(walletBal ?? 0)}
          </p>
        )}
        {availableTiers.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 8 }}>
            ไม่มี tier อื่นที่เปิดขายสำหรับ protocol นี้
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Radar size={18} strokeWidth={2} /> ทดสอบการเชื่อมต่อ (Ping)
        </h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          ping จาก VPN gateway ไปที่ client (private IP ในอุโมงค์) — กราฟ live ขณะทดสอบ
        </p>
        <button onClick={() => setPingOpen(true)} className="btn btn-primary" style={{ marginTop: 12 }}>
          <Radar size={16} /> เปิดหน้าต่างทดสอบ
        </button>
      </div>
      {pingOpen && (
        <PingDialog tunnelId={tunnelId} tunnelName={tunnelName} privateIp={privateIp}
          onClose={() => setPingOpen(false)} />
      )}

      <div className="card" style={{ borderColor: "var(--color-danger)" }}>
        <h2 className="section-title" style={{ color: "var(--color-danger)", display: "flex", alignItems: "center", gap: 8 }}>
          <AlertTriangle size={18} strokeWidth={2} /> Danger zone
        </h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 4 }}>
          ก่อนลบ tunnel ต้องปลด (unassign) public IP ทั้งหมดออกก่อน — IP / IP Block ที่ปลดแล้วจะยังเป็นของคุณ ค่าเช่าจะไม่หยุด.{" "}
          <strong style={{ color: "var(--color-text)" }}>ไม่คืนเงินค่า tunnel subscription</strong>
        </p>
        <button onClick={remove} disabled={busy} className="btn btn-danger" style={{ marginTop: 12 }}>
          <Trash2 size={16} />{busy ? "Deleting…" : "Delete tunnel"}
        </button>
      </div>
    </>
  );
}
