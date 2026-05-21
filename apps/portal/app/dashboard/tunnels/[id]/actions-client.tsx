"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, AlertTriangle, Trash2 } from "lucide-react";

interface PubIp { ip: string; blockId: string | null }
interface OtherTunnel { id: string; name: string }
interface Props {
  tunnelId: string;
  tunnelName: string;
  publicIps: PubIp[];
  others: OtherTunnel[];
}

export default function TunnelActions({ tunnelId, tunnelName, publicIps, others }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
