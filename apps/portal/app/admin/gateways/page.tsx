"use client";
import { useCallback, useEffect, useState } from "react";
import { Router, RefreshCw, ChevronDown, ChevronRight, Wifi, WifiOff, CircleDot } from "lucide-react";
import { fmtLogTime } from "../../_lib/datetime";

interface Row {
  id: string;
  hostname: string;
  status: string;
  bgpEnabled: boolean;
  wgEndpoint: string | null;
  reachable: boolean;
  error?: string;
  peersTotal?: number;
  peersOnline?: number;
  bgpAvailable?: boolean;
  bgpNeighborsUp?: number;
  bgpNeighborsTotal?: number;
  prefixCount?: number;
}

interface Detail {
  hostname: string;
  collectedAt: string;
  bgp: {
    available: boolean;
    localAs?: number;
    routerId?: string;
    neighbors: {
      neighbor: string;
      remoteAs: number;
      state: string;
      uptimeSeconds: number;
      pfxRcd: number;
      pfxSnt: number;
    }[];
  };
  prefixList: { name: string; entries: { seq: number; action: string; prefix: string; ge?: number; le?: number }[] };
  peers: {
    publicKey: string;
    privateIp: string;
    publicIps: string[];
    online: boolean;
    lastHandshake: string | null;
    lastEndpoint: string | null;
  }[];
  warnings: string[];
}

const fmtUptime = (s: number) => {
  if (!s || s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="badge"
      style={{
        background: ok ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
        color: ok ? "#16a34a" : "#dc2626",
      }}
    >
      {label}
    </span>
  );
}

