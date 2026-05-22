"use client";
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { CredRow } from "./copy-field-client";

export default function SstpCreds({
  tunnelId,
  server,
  port,
  username,
  password,
}: {
  tunnelId: string;
  server: string;
  port: string;
  username: string | null;
  password: string | null;
}) {
  // Server-rendered creds (cached). If absent on first view, auto-issue them
  // via the API so the user doesn't have to download the .rsc first. The
  // agent's SSTP IssueClientCert is idempotent, so this is safe to call.
  const [user, setUser] = useState<string | null>(username);
  const [pass, setPass] = useState<string | null>(password);
  const [srv, setSrv] = useState(server);
  const [prt, setPrt] = useState(port);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) return; // already cached → nothing to fetch
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/v1/tunnels/${tunnelId}/sstp-credentials`, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || "load failed");
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setUser(d.username ?? null);
        setPass(d.password ?? null);
        if (d.server) setSrv(String(d.server));
        if (d.port) setPrt(String(d.port));
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tunnelId, user]);

  return (
    <div
      style={{
        marginTop: 16, padding: 16, borderRadius: 12,
        border: "1px solid var(--color-border)", background: "var(--color-surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 8, background: "var(--color-warning-soft, #fef3c7)", color: "var(--color-warning, #d97706)" }}>
          <Lock size={15} strokeWidth={2.2} />
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>SSTP credentials</span>
      </div>

      {user ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <CredRow label="Server" value={srv} />
          <CredRow label="Port" value={prt} />
          <CredRow label="Username" value={user} />
          <CredRow label="Password" value={pass ?? ""} secret />
        </div>
      ) : loading ? (
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: 0 }}>
          กำลังสร้าง credential…
        </p>
      ) : error ? (
        <p style={{ fontSize: 13, color: "var(--color-danger)", margin: 0 }}>
          สร้าง credential ไม่สำเร็จ: {error} — ลองรีเฟรชหน้าอีกครั้ง
        </p>
      ) : (
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: 0 }}>
          กำลังเตรียม credential…
        </p>
      )}

      <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 10, marginBottom: 0 }}>
        Mikrotik: ตั้ง <code className="mono">verify-server-certificate=no</code> (cert เป็น self-signed)
      </p>
    </div>
  );
}
