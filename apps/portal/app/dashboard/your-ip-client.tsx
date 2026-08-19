"use client";
import { useEffect, useState } from "react";
import { Wifi } from "lucide-react";

// "Your IP" — fetched live client-side (never server-cached) so it's always
// current and reflects the browser's real egress. IPv4 + IPv6 separately
// (dual-stack browsers reach Cloudflare over v6, so the server header showed v6
// only). onVpn = the fetched IP is one of the user's own VPN public IPs.
export default function YourIp({ vpnIps }: { vpnIps: string[] }) {
  const [v4, setV4] = useState<string | null>(null);
  const [v6, setV6] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const grab = async (url: string, set: (s: string) => void) => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && d?.ip) set(String(d.ip));
      } catch { /* network/family unavailable */ }
    };
    Promise.allSettled([
      grab("https://api.ipify.org?format=json", setV4),  // v4-only endpoint
      grab("https://api6.ipify.org?format=json", setV6), // v6-only endpoint
    ]).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const set = new Set(vpnIps);
  const onVpn = (!!v4 && set.has(v4)) || (!!v6 && set.has(v6));
  const primary = v4 ?? v6;

  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <span style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 11, background: "var(--color-bg)", color: onVpn ? "#16a34a" : "var(--color-text-muted)", border: "1px solid var(--color-border)" }}>
        <Wifi size={20} strokeWidth={2} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Your IP</div>
        {loading && !primary ? (
          <div style={{ fontSize: 14, color: "var(--color-text-muted)" }}>กำลังตรวจ…</div>
        ) : !primary ? (
          <div style={{ fontSize: 16, fontWeight: 600 }}>ตรวจไม่พบ</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
            {v4 && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>
                {v4} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--color-text-muted)" }}>IPv4</span>
              </div>
            )}
            {v6 && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-muted)", wordBreak: "break-all" }}>
                {v6} <span style={{ fontSize: 11 }}>IPv6</span>
              </div>
            )}
          </div>
        )}
      </div>
      {primary && (
        <span className={`badge ${onVpn ? "badge-success" : "badge-neutral"}`}>
          {onVpn ? "✓ กำลังใช้ VPN ของคุณ" : "ไม่ได้ใช้ IP ของคุณ"}
        </span>
      )}
    </div>
  );
}
