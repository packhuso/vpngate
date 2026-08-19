"use client";
// Inline description editor for the tunnel detail page. Click the text
// (or the pencil) → textarea → save/cancel. Persists via PATCH /v1/tunnels/:id.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X } from "lucide-react";

const MAX = 300;

interface Props {
  tunnelId: string;
  initial: string | null;
}

export default function EditableDescription({ tunnelId, initial }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { setValue(initial ?? ""); }, [initial]);
  useEffect(() => { if (editing) areaRef.current?.focus(); }, [editing]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}`, {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: value.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "update failed");
      setEditing(false);
      router.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  function cancel() {
    setValue(initial ?? "");
    setEditing(false);
    setErr(null);
  }

  if (editing) {
    return (
      <div style={{ marginTop: 4 }}>
        <textarea
          ref={areaRef}
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); cancel(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }}
          maxLength={MAX}
          rows={2}
          disabled={busy}
          placeholder="Description (ภาษาไทยได้ · Ctrl/Cmd+Enter บันทึก · Esc ยกเลิก)"
          style={{ width: "100%", fontSize: 13, resize: "vertical" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <button onClick={save} disabled={busy} className="btn btn-primary btn-sm">
            <Check size={14} /> {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
          <button onClick={cancel} disabled={busy} className="btn btn-sm">
            <X size={14} /> ยกเลิก
          </button>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginLeft: "auto" }}>
            {value.length}/{MAX}
          </span>
        </div>
        {err && <p style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 4 }}>⚠ {err}</p>}
      </div>
    );
  }

  return (
    <p
      onClick={() => setEditing(true)}
      style={{
        fontSize: 13, color: "var(--color-text-muted)", marginTop: 4,
        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
        padding: "2px 6px", marginLeft: -6, borderRadius: 4,
      }}
      title="คลิกเพื่อแก้ไข"
    >
      {initial ? initial : <span style={{ fontStyle: "italic", color: "var(--color-text-subtle)" }}>เพิ่มคำอธิบาย…</span>}
      <Pencil size={12} strokeWidth={2} style={{ opacity: 0.6 }} />
    </p>
  );
}
