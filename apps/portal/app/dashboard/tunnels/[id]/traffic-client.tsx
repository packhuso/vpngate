"use client";
// Traffic panel for the tunnel detail page. Preset ranges + custom datetime,
// server-aggregated area chart (RX/TX in Mbps), summary cards for totals.
// Bucket auto-selects by range span so the chart stays readable at any zoom.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, Brush, Legend,
} from "recharts";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Gauge } from "lucide-react";

type Bucket = "5m" | "1h" | "1d";
interface Sample { ts: string; rx_bytes: number; tx_bytes: number }
interface Resp { samples: Sample[]; totalRx: number; totalTx: number; bucketMs: number }

const PRESETS: { label: string; hours: number }[] = [
  { label: "24 ชม.", hours: 24 },
  { label: "7 วัน", hours: 24 * 7 },
  { label: "30 วัน", hours: 24 * 30 },
];

// yyyy-MM-ddTHH:mm for <input type="datetime-local"> in LOCAL time.
function toInputLocal(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromInputLocal(s: string): Date { return new Date(s); }

function pickBucket(spanMs: number): Bucket {
  if (spanMs <= 2 * 24 * 3600_000) return "5m";
  if (spanMs <= 30 * 24 * 3600_000) return "1h";
  return "1d";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

function fmtMbps(bytes: number, ms: number): number {
  if (ms <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1_000_000;
}

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtTs(iso: string, bucketMs: number): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  if (bucketMs >= 86_400_000) return `${p(d.getDate())} ${MONTH_SHORT[d.getMonth()]}`;
  if (bucketMs >= 3_600_000) return `${p(d.getDate())} ${MONTH_SHORT[d.getMonth()]} ${p(d.getHours())}:00`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function TunnelTraffic({ tunnelId }: { tunnelId: string }) {
  const now = new Date();
  const [from, setFrom] = useState<Date>(new Date(now.getTime() - 24 * 3600_000));
  const [to, setTo] = useState<Date>(now);
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const bucket = useMemo(() => pickBucket(to.getTime() - from.getTime()), [from, to]);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(), to: to.toISOString(), bucket,
      });
      const r = await fetch(`/v1/tunnels/${tunnelId}/traffic?${params}`, { credentials: "same-origin" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "load failed");
      setData(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, [tunnelId, from, to, bucket]);

  useEffect(() => { void load(); }, [load]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.samples.map((s) => ({
      ts: s.ts,
      label: fmtTs(s.ts, data.bucketMs),
      rx_mbps: +fmtMbps(s.rx_bytes, data.bucketMs).toFixed(3),
      tx_mbps: +fmtMbps(s.tx_bytes, data.bucketMs).toFixed(3),
    }));
  }, [data]);

  const peakMbps = chartData.reduce(
    (m, r) => Math.max(m, r.rx_mbps, r.tx_mbps), 0,
  );

  function usePreset(hours: number) {
    const t = new Date();
    setTo(t);
    setFrom(new Date(t.getTime() - hours * 3600_000));
  }

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Activity size={18} strokeWidth={2} /> Traffic &amp; Data Usage
        </h2>
        <div style={{ display: "flex", gap: 6 }}>
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => usePreset(p.hours)} className="btn btn-sm">
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom range */}
      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--color-text-muted)" }}>จาก</span>
          <input
            type="datetime-local" value={toInputLocal(from)}
            onChange={(e) => setFrom(fromInputLocal(e.target.value))}
            className="input" style={{ padding: "3px 6px", fontSize: 12 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--color-text-muted)" }}>ถึง</span>
          <input
            type="datetime-local" value={toInputLocal(to)}
            onChange={(e) => setTo(fromInputLocal(e.target.value))}
            className="input" style={{ padding: "3px 6px", fontSize: 12 }}
          />
        </label>
        <span style={{ color: "var(--color-text-subtle)", fontSize: 11 }}>
          bucket: {bucket} · {chartData.length} points
        </span>
      </div>

      {/* Summary */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <StatCard icon={<ArrowDownToLine size={14} strokeWidth={2} />} label="Total RX" value={data ? fmtBytes(data.totalRx) : "—"} color="#0ea5e9" />
        <StatCard icon={<ArrowUpFromLine size={14} strokeWidth={2} />} label="Total TX" value={data ? fmtBytes(data.totalTx) : "—"} color="#16a34a" />
        <StatCard icon={<Gauge size={14} strokeWidth={2} />} label="Peak" value={peakMbps > 0 ? `${peakMbps.toFixed(1)} Mbps` : "—"} color="var(--color-primary)" />
      </div>

      {err && <p style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 8 }}>⚠ {err}</p>}

      {/* Chart */}
      <div style={{ marginTop: 14, height: 300, background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 4px 4px" }}>
        {busy && !data ? (
          <p style={{ textAlign: "center", color: "var(--color-text-muted)", paddingTop: 120, fontSize: 13 }}>
            กำลังโหลด…
          </p>
        ) : chartData.length === 0 ? (
          <p style={{ textAlign: "center", color: "var(--color-text-muted)", paddingTop: 120, fontSize: 13 }}>
            ยังไม่มี traffic ในช่วงนี้ — sampler เก็บทุก 5 นาที
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="rx" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="tx" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#16a34a" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#16a34a" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="label" stroke="var(--color-text-muted)" tick={{ fontSize: 10 }} />
              <YAxis stroke="var(--color-text-muted)" tick={{ fontSize: 10 }}
                label={{ value: "Mbps", angle: -90, position: "insideLeft", style: { fontSize: 10, fill: "var(--color-text-muted)" } }} />
              <Tooltip
                contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: "var(--color-text)" }}
                formatter={((v: unknown, name: unknown) => [
                  `${Number(v).toFixed(2)} Mbps`,
                  String(name) === "rx_mbps" ? "Download (RX)" : "Upload (TX)",
                ]) as never}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === "rx_mbps" ? "Download (RX)" : "Upload (TX)")} />
              <Area type="monotone" dataKey="rx_mbps" stroke="#0ea5e9" fill="url(#rx)" strokeWidth={1.5} />
              <Area type="monotone" dataKey="tx_mbps" stroke="#16a34a" fill="url(#tx)" strokeWidth={1.5} />
              {chartData.length > 20 && (
                <Brush dataKey="label" height={22} stroke="var(--color-primary)" travellerWidth={8} tickFormatter={() => ""} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: ".05em", display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ color }}>{icon}</span> {label}
      </div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}
