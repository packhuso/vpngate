"use client";
// Inline rename for a tunnel. Click the h1 (or the pencil) → input → save.
// Server enforces uniqueness per user + the config-file identifier regex.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X } from "lucide-react";

const NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

interface Props {
  tunnelId: string;
  initial: string;
}

export default function EditableName({ tunnelId, initial }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setValue(initial); }, [initial]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const trimmed = value.trim();
  const validShape = NAME_RE.test(trimmed);
  const dirty = trimmed !== initial;

  async function save() {
    if (!validShape || !dirty || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/v1/tunnels/${tunnelId}`, {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message?.message ?? j?.message ?? "rename failed");
      setEditing(false);
      router.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  function cancel() {
    setValue(initial);
    setEditing(false);
    setErr(null);
  }

  if (editing) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input
          ref={inputRef}
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); cancel(); }
            if (e.key === "Enter") { e.preventDefault(); void save(); }
          }}
          maxLength={100}
          pattern="[A-Za-z0-9_\-]{1,100}"
          disabled={busy}
          style={{
            fontSize: 24, fontWeight: 600, padding: "4px 8px",
            width: `${Math.max(value.length + 2, 12)}ch`, maxWidth: "60vw",
            borderColor: value && !validShape ? "var(--color-danger)" : undefined,
          }}
        />
        <button onClick={save} disabled={busy || !validShape || !dirty} className="btn btn-primary btn-sm" title="Save (Enter)">
          <Check size={14} /> {busy ? "…" : "Save"}
        </button>
        <button onClick={cancel} disabled={busy} className="btn btn-sm" title="Cancel (Esc)">
          <X size={14} />
        </button>
        {err && <span style={{ color: "var(--color-danger)", fontSize: 12 }}>⚠ {err}</span>}
        {value && !validShape && !err && (
          <span style={{ color: "var(--color-danger)", fontSize: 11 }}>a-z A-Z 0-9 - _ เท่านั้น</span>
        )}
      </span>
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}
      title="คลิกเพื่อเปลี่ยนชื่อ"
    >
      <h1 className="page-title" style={{ margin: 0 }}>{initial}</h1>
      <Pencil size={14} strokeWidth={2} style={{ opacity: 0.55 }} />
    </span>
  );
}
