"use client";
import { Lock } from "lucide-react";
import { CredRow } from "./copy-field-client";

export default function SstpCreds({
  server,
  port,
  username,
  password,
}: {
  server: string;
  port: string;
  username: string | null;
  password: string | null;
}) {
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

      {username ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <CredRow label="Server" value={server} />
          <CredRow label="Port" value={port} />
          <CredRow label="Username" value={username} />
          <CredRow label="Password" value={password ?? ""} secret />
        </div>
      ) : (
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: 0 }}>
          กดปุ่ม “Mikrotik script (.rsc)” ด้านบนหนึ่งครั้งเพื่อสร้าง credential แล้วรีเฟรชหน้า
        </p>
      )}

      <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 10, marginBottom: 0 }}>
        Mikrotik: ตั้ง <code className="mono">verify-server-certificate=no</code> (cert เป็น self-signed)
      </p>
    </div>
  );
}
