"use client";
import { useCallback, useEffect, useState } from "react";
import { fmtDate, fmtDateTime } from "../../_lib/datetime";
import { FileText, Sparkles, Download, X, CheckCircle2, Circle, Pause, Play, Trash2, Clock } from "lucide-react";

interface Batch {
  id: string; name: string;
  codeCount: number; redeemedCount: number;
  valueSatang: number; totalRedeemedSatang: number;
  status: string; expiresAt: string | null; createdAt: string;
}
interface Redemption {
  userEmail: string | null;
  amountSatang: number;
  redeemedAt: string;
}
interface CodeDetail {
  id: string; code: string;
  currentUses: number; maxUsesTotal: number; maxUsesPerUser: number;
  status: string; createdAt: string;
  expiresAt: string | null;
  redemptions: Redemption[];
}

const fmt = (s: number) => `฿${(s / 100).toFixed(2)}`;

export default function AdminCodes() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [name, setName] = useState("");
  const [value, setValue] = useState(100);
  const [count, setCount] = useState(10);
  const [perUser, setPerUser] = useState(1);
  const [expiresAt, setExpiresAt] = useState(""); // datetime-local string, optional
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<Batch | null>(null);
  const [codes, setCodes] = useState<CodeDetail[] | null>(null);
  const [filter, setFilter] = useState<"all" | "used" | "unused">("all");
  const [batchExpiry, setBatchExpiry] = useState(""); // datetime-local for cascade

  const reload = useCallback(async () => {
    const r = await fetch("/v1/admin/codes/batches", { credentials: "same-origin" });
    if (r.ok) setBatches((await r.json()).batches);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const loadCodes = useCallback(async (batchId: string) => {
    setCodes(null);
    const r = await fetch(`/v1/admin/codes/batches/${batchId}`, { credentials: "same-origin" });
    if (r.ok) setCodes((await r.json()).codes);
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setGenerated(null);
    const effectiveCount = mode === "single" ? 1 : count;
    // single mode auto-names the batch if admin leaves it blank
    const effectiveName =
      name.trim() ||
      (mode === "single"
        ? `Single ฿${value} ${fmtDateTime(new Date())}`
        : "");
    try {
      const r = await fetch("/v1/admin/codes/batches", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: effectiveName, valueSatang: Math.round(value * 100),
          count: effectiveCount,
          maxUsesPerUser: perUser, maxUsesTotal: 1,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "create failed");
      setGenerated(j.codes);
      setName(""); setExpiresAt("");
      await reload();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  function openBatch(b: Batch) {
    setSelected(b);
    setFilter("all");
    setBatchExpiry("");
    void loadCodes(b.id);
  }

  async function codeAction(codeId: string, path: string, body: object) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/v1/admin/codes/${codeId}/${path}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      if (selected) await loadCodes(selected.id);
      await reload();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function batchAction(path: string, body: object) {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/v1/admin/codes/batches/${selected.id}/${path}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "failed");
      await loadCodes(selected.id);
      await reload();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const filteredCodes = codes?.filter((c) => {
    if (filter === "used") return c.currentUses > 0;
    if (filter === "unused") return c.currentUses === 0;
    return true;
  }) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Credit codes</h1>
        <p className="page-subtitle">สร้าง / ดู / export credit codes สำหรับแจกให้ user</p>
      </header>

      {/* Create code(s) */}
      <div className="card">
        <h2 className="section-title">สร้าง Credit Code</h2>

        {/* mode toggle */}
        <div style={{ display: "inline-flex", gap: 2, marginTop: 12, padding: 3, background: "var(--color-surface-2)", borderRadius: 8 }}>
          <button type="button" onClick={() => setMode("single")}
            className={mode === "single" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>
            1 code
          </button>
          <button type="button" onClick={() => setMode("batch")}
            className={mode === "batch" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>
            หลายอัน (batch)
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 8 }}>
          {mode === "single"
            ? "สร้าง code เดียว — ไม่ต้องตั้งชื่อ batch (ระบบตั้งให้อัตโนมัติ)"
            : "สร้างหลาย codes พร้อมกัน — แต่ละ code มูลค่าเท่ากัน"}
        </p>

        <form onSubmit={create} style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16, alignItems: "flex-end" }}>
          {mode === "batch" && (
            <div style={{ flex: "2 1 240px", minWidth: 200 }}>
              <label className="label">ชื่อ batch <span style={{ color: "var(--color-danger)" }}>*</span></label>
              <input className="input" required placeholder="เช่น Promotion Jan 2026"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {mode === "single" && (
            <div style={{ flex: "2 1 240px", minWidth: 200 }}>
              <label className="label">ป้ายกำกับ (ไม่บังคับ)</label>
              <input className="input" placeholder="เว้นว่างได้ — ระบบตั้งชื่อให้"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label className="label">มูลค่า (฿) <span style={{ color: "var(--color-danger)" }}>*</span></label>
            <input className="input" type="number" min={1} step="0.01" placeholder="100"
              value={value} onChange={(e) => setValue(Number(e.target.value))} />
          </div>
          {mode === "batch" && (
            <div style={{ flex: "1 1 110px", minWidth: 100 }}>
              <label className="label">จำนวน codes <span style={{ color: "var(--color-danger)" }}>*</span></label>
              <input className="input" type="number" min={1} max={10000} placeholder="10"
                value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </div>
          )}
          <div style={{ flex: "1 1 130px", minWidth: 120 }}>
            <label className="label">ใช้ได้/user (ครั้ง)</label>
            <input className="input" type="number" min={1} placeholder="1"
              value={perUser} onChange={(e) => setPerUser(Number(e.target.value))} />
          </div>
          <div style={{ flex: "1 1 200px", minWidth: 180 }}>
            <label className="label">หมดอายุ (ไม่บังคับ)</label>
            <input className="input" type="datetime-local"
              value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <button disabled={busy} type="submit" className="btn btn-primary">
            <Sparkles size={16} />{busy ? "…" : mode === "single" ? "สร้าง code" : "Generate"}
          </button>
        </form>

        {err && <p style={{ color: "var(--color-danger)", marginTop: 10, fontSize: 13 }}>⚠ {err}</p>}
        {generated && (
          <div style={{ marginTop: 16, padding: 14, background: "var(--color-success-soft)", borderRadius: 10, border: "1px solid var(--color-success)" }}>
            <strong style={{ color: "var(--color-success)", display: "flex", alignItems: "center", gap: 6 }}>
              <CheckCircle2 size={16} /> Generated {generated.length} codes ({fmt(value * 100)} ต่อ code)
            </strong>
            <textarea readOnly value={generated.join("\n")} className="input mono"
              style={{ height: 200, marginTop: 8, fontSize: 13 }} />
            <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 6 }}>
              💡 ก๊อปเก็บไว้ก่อนแจกให้ user — หาดูภายหลังได้ที่ batch detail ด้านล่าง
            </p>
          </div>
        )}
      </div>

      {/* Batches list */}
      <div className="card">
        <h2 className="section-title">Batches <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({batches.length})</span></h2>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
          คลิกที่แถวเพื่อดู codes ใน batch + redemption history
        </p>
        <table className="table-default" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Name</th><th>มูลค่า/code</th><th>Codes</th><th>ใช้แล้ว</th>
              <th>เหลือ</th><th>รวมจ่าย</th><th>Status</th><th>Created</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr><td colSpan={8} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>
                ยังไม่มี batch — สร้างด้านบน
              </td></tr>
            )}
            {batches.map((b) => (
              <tr key={b.id} onClick={() => openBatch(b)}
                style={{ cursor: "pointer", background: selected?.id === b.id ? "var(--color-primary-soft)" : undefined }}>
                <td style={{ fontWeight: 500 }}>{b.name}</td>
                <td className="mono">{fmt(b.valueSatang)}</td>
                <td className="mono">{b.codeCount}</td>
                <td className="mono" style={{ color: b.redeemedCount > 0 ? "var(--color-warning)" : undefined }}>{b.redeemedCount}</td>
                <td className="mono">{b.codeCount - b.redeemedCount}</td>
                <td className="mono">{fmt(b.totalRedeemedSatang)}</td>
                <td><span className="badge badge-success">{b.status}</span></td>
                <td style={{ color: "var(--color-text-muted)" }}>{fmtDate(b.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Batch detail */}
      {selected && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FileText size={18} strokeWidth={2} /> {selected.name}
              <span style={{ fontWeight: 400, color: "var(--color-text-muted)", fontSize: 13, marginLeft: 8 }}>
                {selected.codeCount} codes · {fmt(selected.valueSatang)}/code · จ่ายไป {fmt(selected.totalRedeemedSatang)}
              </span>
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              <a href={`/v1/admin/codes/batches/${selected.id}/export.csv`} download
                className="btn btn-secondary btn-sm" title="ดาวน์โหลด CSV เปิดใน Excel/Sheets">
                <Download size={14} /> CSV
              </a>
              <button onClick={() => { setSelected(null); setCodes(null); }} className="btn btn-ghost btn-sm">
                <X size={14} /> ปิด
              </button>
            </div>
          </div>

          {/* batch-level controls */}
          <div className="card-compact" style={{ marginTop: 12, borderStyle: "dashed", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-muted)" }}>ทั้ง batch:</span>
            <button disabled={busy} onClick={() => { if (confirm("Suspend ทุก code ใน batch นี้?")) void batchAction("status", { status: "paused" }); }} className="btn btn-secondary btn-sm">
              <Pause size={13} /> Suspend all
            </button>
            <button disabled={busy} onClick={() => void batchAction("status", { status: "active" })} className="btn btn-secondary btn-sm">
              <Play size={13} /> Activate all
            </button>
            <button disabled={busy} onClick={() => { if (confirm("ลบ (revoke) ทุก code ใน batch นี้? ใช้ไม่ได้อีก")) void batchAction("status", { status: "revoked" }); }} className="btn btn-danger-outline btn-sm">
              <Trash2 size={13} /> Delete all
            </button>
            <span style={{ marginLeft: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <Clock size={13} color="var(--color-text-muted)" />
              <input className="input" type="datetime-local" value={batchExpiry}
                onChange={(e) => setBatchExpiry(e.target.value)} style={{ width: 200, padding: "4px 8px", fontSize: 12 }} />
              <button disabled={busy} onClick={() => void batchAction("expiry", { expiresAt: batchExpiry ? new Date(batchExpiry).toISOString() : null })} className="btn btn-secondary btn-sm">
                ตั้งหมดอายุ
              </button>
              <button disabled={busy} onClick={() => void batchAction("expiry", { expiresAt: null })} className="btn btn-ghost btn-sm" title="เคลียร์วันหมดอายุ">
                ไม่หมดอายุ
              </button>
            </span>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 4 }}>
            {(["all", "unused", "used"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={filter === f ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}>
                {f === "all" ? `ทั้งหมด (${codes?.length ?? 0})`
                  : f === "unused" ? `ยังไม่ใช้ (${codes?.filter((c) => c.currentUses === 0).length ?? 0})`
                  : `ใช้แล้ว (${codes?.filter((c) => c.currentUses > 0).length ?? 0})`}
              </button>
            ))}
          </div>

          {!codes ? <p style={{ color: "var(--color-text-muted)", marginTop: 12 }}>กำลังโหลด…</p> : (
            <table className="table-default mono" style={{ marginTop: 12, fontSize: 13 }}>
              <thead>
                <tr><th>Code</th><th>Status</th><th>Uses</th><th>หมดอายุ</th><th>Actions</th><th>ใครใช้ / เมื่อไหร่</th></tr>
              </thead>
              <tbody>
                {filteredCodes.length === 0 && (
                  <tr><td colSpan={6} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>ไม่มี codes ในหมวดนี้</td></tr>
                )}
                {filteredCodes.map((c) => {
                  const expired = c.expiresAt && new Date(c.expiresAt) <= new Date();
                  const effStatus = c.status === "revoked" ? "revoked"
                    : c.status === "paused" ? "paused"
                    : expired || c.status === "expired" ? "expired"
                    : c.currentUses > 0 ? "used" : "active";
                  const badge =
                    effStatus === "revoked" ? <span className="badge badge-danger"><Trash2 size={9} strokeWidth={2.5} />ลบแล้ว</span>
                    : effStatus === "paused" ? <span className="badge badge-warning"><Pause size={9} strokeWidth={2.5} />พัก</span>
                    : effStatus === "expired" ? <span className="badge badge-neutral"><Clock size={9} strokeWidth={2.5} />หมดอายุ</span>
                    : effStatus === "used" ? <span className="badge badge-info"><CheckCircle2 size={10} strokeWidth={2.5} />ใช้แล้ว</span>
                    : <span className="badge badge-success"><Circle size={9} strokeWidth={2.5} />พร้อมใช้</span>;
                  const isDead = c.status === "revoked";
                  return (
                    <tr key={c.id}>
                      <td style={{ color: effStatus === "active" ? "var(--color-success)" : "var(--color-text-muted)", textDecoration: isDead ? "line-through" : undefined }}>{c.code}</td>
                      <td>{badge}</td>
                      <td>{c.currentUses}{c.maxUsesTotal > 0 ? `/${c.maxUsesTotal}` : ""}</td>
                      <td style={{ color: expired ? "var(--color-danger)" : "var(--color-text-muted)" }}>
                        {c.expiresAt ? fmtDateTime(c.expiresAt) : "—"}
                      </td>
                      <td>
                        <span style={{ display: "flex", gap: 4 }}>
                          {c.status === "paused"
                            ? <button disabled={busy} onClick={() => void codeAction(c.id, "status", { status: "active" })} className="btn btn-secondary btn-sm" title="Activate"><Play size={12} /></button>
                            : c.status !== "revoked" && (
                              <button disabled={busy} onClick={() => void codeAction(c.id, "status", { status: "paused" })} className="btn btn-secondary btn-sm" title="Suspend"><Pause size={12} /></button>
                            )}
                          {c.status !== "revoked" && (
                            <button disabled={busy} onClick={() => { if (confirm(`ลบ code ${c.code}? ใช้ไม่ได้อีก`)) void codeAction(c.id, "status", { status: "revoked" }); }} className="btn btn-danger-outline btn-sm" title="Delete (revoke)"><Trash2 size={12} /></button>
                          )}
                          {c.status === "revoked" && (
                            <button disabled={busy} onClick={() => void codeAction(c.id, "status", { status: "active" })} className="btn btn-ghost btn-sm" title="Restore">↩</button>
                          )}
                        </span>
                      </td>
                      <td>
                        {c.redemptions.length === 0
                          ? <span style={{ color: "var(--color-text-subtle)" }}>—</span>
                          : (
                            <div>
                              {c.redemptions.map((r, i) => (
                                <div key={i}>
                                  <span style={{ color: "var(--color-primary)" }}>{r.userEmail ?? "(deleted user)"}</span>
                                  <span style={{ color: "var(--color-text-muted)" }}> · {fmtDateTime(r.redeemedAt)}</span>
                                  <span style={{ color: "var(--color-success)" }}> · +{fmt(r.amountSatang)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
