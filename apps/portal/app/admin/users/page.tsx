"use client";
import { useEffect, useState } from "react";
import { Search, UserCircle2, Cable, Globe, Boxes, Check } from "lucide-react";

interface User {
  id: string; email: string; name: string | null; status: string;
  lastLoginAt: string | null; balanceSatang: number; createdAt: string;
}
interface TunnelItem { id: string; name: string; status: string; speed_tier: string; price_satang: number | null; private_ip: string; created_at: string }
interface IpItem { ip: string; status: string; price_satang: number | null; tunnel_name: string | null }
interface BlockItem { id: string; cidr: string; block_size: number; price_satang: number | null; status: string }
interface UserDetail {
  user: User & { lifetimeTopupSatang: number; lifetimeSpentSatang: number };
  tunnels: TunnelItem[];
  ips: IpItem[];
  blocks: BlockItem[];
}

const fmt = (s: number) => `฿${(s / 100).toFixed(2)}`;

interface ConnEvent { id: string; protocol: string; event: string; clientIp: string | null; detail: string | null; createdAt: string }

// Lazy per-tunnel connection log (connect/disconnect/ip_change history).
function ConnLog({ tunnelId }: { tunnelId: string }) {
  const [events, setEvents] = useState<ConnEvent[] | null>(null);
  const evColor = (e: string) =>
    e === "connect" ? "var(--color-success, #16a34a)"
    : e === "disconnect" ? "var(--color-danger)"
    : "var(--color-warning, #d97706)";
  async function load() {
    if (events !== null) return;
    const r = await fetch(`/v1/admin/tunnels/${tunnelId}/connection-events?limit=50`, { credentials: "same-origin" });
    if (r.ok) setEvents((await r.json()).events ?? []);
  }
  return (
    <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void load(); }}
      style={{ marginTop: 4 }}>
      <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--color-primary)" }}>connection log</summary>
      {events === null ? (
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: "4px 0" }}>กำลังโหลด…</p>
      ) : events.length === 0 ? (
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: "4px 0" }}>ยังไม่มี event</p>
      ) : (
        <table className="mono" style={{ fontSize: 10.5, marginTop: 4, width: "100%" }}>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap", paddingRight: 8 }}>
                  {new Date(ev.createdAt).toISOString().replace("T", " ").slice(5, 19)}
                </td>
                <td style={{ color: evColor(ev.event), fontWeight: 600, paddingRight: 8 }}>{ev.event}</td>
                <td style={{ paddingRight: 8 }}>{ev.clientIp ?? ""}</td>
                <td style={{ color: "var(--color-text-muted)" }}>{ev.detail ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

// Inline locked-price editor for one purchased item.
function PriceEditor({ endpoint, satang, onSaved }: { endpoint: string; satang: number | null; onSaved: () => void }) {
  const [val, setVal] = useState((Number(satang ?? 0) / 100).toString());
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => { setVal((Number(satang ?? 0) / 100).toString()); setOk(false); }, [satang]);
  const dirty = Math.round(Number(val) * 100) !== Number(satang ?? 0);
  async function save() {
    setBusy(true); setOk(false);
    try {
      const r = await fetch(endpoint, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceSatang: Math.round(Number(val) * 100) }),
      });
      if (r.ok) { setOk(true); onSaved(); }
    } finally { setBusy(false); }
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>฿</span>
      <input className="input" type="number" min={0} step={1} value={val}
        onChange={(e) => setVal(e.target.value)}
        style={{ width: 78, padding: "3px 6px", fontSize: 12 }} />
      <button className="btn btn-sm" disabled={busy || !dirty} onClick={save}
        style={{ padding: "3px 7px" }} title="บันทึกราคา">
        {ok && !dirty ? <Check size={13} /> : "บันทึก"}
      </button>
    </span>
  );
}

