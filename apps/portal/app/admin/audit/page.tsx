"use client";
import { useCallback, useEffect, useState } from "react";
import { fmtLogTime } from "../../_lib/datetime";
import { Filter, RefreshCw } from "lucide-react";

interface Log {
  id: string;
  actor_type: string;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  success: boolean;
  metadata: unknown;
  created_at: string;
}

export default function AdminAudit() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(
      `/v1/admin/audit?limit=200${filter ? "&action=" + encodeURIComponent(filter) : ""}`,
      { credentials: "same-origin" },
    );
    if (r.ok) setLogs((await r.json()).logs);
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Audit log</h1>
        <p className="page-subtitle">ทุก action ในระบบ (user + admin + system) แสดงตามลำดับล่าสุด</p>
      </header>

      <div className="card">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <Filter size={16} strokeWidth={2} style={{ alignSelf: "center", color: "var(--color-text-muted)" }} />
          <input className="input" placeholder="filter action prefix (e.g. tunnel., ip., code., billing.)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={load} className="btn btn-primary">
            <RefreshCw size={14} /> Apply
          </button>
        </div>
        <table className="table-default mono" style={{ fontSize: 12 }}>
          <thead>
            <tr><th>Time (UTC)</th><th>Actor</th><th>Action</th><th>Resource</th><th>Metadata</th></tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr><td colSpan={5} style={{ color: "var(--color-text-muted)", padding: "20px 12px", textAlign: "center" }}>ไม่มี log</td></tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} style={{ color: l.success ? undefined : "var(--color-danger)" }}>
                <td style={{ color: "var(--color-text-muted)" }}>{fmtLogTime(l.created_at)}</td>
                <td>
                  <span className={l.actor_type === "admin" ? "badge badge-warning" : l.actor_type === "system" ? "badge badge-neutral" : "badge badge-info"}>{l.actor_type}</span>
                  {l.actor_email && <span style={{ marginLeft: 4, color: "var(--color-text-muted)" }}>{l.actor_email}</span>}
                </td>
                <td style={{ fontWeight: 500 }}>{l.action}</td>
                <td style={{ color: "var(--color-text-muted)" }}>
                  {l.resource_type ?? ""}{l.resource_id ? ":" + l.resource_id.slice(0, 8) : ""}
                </td>
                <td style={{ color: "var(--color-text-muted)", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.metadata ? JSON.stringify(l.metadata) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
