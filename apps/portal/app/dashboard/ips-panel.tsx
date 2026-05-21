"use client";
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { notifyDataChanged, onDataChanged, confirmIpChange } from "../_components/refresh-bus";

interface Single { ip: string; tunnelId: string | null; allocatedAt: string }
interface Block { id: string; cidr: string; blockSize: number; tunnelId: string | null; ipCount: number }
interface Tunnel { id: string; name: string; status: string }

const SIZES = [
  { v: 1, label: "/32 — 1 IP (฿100)" },
  { v: 2, label: "/31 — 2 IPs (฿200)" },
  { v: 4, label: "/30 — 4 IPs (฿400)" },
  { v: 8, label: "/29 — 8 IPs (฿800)" },
  { v: 16, label: "/28 — 16 IPs (฿1,500)" },
  { v: 32, label: "/27 — 32 IPs (฿2,800)" },
  { v: 64, label: "/26 — 64 IPs (฿5,200)" },
];

const UNASSIGNED_OPT = "__unassigned__";

const ip4ToInt = (ip: string): number =>
  ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

export default function IpsPanel() {
  const [singles, setSingles] = useState<Single[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [size, setSize] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    const [a, b] = await Promise.all([
      fetch("/v1/ips", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("/v1/tunnels", { credentials: "same-origin" }).then((r) => r.json()),
    ]);
    setSingles(a.singles ?? []);
    setBlocks(a.blocks ?? []);
    setTunnels((b.tunnels ?? []).filter((t: Tunnel) => t.status === "active"));
  }
  useEffect(() => { void reload(); }, []);
  // refresh when ANY panel mutates data (e.g. a tunnel is created/deleted)
  useEffect(() => onDataChanged(() => { void reload(); }), []);

  async function call(label: string, fn: () => Promise<Response>) {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? r.statusText);
      // refreshes BOTH this panel (via its own listener) and the Tunnels panel
      notifyDataChanged();
    } catch (e) { setErr(`${label}: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function buy() {
    const opt = SIZES.find((s) => s.v === size);
    if (!confirm(`ยืนยันการซื้อ IP\n\n${opt?.label ?? size + " IP"}\n\n⚠ จะตัดเงินจาก wallet ทันที และไม่คืนเงิน`)) return;
    if (size === 1) {
      await call("Buy /32", () => fetch("/v1/ips/single", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }));
    } else {
      await call(`Buy /${32 - Math.log2(size)}`, () => fetch("/v1/ips/block", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockSize: size }),
      }));
    }
  }

  async function releaseSingle(s: Single) {
    if (s.tunnelId) {
      alert(`❌ ลบ ${s.ip} ไม่ได้\n\nIP นี้ยังผูกกับ tunnel — เลือก "— unassigned —" ก่อน`);
      return;
    }
    if (!confirm(`ลบ ${s.ip} คืน pool?\n\n⚠ ไม่คืนเงิน`)) return;
    await call(`Release ${s.ip}`, () =>
      fetch(`/v1/ips/single/${encodeURIComponent(s.ip)}`, { method: "DELETE", credentials: "same-origin" }));
  }
  async function releaseBlock(b: Block) {
    if (b.tunnelId) {
      alert(`❌ ลบ IP Block ${b.cidr} ไม่ได้\n\nผูกกับ tunnel อยู่ — เลือก "— unassigned —" ก่อน`);
      return;
    }
    if (!confirm(`ลบ IP Block ${b.cidr} (${b.ipCount} IPs) คืน pool?\n\n⚠ ไม่คืนเงิน`)) return;
    await call(`Release ${b.cidr}`, () =>
      fetch(`/v1/ips/block/${b.id}`, { method: "DELETE", credentials: "same-origin" }));
  }
  async function setAssignment(kind: "single" | "block", id: string, raw: string) {
    const toTunnelId = raw === UNASSIGNED_OPT ? null : raw;
    const action = toTunnelId
      ? `ผูก / ย้าย IP ไปยัง tunnel "${tunnelName(toTunnelId)}"`
      : `ปลด IP ออกจาก tunnel`;
    if (!confirmIpChange(action, id)) return; // cancelled → select reverts on re-render
    const url = kind === "single"
      ? `/v1/ips/single/${encodeURIComponent(id)}/move`
      : `/v1/ips/block/${id}/move`;
    await call(`Assign ${id}`, () =>
      fetch(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toTunnelId }),
      }));
  }

  const tunnelName = (id: string | null) =>
    id ? (tunnels.find((t) => t.id === id)?.name ?? `${id.slice(0, 8)} (inactive)`)
       : "— unassigned —";

  const renderAssignSelect = (kind: "single" | "block", id: string, currentTunnelId: string | null) => {
    const isInactive = currentTunnelId && !tunnels.find((t) => t.id === currentTunnelId);
    const value = currentTunnelId ?? UNASSIGNED_OPT;
    return (
      <select
        className="input"
        value={isInactive ? "__inactive__" : value}
        disabled={busy}
        onChange={(e) => { void setAssignment(kind, id, e.target.value); }}
        style={{
          width: 180, padding: "4px 8px", fontSize: 12,
          color: currentTunnelId ? "var(--color-text)" : "var(--color-warning)",
        }}>
        <option value={UNASSIGNED_OPT}>— unassigned —</option>
        {tunnels.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        {isInactive && <option value="__inactive__" disabled>{tunnelName(currentTunnelId)}</option>}
      </select>
    );
  };

  type Item =
    | { kind: "single"; ip: string; tunnelId: string | null; sortKey: number }
    | { kind: "block"; id: string; cidr: string; blockSize: number; ipCount: number; tunnelId: string | null; sortKey: number };
  const items: Item[] = [
    ...singles.map((s): Item => ({ kind: "single", ip: s.ip, tunnelId: s.tunnelId, sortKey: ip4ToInt(s.ip) })),
    ...blocks.map((b): Item => ({ kind: "block", id: b.id, cidr: b.cidr, blockSize: b.blockSize, ipCount: b.ipCount, tunnelId: b.tunnelId, sortKey: ip4ToInt(b.cidr.split("/")[0]) })),
  ].sort((a, b) => a.sortKey - b.sortKey);
  const totalIps = singles.length + blocks.reduce((n, b) => n + b.ipCount, 0);

  return (
    <section className="card">
      <div style={{ marginBottom: 16 }}>
        <h2 className="section-title">Public IPs</h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          ซื้อ IP เก็บไว้ได้โดยไม่ต้องผูก tunnel ก็ได้ — ค่าเช่าคิดต่อ IP / IP Block, ย้ายระหว่าง tunnel เมื่อไหร่ก็ได้.
          ปุ่ม <Trash2 size={12} style={{ display: "inline", verticalAlign: "middle" }} /> = คืน pool (<strong>ไม่คืนเงิน</strong>). ต้องปลดจาก tunnel ก่อน.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>Buy:</span>
        <select className="input" value={size} onChange={(e) => setSize(Number(e.target.value))} style={{ width: 220 }}>
          {SIZES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <button disabled={busy} onClick={buy} className="btn btn-primary">
          <Plus size={16} />{busy ? "…" : "Buy"}
        </button>
      </div>
      {err && <p style={{ color: "var(--color-danger)", fontSize: 13, marginBottom: 12 }}>⚠ {err}</p>}

      {items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--color-text-muted)", fontSize: 14, background: "var(--color-bg)", borderRadius: 10, border: "1px dashed var(--color-border)" }}>
          ยังไม่มี public IPs — ซื้อก่อนได้ตามต้องการ (เก็บไว้ไม่ต้องผูก tunnel ก็ได้)
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--color-text-muted)", marginBottom: 6 }}>
            Your IPs · {items.length} item{items.length === 1 ? "" : "s"} · {totalIps} IP{totalIps === 1 ? "" : "s"}
          </div>
          <table className="table-default mono" style={{ fontSize: 13 }}>
            <tbody>
              {items.map((it) => {
                const isBlock = it.kind === "block";
                const display = isBlock ? it.cidr : `${it.ip}/32`;
                const ipCount = isBlock ? it.ipCount : 1;
                return (
                  <tr key={isBlock ? `b-${it.id}` : `s-${it.ip}`}>
                    <td style={{ width: "50%" }}>{display}</td>
                    <td>
                      <span className={isBlock ? "badge badge-info" : "badge badge-success"}>
                        {ipCount} {ipCount === 1 ? "IP" : "IPs"}
                      </span>
                    </td>
                    <td>{renderAssignSelect(isBlock ? "block" : "single", isBlock ? it.id : it.ip, it.tunnelId)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        onClick={() => isBlock ? releaseBlock(it as unknown as Block) : releaseSingle({ ip: (it as { ip: string }).ip, tunnelId: it.tunnelId, allocatedAt: "" })}
                        disabled={busy || !!it.tunnelId}
                        title={it.tunnelId ? "ปลดออกจาก tunnel ก่อน" : "ลบ — คืน pool, ไม่คืนเงิน"}
                        className={it.tunnelId ? "btn btn-ghost btn-sm" : "btn btn-danger-outline btn-sm"}>
                        <Trash2 size={14} />ลบ
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
