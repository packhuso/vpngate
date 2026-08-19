"use client";
// Two things for the GRE endpoint row:
//  1. "Check now" button → POST /v1/tunnels/:id/resolve-endpoint (calls the
//     same re-resolve flow the worker runs on a 3× ping-fail or hourly tick).
//  2. Collapsible history — lists past endpoint changes from audit_logs
//     (both operator-initiated `gre.endpoint_changed` and DNS-drift
//     `gre.endpoint_reresolved`).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, History, ArrowRight } from "lucide-react";
import { fmtDateTimeSec } from "../../../_lib/datetime";

interface Event {
  action: string;
  created_at: string;
  metadata: {
    oldHost?: string;
    newHost?: string;
    oldIp?: string;
    newIp?: string;
    host?: string;
  } | null;
}

interface Props {
  tunnelId: string;
}

export default function GreEndpointHistory({ tunnelId }: Props) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [flashKind, setFlashKind] = useState<"ok" | "err" | "info">("info");
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [histBusy, setHistBusy] = useState(false);

  async function checkNow() {
    if (checking) return;
    setChecking(true); setFlash(null);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}/resolve-endpoint`, {
        method: "POST", credentials: "same-origin",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "check failed");
      if (j.changed) {
        setFlashKind("ok");
        setFlash(`✓ IP เปลี่ยน: ${j.oldIp} → ${j.newIp}`);
        if (open) void loadHistory(); // history panel — new gre.endpoint_reresolved row
      } else {
        setFlashKind("info");
        setFlash(`✓ ตรวจแล้ว — ยังเป็น ${j.newIp} (ไม่เปลี่ยน)`);
      }
      // Always refresh — resolveGreEndpoint bumps remote_endpoint_resolved_at
      // in both branches, so "Last DNS resolve" should reflect the new time
      // even when the IP didn't move.
      router.refresh();
    } catch (e) {
      setFlashKind("err");
      setFlash(`⚠ ${(e as Error).message}`);
    } finally {
      setChecking(false);
      setTimeout(() => setFlash(null), 5000);
    }
  }

  async function loadHistory() {
    setHistBusy(true);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}/endpoint-history`, { credentials: "same-origin" });
      const j = await r.json();
      if (r.ok) setEvents(j.events ?? []);
    } finally { setHistBusy(false); }
  }

  useEffect(() => { if (open && events === null) void loadHistory(); },
    [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button
        onClick={checkNow}
        disabled={checking}
        className="btn btn-ghost btn-sm"
        title="ตรวจ DNS ทันที"
        style={{ padding: "2px 6px", marginLeft: 6, verticalAlign: "middle" }}
      >
        <RefreshCw size={12} strokeWidth={2}
          style={checking ? { animation: "spin 1s linear infinite" } : undefined} />
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn btn-ghost btn-sm"
        title="ดู history การเปลี่ยน IP"
        style={{ padding: "2px 6px", marginLeft: 2, verticalAlign: "middle" }}
      >
        <History size={12} strokeWidth={2} />
      </button>

      {flash && (
        <span style={{
          fontSize: 11, marginLeft: 8, padding: "1px 6px", borderRadius: 4,
          background: flashKind === "err" ? "rgba(239,68,68,.12)" : flashKind === "ok" ? "rgba(34,197,94,.12)" : "rgba(148,163,184,.12)",
          color: flashKind === "err" ? "#dc2626" : flashKind === "ok" ? "#16a34a" : "var(--color-text-muted)",
        }}>
          {flash}
        </span>
      )}

      {open && (
        <div className="card-compact" style={{ marginTop: 8, padding: 10, fontSize: 11 }}>
          <div style={{ fontWeight: 500, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
            <History size={12} /> Endpoint history
          </div>
          {histBusy && !events ? (
            <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
          ) : !events || events.length === 0 ? (
            <p style={{ color: "var(--color-text-muted)" }}>ยังไม่มีการเปลี่ยนแปลง</p>
          ) : (
            <table className="mono" style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
                  <th style={{ padding: "2px 6px", fontWeight: 500 }}>เวลา</th>
                  <th style={{ padding: "2px 6px", fontWeight: 500 }}>ประเภท</th>
                  <th style={{ padding: "2px 6px", fontWeight: 500 }}>เปลี่ยน</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => {
                  const md = e.metadata ?? {};
                  const isRename = e.action === "gre.endpoint_changed";
                  const from = isRename
                    ? (md.oldHost ?? md.oldIp ?? "?")
                    : (md.oldIp ?? "?");
                  const to = isRename
                    ? (md.newHost ?? md.newIp ?? "?")
                    : (md.newIp ?? "?");
                  return (
                    <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                      <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>{fmtDateTimeSec(e.created_at)}</td>
                      <td style={{ padding: "3px 6px" }}>
                        {isRename
                          ? <span style={{ color: "var(--color-primary)" }}>User edit</span>
                          : <span style={{ color: "var(--color-text-muted)" }}>DNS drift</span>}
                      </td>
                      <td style={{ padding: "3px 6px" }}>
                        {from} <ArrowRight size={10} style={{ verticalAlign: "middle", opacity: 0.6 }} /> {to}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
