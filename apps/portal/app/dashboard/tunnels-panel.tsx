"use client";
import { useEffect, useState } from "react";
import { fmtDateTime } from "../_lib/datetime";
import { Plus, Trash2, FileDown, Settings2, Shield, Radar, Cable } from "lucide-react";
import PingDialog from "./tunnels/ping-dialog-client";
import { notifyDataChanged, onDataChanged, confirmIpChange } from "../_components/refresh-bus";

interface PubIp { ip: string; blockId: string | null }
interface Tunnel {
  id: string;
  name: string;
  description: string | null;
  speedTier: string;
  status: string;
  protocol: string;
  privateIp: string;
  createdAt: string;
  publicIps: PubIp[];
  online?: boolean;
  lastSeenAt?: string | null;
}

// name = config-file identifier → letters/digits/-/_ only. Description holds any-language text.
const NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

const TIER_MBPS: Record<string, string> = {
  tier_100mb: "100 Mbps",
  tier_500mb: "500 Mbps",
  tier_1gb: "1 Gbps",
};
const bahtFmt = (satang: number) =>
  (satang / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });

interface SpeedPrice { tier: string; priceSatang: number; sortOrder: number }
interface AllowCell { protocol: string; tier: string; enabled: boolean }

const PROTOCOLS = [
  { v: "wireguard", label: "WireGuard", icon: Shield, hint: "เร็ว, เบา, แนะนำ" },
  { v: "gre", label: "GRE", icon: Cable, hint: "สำหรับ Mikrotik / router (ไม่ encrypt)" },
];

const statusBadge = (s: string) =>
  s === "active" ? "badge-success"
  : s === "provisioning" ? "badge-warning"
  : s === "suspended" ? "badge-danger"
  : "badge-neutral";

