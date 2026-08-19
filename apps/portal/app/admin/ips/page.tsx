"use client";
import { useCallback, useEffect, useState } from "react";
import { Trash2, Plus, Network, Layers, Globe } from "lucide-react";

interface Pool {
  id: string;
  block: string;
  block_size: number;
  available_count: number;
  allocated_count: number;
}
interface IpRow {
  ip: string;
  status: string;
  sale_mode: string;
  user_email: string | null;
  tunnel_name: string | null;
  block_id: string | null;
  plan_mode: "single" | "block" | null;
  plan_block_size: number | null;
}
interface Plan {
  id: string;
  cidr: string;
  saleMode: "single" | "block";
  blockSize: number | null;
  totalIps: number;
  usedIps: number;
}

const STATUS_COLOR: Record<string, string> = {
  allocated: "var(--color-warning)",
  available: "var(--color-text-subtle)",
  suspended: "var(--color-danger)",
  reserved: "var(--color-text-muted)",
  blacklisted: "var(--color-danger)",
};

const SALE_SIZES = [
  { v: 1, label: "/32 (1 IP — รายตัว)" },
  { v: 2, label: "/31 (2 IPs)" },
  { v: 4, label: "/30 (4 IPs)" },
  { v: 8, label: "/29 (8 IPs)" },
  { v: 16, label: "/28 (16 IPs)" },
  { v: 32, label: "/27 (32 IPs)" },
  { v: 64, label: "/26 (64 IPs)" },
  { v: 128, label: "/25 (128 IPs)" },
  { v: 256, label: "/24 (256 IPs)" },
];

const ip4ToInt = (ip: string): number =>
  ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp4 = (n: number): string =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const cidrParts = (cidr: string) => {
  const [base, lenStr] = cidr.split("/");
  return { net: ip4ToInt(base), size: 1 << (32 - Number(lenStr)), prefix: Number(lenStr) };
};