export default function AdminUsers() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<UserDetail | null>(null);
  const [adjust, setAdjust] = useState({ amount: 100, reason: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const r = await fetch(`/v1/admin/users?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
    if (r.ok) setUsers((await r.json()).users);
  }
  useEffect(() => { void search(); }, []);

  async function open(u: User) {
    const r = await fetch(`/v1/admin/users/${u.id}`, { credentials: "same-origin" });
    if (r.ok) setSelected(await r.json());
  }

  async function applyAdjust() {
    if (!selected) return;
    if (!adjust.reason.trim()) { setMsg("กรุณาใส่เหตุผล"); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/v1/admin/users/${selected.user.id}/credit-adjust`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountSatang: Math.round(adjust.amount * 100), reason: adjust.reason }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      setMsg(`✓ new balance ${fmt(j.newBalanceSatang)}`);
      await open(selected.user); await search();
    } catch (e) { setMsg("⚠ " + (e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Users</h1>
        <p className="page-subtitle">ค้นหา + ปรับ credit ของ user</p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        {/* Search list */}
        <div className="card">
          <form onSubmit={search} style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="search email or name" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-primary" type="submit"><Search size={16} /></button>
          </form>
          <div style={{ marginTop: 12, maxHeight: 560, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {users.length === 0 && (
              <p style={{ color: "var(--color-text-muted)", padding: 12, textAlign: "center", fontSize: 13 }}>ไม่พบ user</p>
            )}
            {users.map((u) => (
              <div key={u.id} onClick={() => open(u)}
                style={{
                  cursor: "pointer", padding: "10px 12px", borderRadius: 8, fontSize: 13,
                  background: selected?.user.id === u.id ? "var(--color-primary-soft)" : "transparent",
                  border: "1px solid transparent",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <UserCircle2 size={20} strokeWidth={1.75} color="var(--color-text-muted)" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: "var(--color-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                      {fmt(u.balanceSatang)} · {u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 10) : "never"}
                    </div>
                  </div>
                  <span className={u.status === "active" ? "badge badge-success" : "badge badge-neutral"}>{u.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        <div className="card">
          {!selected ? (
            <p style={{ color: "var(--color-text-muted)", padding: "60px 12px", textAlign: "center", fontSize: 13 }}>
              เลือก user จากด้านซ้ายเพื่อดูรายละเอียดและปรับ credit
            </p>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <UserCircle2 size={40} strokeWidth={1.5} color="var(--color-text-muted)" />
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{selected.user.email}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>{selected.user.id}</div>
                </div>
              </div>

              <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Balance</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>{fmt(selected.user.balanceSatang)}</div>
                </div>
                <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Topup ↑</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 2, color: "var(--color-success)" }}>{fmt(selected.user.lifetimeTopupSatang)}</div>
                </div>
                <div style={{ background: "var(--color-bg)", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Spent ↓</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 2, color: "var(--color-danger)" }}>{fmt(selected.user.lifetimeSpentSatang)}</div>
                </div>
              </div>

              <div className="card-compact" style={{ marginTop: 16, borderStyle: "dashed" }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Adjust credit</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, color: "var(--color-text-muted)" }}>฿</span>
                  <input className="input" type="number" step="0.01" placeholder="บาท (+/-)"
                    value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: Number(e.target.value) })}
                    style={{ width: 120 }} />
                  <input className="input" style={{ flex: 1, minWidth: 200 }}
                    placeholder="เหตุผล (จำเป็น) — จะแสดงใน wallet ของ user"
                    value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
                  <button disabled={busy} onClick={applyAdjust} className="btn btn-primary">{busy ? "…" : "Apply"}</button>
                </div>
                <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>
                  ใส่จำนวน บาท (+ เพิ่ม, − หัก) e.g. 100 = +฿100, -50 = หัก ฿50
                </p>
                {msg && <p style={{ marginTop: 8, fontSize: 13, color: msg.startsWith("✓") ? "var(--color-success)" : "var(--color-danger)" }}>{msg}</p>}
              </div>

              {/* Purchased items — locked prices, editable per item (grandfathered) */}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Cable size={14} strokeWidth={2} /> Tunnels ({selected.tunnels.length})
                </div>
                <table className="table-default" style={{ marginTop: 6, fontSize: 13 }}>
                  <tbody>
                    {selected.tunnels.length === 0 && (
                      <tr><td style={{ color: "var(--color-text-muted)", padding: 12, textAlign: "center" }}>ไม่มี tunnel</td></tr>
                    )}
                    {selected.tunnels.map((t) => (
                      <tr key={t.id}>
                        <td style={{ fontWeight: 500 }}>{t.name}</td>
                        <td className="mono" style={{ color: "var(--color-text-muted)" }}>{t.private_ip}</td>
                        <td>{t.speed_tier.replace("tier_", "")}</td>
                        <td><span className={t.status === "active" ? "badge badge-success" : "badge badge-neutral"}>{t.status}</span></td>
                        <td style={{ textAlign: "right" }}>
                          <PriceEditor endpoint={`/v1/admin/tunnels/${t.id}/price`} satang={t.price_satang}
                            onSaved={() => open(selected.user)} />
                          <ConnLog tunnelId={t.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Globe size={14} strokeWidth={2} /> Public IPs ({selected.ips.length})
                </div>
                <table className="table-default" style={{ marginTop: 6, fontSize: 13 }}>
                  <tbody>
                    {selected.ips.length === 0 && (
                      <tr><td style={{ color: "var(--color-text-muted)", padding: 12, textAlign: "center" }}>ไม่มี single IP</td></tr>
                    )}
                    {selected.ips.map((p) => (
                      <tr key={p.ip}>
                        <td className="mono" style={{ fontWeight: 500 }}>{p.ip}</td>
                        <td style={{ color: "var(--color-text-muted)" }}>{p.tunnel_name ?? "— unassigned —"}</td>
                        <td><span className={p.status === "allocated" ? "badge badge-success" : "badge badge-neutral"}>{p.status}</span></td>
                        <td style={{ textAlign: "right" }}>
                          <PriceEditor endpoint={`/v1/admin/ips/${p.ip}/price`} satang={p.price_satang}
                            onSaved={() => open(selected.user)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Boxes size={14} strokeWidth={2} /> IP Blocks ({selected.blocks.length})
                </div>
                <table className="table-default" style={{ marginTop: 6, fontSize: 13 }}>
                  <tbody>
                    {selected.blocks.length === 0 && (
                      <tr><td style={{ color: "var(--color-text-muted)", padding: 12, textAlign: "center" }}>ไม่มี block</td></tr>
                    )}
                    {selected.blocks.map((b) => (
                      <tr key={b.id}>
                        <td className="mono" style={{ fontWeight: 500 }}>{b.cidr}</td>
                        <td style={{ color: "var(--color-text-muted)" }}>{b.block_size} IPs</td>
                        <td><span className={b.status === "active" ? "badge badge-success" : "badge badge-neutral"}>{b.status}</span></td>
                        <td style={{ textAlign: "right" }}>
                          <PriceEditor endpoint={`/v1/admin/ip-blocks/${b.id}/price`} satang={b.price_satang}
                            onSaved={() => open(selected.user)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