export default function TunnelsPanel() {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tier, setTier] = useState("tier_100mb");
  const [protocol, setProtocol] = useState("wireguard");
  // GRE-only: customer's endpoint (domain or IP). Ignored for other protocols.
  const [remoteEndpointHost, setRemoteEndpointHost] = useState("");
  const [available, setAvailable] = useState<string[]>(["wireguard"]);
  const [speedPrices, setSpeedPrices] = useState<SpeedPrice[]>([]);
  const [allow, setAllow] = useState<AllowCell[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pingTarget, setPingTarget] = useState<{ id: string; name: string; privateIp: string } | null>(null);

  async function load() {
    const r = await fetch("/v1/tunnels", { credentials: "same-origin" });
    if (r.ok) setTunnels((await r.json()).tunnels ?? []);
  }
  async function loadOptions() {
    const r = await fetch("/v1/tunnels/options", { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      const protos: string[] = d.protocols ?? ["wireguard"];
      setAvailable(protos);
      // if current selection isn't available, fall back to the first available
      if (!protos.includes(protocol)) setProtocol(protos[0] ?? "wireguard");
    }
  }
  async function loadPricing() {
    const r = await fetch("/v1/billing/pricing", { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      setSpeedPrices((d.speed ?? []).sort((a: SpeedPrice, b: SpeedPrice) => a.sortOrder - b.sortOrder));
      setAllow(d.allow ?? []);
    }
  }
  useEffect(() => { void load(); void loadOptions(); void loadPricing(); }, []);
  // refresh when ANY panel mutates data (e.g. an IP is assigned in IpsPanel)
  useEffect(() => onDataChanged(() => { void load(); }), []);

  // Tiers the selected protocol may sell (admin allow matrix) + their prices.
  const tiers = speedPrices
    .filter((s) => allow.some((a) => a.protocol === protocol && a.tier === s.tier && a.enabled))
    .map((s) => ({
      v: s.tier,
      label: `${TIER_MBPS[s.tier] ?? s.tier} · ฿${bahtFmt(s.priceSatang)}/31d`,
    }));
  // keep the selected tier valid for the current protocol
  useEffect(() => {
    if (tiers.length && !tiers.some((t) => t.v === tier)) setTier(tiers[0].v);
  }, [protocol, speedPrices, allow]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!NAME_RE.test(name)) {
      setErr("ชื่อใช้ได้เฉพาะ a-z A-Z 0-9 - _ เท่านั้น (ภาษาไทยให้ใส่ในช่อง Description)");
      return;
    }
    if (tunnels.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setErr(`ชื่อ "${name}" ถูกใช้แล้ว — ตั้งชื่ออื่น`);
      return;
    }
    const tierLabel = tiers.find((t) => t.v === tier)?.label ?? tier;
    const protoLabel = protocol === "gre" ? "GRE" : "WireGuard";
    if (protocol === "gre") {
      if (!remoteEndpointHost.trim()) {
        setErr("กรอก endpoint host (domain หรือ IP) ของ router คุณ");
        return;
      }
    }
    const greNote = protocol === "gre"
      ? `\nEndpoint ปลายทาง: ${remoteEndpointHost.trim()}\n` +
        `⚠ GRE ไม่มี encryption — ทราฟฟิกวิ่งเปิดเผยบน internet`
      : "";
    if (!confirm(
      `ยืนยันการสร้าง Tunnel\n\n` +
      `ชื่อ: ${name}\n` +
      `ชนิด: ${protoLabel}\n` +
      `แพ็กเกจ: ${tierLabel}${greNote}\n\n` +
      `⚠ จะตัดเงินค่า subscription จาก wallet ทันที และไม่คืนเงิน`
    )) return;
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        name, description: description || undefined, speedTier: tier, protocol,
      };
      if (protocol === "gre") body.remoteEndpointHost = remoteEndpointHost.trim();
      const r = await fetch("/v1/tunnels", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      setName(""); setDescription(""); setRemoteEndpointHost("");
      notifyDataChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(t: Tunnel) {
    if (t.publicIps.length > 0) {
      const sample = t.publicIps.slice(0, 5).map((p) => "  • " + p.ip).join("\n");
      alert(
        `❌ ลบ tunnel "${t.name}" ไม่ได้\n\n` +
        `ยังมี ${t.publicIps.length} public IP ผูกอยู่ — ต้องปลด (unassign) ออกก่อน:\n\n` +
        sample + (t.publicIps.length > 5 ? `\n  ... อีก ${t.publicIps.length - 5} ตัว` : "") +
        `\n\nไปที่ Public IPs panel เลือก "— unassigned —"`
      );
      return;
    }
    if (!confirm(`Delete tunnel "${t.name}"?\n\n⚠ ไม่คืนเงินค่า tunnel subscription`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/v1/tunnels/${t.id}`, { method: "DELETE", credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      notifyDataChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function moveIp(ip: string, blockId: string | null, toTunnelId: string | null) {
    const action = toTunnelId
      ? `ย้าย IP ไปยัง tunnel "${tunnels.find((t) => t.id === toTunnelId)?.name ?? toTunnelId}"`
      : `ปลด IP ออกจาก tunnel`;
    if (!confirmIpChange(action, blockId ? `${ip} (block)` : ip)) return;
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
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      notifyDataChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2 className="section-title" style={{ marginBottom: 16 }}>สร้าง tunnel ใหม่</h2>

      <form onSubmit={create} style={{ marginBottom: 16 }}>
        {/* Protocol picker — segmented control. OpenVPN auto-enables when an
            OpenVPN gateway is registered; otherwise shows "เร็วๆ นี้". */}
        <div style={{ marginBottom: 10 }}>
          <div className="label">ชนิด VPN</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PROTOCOLS.map((p) => {
              const enabled = available.includes(p.v);
              const selected = protocol === p.v;
              const Icon = p.icon;
              return (
                <button key={p.v} type="button" disabled={!enabled}
                  onClick={() => enabled && setProtocol(p.v)}
                  style={{
                    flex: "1 1 200px", minWidth: 180, textAlign: "left",
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px", borderRadius: 10, cursor: enabled ? "pointer" : "not-allowed",
                    border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border-2)"}`,
                    background: selected ? "var(--color-primary-soft)" : "var(--color-surface)",
                    opacity: enabled ? 1 : 0.55,
                  }}>
                  <Icon size={18} strokeWidth={2}
                    color={selected ? "var(--color-primary)" : "var(--color-text-muted)"} />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 600, fontSize: 13,
                      color: selected ? "var(--color-primary)" : "var(--color-text)" }}>
                      {p.label}
                      {!enabled && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>เร็วๆ นี้</span>}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--color-text-muted)" }}>{p.hint}</span>
                  </span>
                  {selected && <span style={{ color: "var(--color-primary)", fontSize: 16 }}>✓</span>}
                </button>
              );
            })}
          </div>
        </div>

        {(() => {
          const dup = !!name && tunnels.some((t) => t.name.toLowerCase() === name.toLowerCase());
          const badChars = !!name && !NAME_RE.test(name);
          const hint = badChars
            ? "ใช้ได้เฉพาะอักษรอังกฤษ / ตัวเลข / - _ (ภาษาไทยใส่ใน Description)"
            : dup ? "ชื่อนี้ถูกใช้แล้ว — ตั้งชื่ออื่น" : "";
          return (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 200px", minWidth: 180 }}>
                <input className="input" required placeholder="ชื่อ tunnel (e.g. HomeRouter)"
                  value={name} onChange={(e) => setName(e.target.value)}
                  pattern="[A-Za-z0-9_\-]{1,100}"
                  title="a-z A-Z 0-9 - _ เท่านั้น"
                  style={{ width: "100%", borderColor: hint ? "var(--color-danger)" : undefined }} />
                {/* reserved fixed-height hint line so toggling the warning never shifts the layout */}
                <span style={{ display: "block", minHeight: 15, lineHeight: "15px", marginTop: 3, fontSize: 11, color: "var(--color-danger)" }}>
                  {hint}
                </span>
              </div>
              <select className="input" value={tier} onChange={(e) => setTier(e.target.value)} style={{ flex: "0 1 220px", minWidth: 200 }}>
                {tiers.length === 0
                  ? <option value="">— ไม่มีแพ็กเกจสำหรับ protocol นี้ —</option>
                  : tiers.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
              <button disabled={busy || tiers.length === 0 || !tier} className="btn btn-primary" type="submit">
                <Plus size={16} />
                {busy ? "Creating…" : "New tunnel"}
              </button>
            </div>
          );
        })()}
        <input className="input" placeholder="คำอธิบาย (ใส่ภาษาไทยได้ เช่น เราเตอร์บ้าน ชั้น 2) — ไม่บังคับ"
          value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300}
          style={{ width: "100%", marginTop: 8 }} />
        {protocol === "gre" && (
          <div style={{ marginTop: 8 }}>
            <input
              className="input"
              required
              placeholder="Endpoint ของ router คุณ (เช่น home.dyndns.org หรือ 1.2.3.4)"
              value={remoteEndpointHost}
              onChange={(e) => setRemoteEndpointHost(e.target.value)}
              maxLength={253}
              style={{ width: "100%" }}
            />
            <span style={{ display: "block", fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>
              ถ้า IP ของคุณเปลี่ยน (dynamic ISP) ให้ใช้ DDNS domain — server จะ resolve ใหม่อัตโนมัติเมื่อ tunnel ล่ม
            </span>
          </div>
        )}
      </form>
      {err && <p style={{ color: "var(--color-danger)", fontSize: 13, marginBottom: 12 }}>⚠ {err}</p>}

      <h2 className="section-title" style={{ marginTop: 24, marginBottom: 12, paddingTop: 16, borderTop: "1px solid var(--color-border)" }}>
        รายการ tunnel {tunnels.length > 0 && <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({tunnels.length})</span>}
      </h2>

      {tunnels.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--color-text-muted)", fontSize: 14, background: "var(--color-bg)", borderRadius: 10, border: "1px dashed var(--color-border)" }}>
          ยังไม่มี tunnel — สร้างตัวแรกด้านบน
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tunnels.map((t) => {
            const others = tunnels.filter((x) => x.id !== t.id && x.status === "active");
            type Group = { kind: "single"; ip: string } | { kind: "block"; blockId: string; ips: string[] };
            const groups: Group[] = [];
            const blockMap = new Map<string, string[]>();
            for (const p of t.publicIps) {
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

            return (
              <div key={t.id} style={{ border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" }}>
                {/* Tunnel header row */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "var(--color-bg)" }}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <a href={`/dashboard/tunnels/${t.id}`} style={{ color: "var(--color-primary)", textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
                      {t.name}
                    </a>
                    {t.description && (
                      <span style={{ fontSize: 11, color: "var(--color-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }} title={t.description}>
                        {t.description}
                      </span>
                    )}
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{t.privateIp}</span>
                  <span className="badge-neutral badge">{t.speedTier.replace("tier_", "")}</span>
                  {t.protocol === "gre" ? (
                    <span className="badge badge-warning">GRE</span>
                  ) : (
                    <span className="badge badge-primary">WireGuard</span>
                  )}
                  <span className={`badge ${statusBadge(t.status)}`}>{t.status}</span>
                  <span className={`badge ${t.online ? "badge-success" : "badge-neutral"}`}
                    title={t.lastSeenAt ? `last seen ${fmtDateTime(t.lastSeenAt)}` : "no connection yet"}>
                    {t.online ? "● online" : "○ offline"}
                  </span>

                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    {t.status === "active" && (
                      t.protocol === "gre" ? (
                        <a href={`/v1/tunnels/${t.id}/config?format=mikrotik`} download={`${t.name}.mikrotik.rsc`}
                          className="btn btn-secondary btn-sm" title="Mikrotik GRE script">
                          <FileDown size={14} />Mikrotik .rsc
                        </a>
                      ) : (
                        <>
                          <a href={`/v1/tunnels/${t.id}/config`} download={`${t.name}.conf`}
                            className="btn btn-secondary btn-sm" title="WireGuard .conf">
                            <FileDown size={14} />.conf
                          </a>
                          <a href={`/v1/tunnels/${t.id}/config?format=mikrotik`} download={`${t.name}.mikrotik.rsc`}
                            className="btn btn-secondary btn-sm" title="Mikrotik script">
                            <FileDown size={14} />Mikrotik
                          </a>
                        </>
                      )
                    )}
                    {t.status === "active" && (
                      <button onClick={() => setPingTarget({ id: t.id, name: t.name, privateIp: t.privateIp })}
                        className="btn btn-ghost btn-sm" title="Ping จาก gateway → client (private IP)"
                        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <Radar size={14} /> Ping
                      </button>
                    )}
                    {t.status === "active" && (
                      <a href={`/dashboard/tunnels/${t.id}`} className="btn btn-ghost btn-sm" title="Manage">
                        <Settings2 size={14} />
                      </a>
                    )}
                    <button onClick={() => remove(t)} disabled={busy} className="btn btn-danger-outline btn-sm" title="Delete (no refund)">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Public IPs attached */}
                {groups.length > 0 && (
                  <div style={{ padding: "8px 16px 12px", background: "var(--color-surface)" }}>
                    <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--color-text-subtle)", marginBottom: 6 }}>
                      Public IPs · {t.publicIps.length}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {groups.map((g) => (
                        <div key={g.kind === "single" ? `s-${g.ip}` : `b-${g.blockId}`}
                          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                          <span className="mono" style={{ flex: 1 }}>
                            {g.kind === "single"
                              ? `${g.ip}/32`
                              : `${g.ips[0]}/${32 - Math.log2(g.ips.length)} (${g.ips.length} IPs)`}
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
                            style={{ width: 180, padding: "4px 8px", fontSize: 12 }}>
                            <option value="">Move →</option>
                            <option value="__unassign__">— unassign —</option>
                            {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {pingTarget && (
        <PingDialog
          tunnelId={pingTarget.id}
          tunnelName={pingTarget.name}
          privateIp={pingTarget.privateIp}
          onClose={() => setPingTarget(null)}
        />
      )}
    </section>
  );
}
