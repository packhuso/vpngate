"use client";
import { useState } from "react";
import { Copy, Check, Eye, EyeOff, Lock } from "lucide-react";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch { /* clipboard blocked */ }
      }}
      title={copied ? "Copied!" : "Copy"}
      style={{
        display: "grid", placeItems: "center", width: 30, height: 30,
        border: "1px solid var(--color-border)", borderRadius: 8, cursor: "pointer",
        background: copied ? "var(--color-success-soft, #dcfce7)" : "var(--color-surface)",
        color: copied ? "var(--color-success, #16a34a)" : "var(--color-text-muted)",
        flexShrink: 0, transition: "all .12s",
      }}
    >
      {copied ? <Check size={15} strokeWidth={2.5} /> : <Copy size={15} strokeWidth={2} />}
    </button>
  );
}

function CredRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  const masked = secret && !show;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 84, flexShrink: 0, fontSize: 12, color: "var(--color-text-muted)" }}>{label}</span>
      <code
        className="mono"
        style={{
          flex: 1, minWidth: 0, padding: "7px 10px", fontSize: 13,
          background: "var(--color-bg)", border: "1px solid var(--color-border)",
          borderRadius: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          letterSpacing: masked ? "1px" : "normal",
        }}
      >
        {masked ? "•".repeat(Math.min(value.length, 24)) : value}
      </code>
      {secret && (
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          title={show ? "Hide" : "Show"}
          style={{
            display: "grid", placeItems: "center", width: 30, height: 30,
            border: "1px solid var(--color-border)", borderRadius: 8, cursor: "pointer",
            background: "var(--color-surface)", color: "var(--color-text-muted)", flexShrink: 0,
          }}
        >
          {show ? <EyeOff size={15} strokeWidth={2} /> : <Eye size={15} strokeWidth={2} />}
        </button>
      )}
      <CopyButton value={value} />
    </div>
  );
}

export default function SstpCreds({
  server,
  username,
  password,
}: {
  server: string;
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