export default function AdminIps() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [poolId, setPoolId] = useState<string>("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [poolBlock, setPoolBlock] = useState<string>("");
  const [ips, setIps] = useState<IpRow[]>([]);

  const [planCidr, setPlanCidr] = useState("");
  const [planSize, setPlanSize] = useState(1);
  const [planErr, setPlanErr] = useState<string | null>(null);

  const [newPoolCidr, setNewPoolCidr] = useState("");
  const [newPoolSize, setNewPoolSize] = useState(1);
  const [newPoolAsn, setNewPoolAsn] = useState("");
  const [newPoolUpstream, setNewPoolUpstream] = useState("");
  const [newPoolNotes, setNewPoolNotes] = useState("");
  const [poolErr, setPoolErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);

  // Grant (assign an available IP/block to a customer) state
  const [priceMap, setPriceMap] = useState<Record<number, number>>({});
  type GrantTarget =
    | { kind: "single"; ip: string }
    | { kind: "block"; cidr: string; size: number };
  const [grant, setGrant] = useState<GrantTarget | null>(null);
  const [gQuery, setGQuery] = useState("");
  const [gUsers, setGUsers] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [gUser, setGUser] = useState<{ id: string; email: string } | null>(null);
  const [gPriceBaht, setGPriceBaht] = useState("");
  const [gErr, setGErr] = useState<string | null>(null);
  const [gBusy, setGBusy] = useState(false);

  const loadPools = useCallback(async () => {
    const r = await fetch("/v1/admin/ips/pools", { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      setPools(d.pools);
      if (!poolId && d.pools[0]) setPoolId(d.pools[0].id);
    }
  }, [poolId]);
  useEffect(() => { void loadPools(); }, [loadPools]);

  async function addPool(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setPoolErr(null);
    try {
      const r = await fetch("/v1/admin/ips/pools", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          block: newPoolCidr,
          defaultSaleMode: newPoolSize === 1 ? "single" : "block",
          defaultBlockSize: newPoolSize === 1 ? undefined : newPoolSize,
          asn: newPoolAsn || undefined,
          upstreamProvider: newPoolUpstream || undefined,
          notes: newPoolNotes || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      setNewPoolCidr(""); setNewPoolAsn(""); setNewPoolUpstream(""); setNewPoolNotes("");
      await loadPools();
      setPoolId(j.id);
    } catch (e) { setPoolErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function deletePool(p: Pool) {
    setBusy(true); setPoolErr(null);
    try {
      const pre = await fetch(`/v1/admin/ips/pools/${p.id}/preflight`, { credentials: "same-origin" });
      const info = await pre.json().catch(() => null);
      if (!pre.ok || !info) throw new Error("preflight failed");
      if (!info.canDelete) {
        const sample = info.sampleAllocated.slice(0, 5)
          .map((s: { ip: string; ownerEmail: string | null; tunnelName: string | null }) =>
            `  • ${s.ip}${s.ownerEmail ? "  ← " + s.ownerEmail : ""}${s.tunnelName ? " (" + s.tunnelName + ")" : ""}`)
          .join("\n");
        alert(
          `❌ ลบ pool ${p.block} ไม่ได้\n\n${info.blockedReason}\n\n` +
          (sample ? `ตัวอย่าง:\n${sample}\n${info.allocatedIps > 5 ? "  ...อื่นๆ อีก\n" : ""}` : "") +
          `\nให้ user release IP / IP Block ก่อน แล้วลองใหม่`,
        );
        return;
      }
      const ok = confirm(`Delete pool ${p.block}?\n\n• Sale plans (${info.salePlansWillCascade}) จะถูกลบไปด้วยอัตโนมัติ\n• ไม่มี IP ใดถูก assign ให้ user อยู่ — ปลอดภัย\n\nดำเนินการต่อ?`);
      if (!ok) return;
      const r = await fetch(`/v1/admin/ips/pools/${p.id}`, { method: "DELETE", credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      if (poolId === p.id) setPoolId("");
      await loadPools();
    } catch (e) { setPoolErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const loadPlans = useCallback(async () => {
    if (!poolId) return;
    const r = await fetch(`/v1/admin/ips/pools/${poolId}/sale-plans`, { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      setPlans(d.plans); setPoolBlock(d.pool.block);
    }
  }, [poolId]);
  const loadIps = useCallback(async () => {
    if (!poolId) return;
    const r = await fetch(`/v1/admin/ips?pool=${poolId}`, { credentials: "same-origin" });
    if (r.ok) setIps((await r.json()).ips);
  }, [poolId]);
  useEffect(() => { void loadPlans(); void loadIps(); }, [loadPlans, loadIps]);

  // default recurring price per block size (catalog) for the grant panel prefill
  useEffect(() => {
    void (async () => {
      const r = await fetch("/v1/billing/pricing", { credentials: "same-origin" });
      if (!r.ok) return;
      const d = await r.json();
      const m: Record<number, number> = {};
      for (const it of d.ip ?? []) m[it.blockSize] = it.priceSatang;
      setPriceMap(m);
    })();
  }, []);

  // customer search (debounced autocomplete) — only after the admin types, so a
  // large user base doesn't flood the panel before a query is entered.
  useEffect(() => {
    if (!grant) return;
    const q = gQuery.trim();
    if (q.length < 2) { setGUsers([]); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/v1/admin/users?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
      if (r.ok) setGUsers((await r.json()).users ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [gQuery, grant]);

  function openGrant(t: GrantTarget) {
    const size = t.kind === "block" ? t.size : 1;
    const def = priceMap[size] ?? 0;
    setGrant(t);
    setGUser(null); setGQuery(""); setGUsers([]); setGErr(null);
    setGPriceBaht((def / 100).toFixed(2));
  }

  async function submitGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!grant || !gUser) { setGErr("เลือกลูกค้าก่อน"); return; }
    const priceSatang = Math.round(parseFloat(gPriceBaht || "0") * 100);
    if (!Number.isFinite(priceSatang) || priceSatang < 0) { setGErr("ราคาไม่ถูกต้อง"); return; }
    setGBusy(true); setGErr(null);
    try {
      const url = grant.kind === "single" ? "/v1/admin/ips/grant-single" : "/v1/admin/ips/grant-block";
      const body = grant.kind === "single"
        ? { userId: gUser.id, ip: grant.ip, priceSatang }
        : { userId: gUser.id, cidr: grant.cidr, priceSatang };
      const r = await fetch(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      setGrant(null);
      await Promise.all([loadIps(), loadPools()]);
    } catch (e) { setGErr((e as Error).message); }
    finally { setGBusy(false); }
  }

  async function addPlan(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setPlanErr(null);
    try {
      const r = await fetch(`/v1/admin/ips/pools/${poolId}/sale-plans`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cidr: planCidr,
          saleMode: planSize === 1 ? "single" : "block",
          blockSize: planSize === 1 ? undefined : planSize,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      setPlanCidr("");
      await loadPlans();
    } catch (e) { setPlanErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function deletePlan(p: Plan) {
    if (!confirm(`Delete sale plan ${p.cidr} (${p.saleMode}${p.blockSize ? " /" + (32 - Math.log2(p.blockSize)) : ""})?`)) return;
    setBusy(true); setPlanErr(null);
    try {
      const r = await fetch(`/v1/admin/ips/pools/${poolId}/sale-plans/${p.id}`, { method: "DELETE", credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      await loadPlans();
    } catch (e) { setPlanErr((e as Error).message); }
    finally { setBusy(false); }
  }

  let segments: { label: string; width: number; color: string; mode?: string }[] = [];
  if (poolBlock) {
    const pool = cidrParts(poolBlock);
    const sorted = [...plans].sort((a, b) => cidrParts(a.cidr).net - cidrParts(b.cidr).net);
    let cursor = pool.net;
    for (const p of sorted) {
      const cur = cidrParts(p.cidr);
      if (cur.net > cursor) {
        segments.push({ label: `unassigned ${cur.net - cursor}`, width: (cur.net - cursor) / pool.size, color: "var(--color-surface-2)" });
      }
      segments.push({
        label: `${p.cidr} ${p.saleMode === "single" ? "/32" : `IP Block /${32 - Math.log2(p.blockSize ?? 1)}`}`,
        width: cur.size / pool.size,
        color: p.saleMode === "single" ? "var(--color-success)" : "var(--color-primary)",
      });
      cursor = cur.net + cur.size;
    }
    if (cursor < pool.net + pool.size) {
      segments.push({ label: `unassigned ${pool.net + pool.size - cursor}`, width: (pool.net + pool.size - cursor) / pool.size, color: "var(--color-surface-2)" });
    }
    if (plans.length === 0) {
      segments = [{ label: "(no plans — defaults to ขาย /32 ทั้งหมด)", width: 1, color: "var(--color-surface-2)" }];
    }
  }

  const currentPool = pools.find((p) => p.id === poolId);

  // Collapse block-plan ranges into ONE card; single/no-plan IPs stay per-/32.
  type Card =
    | { kind: "single"; key: string; ip: string; row: IpRow }
    | { kind: "block"; key: string; cidr: string; size: number; available: boolean; owner: string | null };
  const cards: Card[] = [];
  {
    const sorted = [...ips].sort((a, b) => ip4ToInt(a.ip) - ip4ToInt(b.ip));
    const blockGroups = new Map<string, IpRow[]>();
    for (const r of sorted) {
      if (r.plan_mode === "block" && r.plan_block_size) {
        const size = r.plan_block_size;
        const n = ip4ToInt(r.ip);
        const start = n - (n % size);
        const cidr = `${intToIp4(start)}/${32 - Math.log2(size)}`;
        const arr = blockGroups.get(cidr) ?? [];
        arr.push(r); blockGroups.set(cidr, arr);
      } else {
        cards.push({ kind: "single", key: r.ip, ip: r.ip, row: r });
      }
    }
    for (const [cidr, members] of blockGroups) {
      const size = members[0].plan_block_size ?? members.length;
      const owner = members.find((m) => m.user_email)?.user_email ?? null;
      const available = members.every((m) => m.status === "available" && !m.user_email);
      cards.push({ kind: "block", key: cidr, cidr, size, available, owner });
    }
    cards.sort((a, b) =>
      ip4ToInt(a.kind === "single" ? a.ip : a.cidr.split("/")[0]) -
      ip4ToInt(b.kind === "single" ? b.ip : b.cidr.split("/")[0]));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">IP Pools</h1>
        <p className="page-subtitle">จัดการ IP pool, sale plans (ช่วงที่ขายเป็น /32 หรือ IP Block), และดูสถานะแต่ละ IP</p>
      </header>

      {/* Pool selector + Add pool */}
      <div className="card">
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Network size={18} strokeWidth={2} /> Pool
        </h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
          <select className="input" value={poolId} onChange={(e) => setPoolId(e.target.value)} style={{ flex: "0 1 280px" }}>
            {pools.length === 0 && <option value="">— no pools yet —</option>}
            {pools.map((p) => <option key={p.id} value={p.id}>{p.block}</option>)}
          </select>
          {currentPool && (
            <>
              <span style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
                allocated <strong style={{ color: "var(--color-text)" }}>{currentPool.allocated_count}</strong>
                {" · "}available <strong style={{ color: "var(--color-text)" }}>{currentPool.available_count}</strong>
              </span>
              <button disabled={busy} onClick={() => deletePool(currentPool)} className="btn btn-danger-outline btn-sm" style={{ marginLeft: "auto" }}>
                <Trash2 size={14} /> Delete pool
              </button>
            </>
          )}
        </div>

        <form onSubmit={addPool} style={{ marginTop: 16, padding: 14, border: "1px dashed var(--color-border-2)", borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={14} strokeWidth={2} /> Add new pool
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <input className="input" required placeholder="CIDR (e.g. 203.169.2.0/24)"
              value={newPoolCidr} onChange={(e) => setNewPoolCidr(e.target.value)} style={{ flex: "2 1 240px" }} />
            <select className="input" value={newPoolSize} onChange={(e) => setNewPoolSize(Number(e.target.value))} style={{ flex: "1 1 180px" }}>
              {SALE_SIZES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
            <input className="input" placeholder="ASN (optional)" value={newPoolAsn} onChange={(e) => setNewPoolAsn(e.target.value)} style={{ flex: "1 1 120px" }} />
            <input className="input" placeholder="upstream (optional)" value={newPoolUpstream} onChange={(e) => setNewPoolUpstream(e.target.value)} style={{ flex: "1 1 140px" }} />
            <button disabled={busy} type="submit" className="btn btn-primary">
              <Plus size={16} /> Add pool
            </button>
          </div>
          <input className="input" style={{ marginTop: 8 }} placeholder="notes (optional)"
            value={newPoolNotes} onChange={(e) => setNewPoolNotes(e.target.value)} />
          {poolErr && <p style={{ color: "var(--color-danger)", marginTop: 8, fontSize: 12 }}>⚠ {poolErr}</p>}
          <p style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-muted)" }}>
            ระบบจะสร้าง sale plan ครอบทั้งพูลให้อัตโนมัติด้วย mode/size ที่เลือก → ไปแก้/ซอย plan ย่อยภายหลังได้ด้านล่าง.
          </p>
        </form>
      </div>

      {/* Sale plans */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Layers size={18} strokeWidth={2} /> Sale plans
          </h2>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            ช่วง CIDR ย่อยในพูล กำหนดว่าขายเป็น /32 หรือ IP Block ขนาดเท่าไหร่
          </span>
        </div>

        {segments.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", height: 32, borderRadius: 8, overflow: "hidden", border: "1px solid var(--color-border)" }}>
              {segments.map((s, i) => (
                <div key={i} style={{ width: `${s.width * 100}%`, background: s.color, position: "relative" }} title={s.label}>
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 500, overflow: "hidden", whiteSpace: "nowrap", padding: "0 4px", textShadow: "0 1px 2px rgba(0,0,0,.3)" }}>
                    {s.width > 0.1 ? s.label : ""}
                  </div>
                </div>
              ))}
            </div>
            <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-muted)", marginTop: 4 }}>
              <span>{poolBlock.split("/")[0]}</span>
              <span>← {poolBlock} →</span>
            </div>
          </div>
        )}

        <table className="table-default" style={{ marginTop: 16 }}>
          <thead>
            <tr><th>CIDR</th><th>Mode</th><th>IP Block size</th><th>Used / Total</th><th></th></tr>
          </thead>
          <tbody>
            {plans.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>
                No plans defined — pool defaults to ขาย /32 รายตัวทั้งหมด.
              </td></tr>
            )}
            {plans.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.cidr}</td>
                <td>
                  <span className={p.saleMode === "single" ? "badge badge-success" : "badge badge-primary"}>
                    {p.saleMode === "single" ? "/32" : "IP Block"}
                  </span>
                </td>
                <td className="mono">{p.blockSize ? `/${32 - Math.log2(p.blockSize)} (${p.blockSize} IPs)` : "—"}</td>
                <td className="mono">{p.usedIps} / {p.totalIps}</td>
                <td><button disabled={busy} onClick={() => deletePlan(p)} className="btn btn-danger-outline btn-sm"><Trash2 size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>

        <form onSubmit={addPlan} style={{ marginTop: 16, padding: 14, border: "1px dashed var(--color-border-2)", borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={14} strokeWidth={2} /> Add sale plan
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <input className="input" required placeholder={`e.g. ${poolBlock || "104.238.11.0/28"}`}
              value={planCidr} onChange={(e) => setPlanCidr(e.target.value)} style={{ flex: "2 1 240px" }} />
            <select className="input" value={planSize} onChange={(e) => setPlanSize(Number(e.target.value))} style={{ flex: "2 1 200px" }}>
              {SALE_SIZES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
            <button disabled={busy} type="submit" className="btn btn-primary"><Plus size={16} /> Add</button>
          </div>
          {planErr && <p style={{ color: "var(--color-danger)", marginTop: 8, fontSize: 12 }}>⚠ {planErr}</p>}
          <p style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-muted)" }}>
            CIDR must be aligned and inside the pool, non-overlapping. For IP Block mode, range size ≥ IP Block size.
          </p>
        </form>
      </div>

      {/* IP grid */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Globe size={18} strokeWidth={2} /> IPs in pool <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>({cards.length})</span>
          </h2>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            ช่วงที่ขายยก Block รวมเป็นการ์ดเดียว · คลิกรายการที่ว่าง (available) เพื่อเพิ่มให้ลูกค้า
          </span>
        </div>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 6 }}>
          {cards.map((c) => {
            if (c.kind === "block") {
              const grantable = c.available;
              return (
                <div key={c.key} className="mono"
                  onClick={grantable ? () => openGrant({ kind: "block", cidr: c.cidr, size: c.size }) : undefined}
                  style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-primary)", background: "color-mix(in srgb, var(--color-primary) 8%, transparent)", fontSize: 12, cursor: grantable ? "pointer" : "default" }}
                  title={`${c.cidr} (IP Block, ${c.size} IPs)\n${c.owner ? "owner: " + c.owner : grantable ? "available — คลิกเพื่อเพิ่มให้ลูกค้า" : "ใช้งานบางส่วน"}`}>
                  <div style={{ fontWeight: 600 }}>{c.cidr}</div>
                  <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center", fontSize: 10, color: "var(--color-text-muted)" }}>
                    <Layers size={11} />
                    <span>{c.size} IPs</span>
                    <span style={{ marginLeft: "auto", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.owner ? c.owner : grantable ? "+ เพิ่มให้ลูกค้า" : "ใช้บางส่วน"}
                    </span>
                  </div>
                </div>
              );
            }
            const r = c.row;
            const statusColor = STATUS_COLOR[r.status] ?? "var(--color-text-subtle)";
            const planBg = r.plan_mode === "single"
              ? "color-mix(in srgb, var(--color-success) 8%, transparent)"
              : "var(--color-surface)";
            const planLabel = r.plan_mode === "single" ? "/32" : "no plan";
            const grantable = r.status === "available" && !r.user_email;
            return (
              <div key={c.key} className="mono"
                onClick={grantable ? () => openGrant({ kind: "single", ip: r.ip }) : undefined}
                style={{ padding: 8, borderRadius: 6, border: "1px solid var(--color-border)", background: planBg, fontSize: 12, cursor: grantable ? "pointer" : "default" }}
                title={`${r.ip}\nplan: ${planLabel}\nstatus: ${r.status}${r.user_email ? "\nowner: " + r.user_email : grantable ? "\nคลิกเพื่อเพิ่มให้ลูกค้า" : ""}${r.tunnel_name ? "\ntunnel: " + r.tunnel_name : ""}`}>
                <div style={{ fontWeight: 500 }}>{r.ip}</div>
                <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center", fontSize: 10, color: "var(--color-text-muted)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                  <span>{r.status}</span>
                  <span style={{ marginLeft: "auto", fontSize: 9 }}>{grantable ? "+ เพิ่ม" : planLabel}</span>
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 12 }}>
          <span style={{ display: "inline-block", width: 10, height: 10, background: "color-mix(in srgb, var(--color-success) 30%, transparent)", borderRadius: 2, marginRight: 4, verticalAlign: "middle" }} /> ขาย /32 &nbsp;
          <span style={{ display: "inline-block", width: 10, height: 10, background: "color-mix(in srgb, var(--color-primary) 30%, transparent)", borderRadius: 2, marginRight: 4, marginLeft: 8, verticalAlign: "middle" }} /> ขาย IP Block (รวมเป็นการ์ด) &nbsp;
          <span style={{ display: "inline-block", width: 10, height: 10, background: "var(--color-surface-2)", borderRadius: 2, marginRight: 4, marginLeft: 8, verticalAlign: "middle" }} /> ไม่มี plan ครอบ
        </p>
      </div>

      {/* Grant panel — assign an available IP/block to a customer (free, owned-unassigned) */}
      {grant && (
        <div onClick={() => !gBusy && setGrant(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(440px, 100%)", maxHeight: "90vh", overflow: "auto" }}>
            <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Plus size={18} strokeWidth={2} /> เพิ่ม {grant.kind === "block" ? "Block" : "IP"} ให้ลูกค้า
            </h2>
            <p className="mono" style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>
              {grant.kind === "block" ? `${grant.cidr} (${grant.size} IPs)` : grant.ip}
            </p>
            <form onSubmit={submitGrant} style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-muted)" }}>ลูกค้า</label>
                {gUser ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <span className="badge badge-success">{gUser.email}</span>
                    <button type="button" className="btn btn-sm" onClick={() => setGUser(null)}>เปลี่ยน</button>
                  </div>
                ) : (
                  <>
                    <input className="input" style={{ marginTop: 4 }} placeholder="พิมพ์ email / ชื่อ เพื่อค้นหา…"
                      value={gQuery} onChange={(e) => setGQuery(e.target.value)} autoFocus />
                    {gQuery.trim().length >= 2 && gUsers.length === 0 && (
                      <p style={{ marginTop: 4, fontSize: 11, color: "var(--color-text-muted)" }}>ไม่พบลูกค้าที่ตรงกับ &quot;{gQuery.trim()}&quot;</p>
                    )}
                    {gUsers.length > 0 && (
                      <div style={{ marginTop: 4, border: "1px solid var(--color-border)", borderRadius: 8, maxHeight: 180, overflow: "auto" }}>
                        {gUsers.map((u) => (
                          <button key={u.id} type="button"
                            onClick={() => { setGUser({ id: u.id, email: u.email }); setGUsers([]); }}
                            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "none", border: "none", borderBottom: "1px solid var(--color-border)", cursor: "pointer", fontSize: 13 }}>
                            <div style={{ fontWeight: 500 }}>{u.email}</div>
                            {u.name && <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{u.name}</div>}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--color-text-muted)" }}>ราคา/รอบ (฿)</label>
                <input className="input" type="number" step="0.01" min="0" style={{ marginTop: 4 }}
                  value={gPriceBaht} onChange={(e) => setGPriceBaht(e.target.value)} />
              </div>
              {gErr && <p style={{ color: "var(--color-danger)", fontSize: 12 }}>⚠ {gErr}</p>}
              <p style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                แถมฟรี (ไม่ตัด wallet) · ราคา = ค่าเช่ารอบถัดไป (อีก 31 วัน) · 0 = ฟรีถาวร
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn" disabled={gBusy} onClick={() => setGrant(null)}>ยกเลิก</button>
                <button type="submit" className="btn btn-primary" disabled={gBusy || !gUser}>
                  {gBusy ? "กำลังเพิ่ม…" : "เพิ่มให้ลูกค้า"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
