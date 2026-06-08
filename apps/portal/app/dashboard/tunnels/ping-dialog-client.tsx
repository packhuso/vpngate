"use client";
// Live ping modal — fires N sequential 1-packet pings to the tunnel's peer via
// the gateway agent, animating a bar chart as each result arrives. Stats
// (avg/min/max/loss) update on every tick.
import { useEffect, useRef, useState } from "react";
import { Radar, X } from "lucide-react";

interface Tick {
  seq: number;
  rttMs: number | null; // null = lost
}

const TOTAL_PINGS = 20;
const INTERVAL_MS = 250;

interface Props {
  tunnelId: string;
  tunnelName: string;
  privateIp: string;
  onClose: () => void;
}

export default function PingDialog({ tunnelId, tunnelName, privateIp, onClose }: Props) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [running, setRunning] = useState(true);
  const cancelRef = useRef(false);

  // Esc closes the modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    cancelRef.current = false;
    let seq = 0;
    let stopped = false;
    (async () => {
      while (seq < TOTAL_PINGS && !cancelRef.current) {
        const mySeq = ++seq;
        try {
          const r = await fetch(`/v1/tunnels/${tunnelId}/ping?count=1`, {
            method: "POST", credentials: "same-origin",
          });
          const j = await r.json().catch(() => ({}));
          const first = (j.results ?? [])[0];
          const rttMs = first?.avgMs ?? null; // single packet → avg = that packet's RTT
          if (cancelRef.current) break;
          setTicks((t) => [...t, { seq: mySeq, rttMs }]);
        } catch {
          if (cancelRef.current) break;
          setTicks((t) => [...t, { seq: mySeq, rttMs: null }]);
        }
        if (cancelRef.current) break;
        await new Promise((res) => setTimeout(res, INTERVAL_MS));
      }
      if (!stopped) setRunning(false);
    })();
    return () => {
      stopped = true;
      cancelRef.current = true;
    };
  }, [tunnelId]);

  // Stats
  const received = ticks.filter((t) => t.rttMs != null).map((t) => t.rttMs as number);
  const sent = ticks.length;
  const lost = sent - received.length;
  const lossPct = sent > 0 ? Math.round((lost / sent) * 100) : 0;
  const avg = received.length > 0 ? received.reduce((a, b) => a + b, 0) / received.length : null;
  const min = received.length > 0 ? Math.min(...received) : null;
  const max = received.length > 0 ? Math.max(...received) : null;

  // Auto-scale the bar chart to the max observed RTT (min 20ms range so 1ms
  // pings still look like bars, not flat lines).
  const yMax = Math.max(20, ...(received.length > 0 ? received : [0])) * 1.15;

  const stateColor =
    lossPct === 0 && received.length > 0 ? "var(--color-success)"
    : lossPct >= 100 ? "var(--color-danger)"
    : lossPct > 0 ? "var(--color-warning)"
    : "var(--color-text-muted)";

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", zIndex: 60, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: "min(560px, 100%)", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Radar size={18} strokeWidth={2}
              style={{ color: stateColor, animation: running ? "spin 2s linear infinite" : undefined }} />
            Ping {tunnelName}
          </h2>
          <button onClick={onClose} className="btn btn-ghost btn-sm" title="ปิด (Esc)">
            <X size={16} />
          </button>
        </div>
        <p className="mono" style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          gateway → {privateIp}
        </p>

        {/* Bar chart */}
        <div style={{ marginTop: 16, height: 140, background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: 8, position: "relative" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: "100%" }}>
            {Array.from({ length: TOTAL_PINGS }).map((_, i) => {
              const t = ticks[i];
              if (!t) {
                return <div key={i} style={{ flex: 1, height: 2, background: "var(--color-border)", borderRadius: 2, alignSelf: "flex-end", opacity: 0.4 }} />;
              }
              if (t.rttMs == null) {
                return <div key={i} title={`#${t.seq} lost`} style={{ flex: 1, height: "100%", background: "var(--color-danger)", borderRadius: 3, opacity: 0.7, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 9, fontWeight: 700 }}>×</div>;
              }
              const h = Math.max(4, (t.rttMs / yMax) * 100);
              const color = t.rttMs < 30 ? "var(--color-success)" : t.rttMs < 100 ? "var(--color-warning)" : "var(--color-danger)";
              return (
                <div key={i} title={`#${t.seq}: ${t.rttMs.toFixed(1)} ms`}
                  style={{ flex: 1, height: `${h}%`, background: color, borderRadius: "3px 3px 0 0", transition: "height 0.18s ease-out", display: "flex", alignItems: "flex-end", justifyContent: "center", color: "#fff", fontSize: 9, fontWeight: 600, paddingBottom: 1, overflow: "hidden" }}>
                  {h > 25 ? t.rttMs.toFixed(0) : ""}
                </div>
              );
            })}
          </div>
          <div style={{ position: "absolute", top: 4, right: 8, fontSize: 10, color: "var(--color-text-subtle)" }}>
            {yMax.toFixed(0)} ms
          </div>
          <div style={{ position: "absolute", bottom: 4, right: 8, fontSize: 10, color: "var(--color-text-subtle)" }}>
            0 ms
          </div>
        </div>

        {/* Stats grid */}
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          <Stat label="avg" value={avg != null ? `${avg.toFixed(1)} ms` : "—"} color="var(--color-primary)" />
          <Stat label="min" value={min != null ? `${min.toFixed(1)} ms` : "—"} />
          <Stat label="max" value={max != null ? `${max.toFixed(1)} ms` : "—"} />
          <Stat label="loss" value={`${lossPct}%`} color={lossPct === 0 ? "var(--color-success)" : "var(--color-danger)"} />
        </div>
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor, display: "inline-block", animation: running ? "pulse 1s ease-in-out infinite" : undefined }} />
          {running ? `กำลัง ping ${sent}/${TOTAL_PINGS}…` : `เสร็จ · ส่ง ${sent} · ตอบ ${received.length} · ตก ${lost}`}
        </p>

        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {!running && (
            <button onClick={() => { setTicks([]); setRunning(true); cancelRef.current = false;
              // re-trigger the effect by remounting via tunnelId? simpler: replay inline
              (async () => {
                let seq = 0;
                while (seq < TOTAL_PINGS && !cancelRef.current) {
                  const mySeq = ++seq;
                  try {
                    const r = await fetch(`/v1/tunnels/${tunnelId}/ping?count=1`, { method: "POST", credentials: "same-origin" });
                    const j = await r.json().catch(() => ({}));
                    const first = (j.results ?? [])[0];
                    setTicks((t) => [...t, { seq: mySeq, rttMs: first?.avgMs ?? null }]);
                  } catch {
                    setTicks((t) => [...t, { seq: mySeq, rttMs: null }]);
                  }
                  await new Promise((res) => setTimeout(res, INTERVAL_MS));
                }
                setRunning(false);
              })();
            }} className="btn btn-secondary btn-sm">
              <Radar size={14} /> ทดสอบใหม่
            </button>
          )}
          <button onClick={onClose} className="btn btn-primary btn-sm">ปิด</button>
        </div>
      </div>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
      `}</style>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
      <div className="mono" style={{ fontSize: 15, fontWeight: 700, marginTop: 2, color: color ?? "var(--color-text)" }}>{value}</div>
    </div>
  );
}
