"use client";
// Pencil-icon editor for the GRE tunnel's remote endpoint host.
// Click → dialog → change domain/IP → PATCH /v1/tunnels/:id with
// remoteEndpointHost. Server validates (isPlausibleHost), resolves DNS if
// it's a domain, patches the agent's `remote`, writes DB + audit.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X } from "lucide-react";

const HOST_MAX = 253;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

interface Props {
  tunnelId: string;
  initialHost: string | null;
  initialIp: string | null;
}

export default function GreEndpointEditor({ tunnelId, initialHost, initialIp }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialHost ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const trimmed = value.trim();
  const isIp = IPV4_RE.test(trimmed);
  const validShape = trimmed.length > 0 && trimmed.length <= HOST_MAX &&
    (isIp || HOST_RE.test(trimmed));
  const dirty = trimmed !== (initialHost ?? "");

  function reset() {
    setValue(initialHost ?? "");
    setErr(null);
    setOkMsg(null);
  }

  async function save() {
    if (!validShape || !dirty || busy) return;
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}`, {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteEndpointHost: trimmed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "update failed");
      setOkMsg(`✓ อัปเดตเป็น ${trimmed}${j?.endpoint?.newIp && j.endpoint.newIp !== trimmed ? ` → ${j.endpoint.newIp}` : ""}`);
      router.refresh();
      setTimeout(() => { setOpen(false); setOkMsg(null); }, 900);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      {/* Trigger — pencil next to the endpoint value. */}
      <button
        type="button"
        onClick={() => { reset(); setOpen(true); }}
        className="btn btn-ghost btn-sm"
        title="แก้ไข endpoint"
        style={{ padding: "2px 6px", marginLeft: 6, verticalAlign: "middle" }}
      >
        <Pencil size={12} strokeWidth={2} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,.55)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 100, padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 460, width: "100%", padding: 20 }}>
            <h3 className="section-title" style={{ marginBottom: 4 }}>เปลี่ยน Endpoint (router ปลายทาง)</h3>
            <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 12 }}>
              ใส่ได้ทั้ง <strong>domain</strong> (เช่น <code>home.dyndns.org</code>) หรือ <strong>IP</strong> (เช่น <code>203.0.113.5</code>).
              ถ้าใส่ domain ระบบจะ resolve DNS และเช็คทุก 60 วินาที เผื่อ IP เปลี่ยน.
            </p>

            <label style={{ display: "block", fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
              Endpoint
            </label>
            <input
              autoFocus
              className="input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); if (!busy) setOpen(false); }
                if (e.key === "Enter") { e.preventDefault(); void save(); }
              }}
              maxLength={HOST_MAX}
              placeholder="home.dyndns.org  หรือ  203.0.113.5"
              disabled={busy}
              style={{ width: "100%", borderColor: value && !validShape ? "var(--color-danger)" : undefined }}
            />
            <div style={{ minHeight: 18, marginTop: 4, fontSize: 11, color: "var(--color-text-muted)" }}>
              {value && !validShape
                ? <span style={{ color: "var(--color-danger)" }}>รูปแบบไม่ถูกต้อง — ต้องเป็น domain หรือ IPv4</span>
                : validShape && isIp
                  ? <span>IP ตรง — ไม่ต้อง monitor DNS</span>
                  : validShape
                    ? <span>Domain — ระบบจะ monitor DNS ให้อัตโนมัติ</span>
                    : null}
            </div>

            {initialIp && (
              <p style={{ fontSize: 11, color: "var(--color-text-subtle)", marginTop: 4 }}>
                ปัจจุบัน: <code className="mono">{initialHost}</code>
                {initialHost !== initialIp && <> → <code className="mono">{initialIp}</code></>}
              </p>
            )}

            {err && <p style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 8 }}>⚠ {err}</p>}
            {okMsg && <p style={{ color: "var(--color-success)", fontSize: 12, marginTop: 8 }}>{okMsg}</p>}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                disabled={busy}
                className="btn btn-sm"
              >
                <X size={14} /> ยกเลิก
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !validShape || !dirty}
                className="btn btn-primary btn-sm"
              >
                <Check size={14} /> {busy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