function GatewayDetail({ hostname }: { hostname: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(`/v1/admin/gateways/${encodeURIComponent(hostname)}/routing`, {
      credentials: "same-origin",
    })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.message) setErr(typeof j.message === "string" ? j.message : JSON.stringify(j.message));
        else setD(j);
      })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [hostname]);

  if (err) return <p style={{ color: "var(--color-danger)", fontSize: 12 }}>⚠ {err}</p>;
  if (!d) return <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Loading…</p>;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* BGP neighbors */}
      <section>
        <h4 style={{ fontSize: 12, textTransform: "uppercase", color: "var(--color-text-muted)", letterSpacing: ".05em", margin: "0 0 6px" }}>
          BGP neighbors {d.bgp.available && d.bgp.localAs && <span style={{ fontWeight: 400 }}>· local AS {d.bgp.localAs} · router-id {d.bgp.routerId}</span>}
        </h4>
        {d.bgp.neighbors.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            {d.bgp.available ? "No neighbors configured." : "BGP not available on this gateway."}
          </p>
        ) : (
          <table className="mono" style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>Neighbor</th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>AS</th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>State</th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>Uptime</th>
                <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Rcvd</th>
                <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Sent</th>
              </tr>
            </thead>
            <tbody>
              {d.bgp.neighbors.map((n) => (
                <tr key={n.neighbor} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "4px 8px" }}>{n.neighbor}</td>
                  <td style={{ padding: "4px 8px" }}>{n.remoteAs}</td>
                  <td style={{ padding: "4px 8px" }}>
                    <StatusBadge ok={n.state === "Established"} label={n.state} />
                  </td>
                  <td style={{ padding: "4px 8px" }}>{fmtUptime(n.uptimeSeconds)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>{n.pfxRcd}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>{n.pfxSnt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Prefix-list */}
      <section>
        <h4 style={{ fontSize: 12, textTransform: "uppercase", color: "var(--color-text-muted)", letterSpacing: ".05em", margin: "0 0 6px" }}>
          Announced prefixes ({d.prefixList.name}) · {d.prefixList.entries.length}
        </h4>
        {d.prefixList.entries.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Prefix-list is empty.</p>
        ) : (
          <div className="mono" style={{ fontSize: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 4 }}>
            {d.prefixList.entries.map((e) => (
              <div key={e.seq} style={{ padding: "2px 6px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 4 }}>
                <span style={{ color: "var(--color-text-muted)" }}>#{e.seq} </span>
                {e.prefix}
                {e.ge ? <span style={{ color: "var(--color-text-muted)" }}> ge {e.ge}</span> : null}
                {e.le ? <span style={{ color: "var(--color-text-muted)" }}> le {e.le}</span> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* WG peers */}
      <section>
        <h4 style={{ fontSize: 12, textTransform: "uppercase", color: "var(--color-text-muted)", letterSpacing: ".05em", margin: "0 0 6px" }}>
          WireGuard peers · {d.peers.filter((p) => p.online).length}/{d.peers.length} online
        </h4>
        {d.peers.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No peers.</p>
        ) : (
          <table className="mono" style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}></th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>Private</th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>Public</th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>Last handshake</th>
                <th style={{ padding: "4px 8px", fontWeight: 500 }}>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              {d.peers.map((p) => (
                <tr key={p.publicKey} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "4px 8px" }}>
                    {p.online
                      ? <Wifi size={12} style={{ color: "#16a34a" }} />
                      : <WifiOff size={12} style={{ color: "var(--color-text-muted)" }} />}
                  </td>
                  <td style={{ padding: "4px 8px" }}>{p.privateIp}</td>
                  <td style={{ padding: "4px 8px" }}>{p.publicIps.length ? p.publicIps.join(", ") : <span style={{ color: "var(--color-text-muted)" }}>—</span>}</td>
                  <td style={{ padding: "4px 8px" }}>{p.lastHandshake ? fmtLogTime(p.lastHandshake) : <span style={{ color: "var(--color-text-muted)" }}>never</span>}</td>
                  <td style={{ padding: "4px 8px" }}>{p.lastEndpoint ?? <span style={{ color: "var(--color-text-muted)" }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {d.warnings.length > 0 && (
        <div style={{ padding: 8, background: "rgba(234,179,8,.1)", border: "1px solid rgba(234,179,8,.3)", borderRadius: 6, fontSize: 11 }}>
          <strong>Warnings:</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {d.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <p style={{ fontSize: 10, color: "var(--color-text-muted)", textAlign: "right" }}>
        collected {fmtLogTime(d.collectedAt)}
      </p>
    </div>
  );
}

export default function AdminGateways() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/v1/admin/gateways", { credentials: "same-origin" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message ?? "load failed");
      setRows(j.gateways);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = (h: string) => setOpen((s) => {
    const n = new Set(s);
    n.has(h) ? n.delete(h) : n.add(h);
    return n;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Router size={22} strokeWidth={2} /> Gateways
          </h1>
          <p className="page-subtitle">Routing check — BGP session, WG peers, prefix-list</p>
        </div>
        <button onClick={load} disabled={busy} className="btn btn-secondary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <RefreshCw size={14} className={busy ? "spin" : ""} /> Refresh
        </button>
      </header>

      {err && <p style={{ color: "var(--color-danger)", fontSize: 13 }}>⚠ {err}</p>}
      {!rows ? (
        <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>No gateways.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => {
            const isOpen = open.has(r.hostname);
            const canOpen = r.reachable;
            return (
              <div key={r.id} className="card" style={{ padding: 0 }}>
                <button
                  onClick={() => canOpen && toggle(r.hostname)}
                  disabled={!canOpen}
                  style={{
                    width: "100%", padding: 14, textAlign: "left",
                    display: "grid",
                    gridTemplateColumns: "20px 1fr auto auto auto auto",
                    gap: 12, alignItems: "center",
                    background: "transparent", border: 0, cursor: canOpen ? "pointer" : "default",
                    color: "inherit",
                  }}
                >
                  {canOpen
                    ? (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />)
                    : <span />}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                      {r.hostname}
                      <span className={`badge ${r.status === "active" ? "badge-success" : "badge-neutral"}`}>{r.status}</span>
                      {r.bgpEnabled && <span className="badge badge-primary">BGP</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                      wg: {r.wgEndpoint ?? "—"}
                      {r.error && <span style={{ color: "var(--color-danger)", marginLeft: 8 }}>· {r.error}</span>}
                    </div>
                  </div>
                  {r.reachable ? (
                    <>
                      <Stat label="BGP" value={`${r.bgpNeighborsUp}/${r.bgpNeighborsTotal}`} ok={(r.bgpNeighborsUp ?? 0) === (r.bgpNeighborsTotal ?? 0) && (r.bgpNeighborsTotal ?? 0) > 0} />
                      <Stat label="Peers" value={`${r.peersOnline}/${r.peersTotal}`} ok={(r.peersOnline ?? 0) > 0} />
                      <Stat label="Prefixes" value={String(r.prefixCount ?? 0)} ok={(r.prefixCount ?? 0) > 0} />
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#16a34a", fontSize: 11 }}>
                        <CircleDot size={10} /> reachable
                      </span>
                    </>
                  ) : (
                    <>
                      <span /><span /><span />
                      <span style={{ color: "var(--color-danger)", fontSize: 11 }}>unreachable</span>
                    </>
                  )}
                </button>
                {isOpen && (
                  <div style={{ padding: "0 14px 14px", borderTop: "1px solid var(--color-border)" }}>
                    <div style={{ paddingTop: 12 }}>
                      <GatewayDetail hostname={r.hostname} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <style jsx>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Stat({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ textAlign: "center", minWidth: 60 }}>
      <div style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: ok ? "inherit" : "var(--color-danger)" }}>{value}</div>
    </div>
  );
}
