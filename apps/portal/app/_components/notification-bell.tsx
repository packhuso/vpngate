"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, AlertTriangle, CircleAlert, Info, CheckCheck } from "lucide-react";

interface Notif {
  id: string;
  type: string;
  title: string;
  body: string | null;
  severity: string;
  readAt: string | null;
  createdAt: string;
}

const sevIcon = (s: string) =>
  s === "error" ? <CircleAlert size={15} color="var(--color-danger)" />
  : s === "warning" ? <AlertTriangle size={15} color="var(--color-warning)" />
  : <Info size={15} color="var(--color-info)" />;

const ago = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60) return "เมื่อกี้";
  if (d < 3600) return `${Math.floor(d / 60)} นาทีก่อน`;
  if (d < 86400) return `${Math.floor(d / 3600)} ชม.ก่อน`;
  return `${Math.floor(d / 86400)} วันก่อน`;
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<Notif[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const loadCount = useCallback(async () => {
    const r = await fetch("/v1/notifications/unread-count", { credentials: "same-origin" });
    if (r.ok) setCount((await r.json()).count ?? 0);
  }, []);
  const loadList = useCallback(async () => {
    const r = await fetch("/v1/notifications?limit=20", { credentials: "same-origin" });
    if (r.ok) setItems((await r.json()).notifications ?? []);
  }, []);

  useEffect(() => {
    void loadCount();
    const t = setInterval(() => void loadCount(), 30_000);
    return () => clearInterval(t);
  }, [loadCount]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) await loadList();
  }

  async function markAllRead() {
    await fetch("/v1/notifications/read", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setItems((xs) => xs.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    setCount(0);
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={toggle} title="การแจ้งเตือน"
        className="btn btn-ghost btn-sm" style={{ padding: 6, position: "relative" }}>
        <Bell size={16} strokeWidth={2} />
        {count > 0 && (
          <span style={{
            position: "absolute", top: -2, right: -2,
            minWidth: 16, height: 16, padding: "0 4px",
            borderRadius: 8, background: "var(--color-danger)", color: "#fff",
            fontSize: 10, fontWeight: 700, lineHeight: "16px", textAlign: "center",
          }}>{count > 99 ? "99+" : count}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", right: 0, top: 36, width: 340, maxHeight: 440,
          overflow: "auto", zIndex: 50,
          background: "var(--color-surface)", border: "1px solid var(--color-border)",
          borderRadius: 12, boxShadow: "0 12px 32px rgba(15,23,42,.16)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--color-border)" }}>
            <strong style={{ fontSize: 13 }}>การแจ้งเตือน</strong>
            <button onClick={markAllRead} className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: "2px 6px" }}>
              <CheckCheck size={13} /> อ่านทั้งหมด
            </button>
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-muted)", fontSize: 13 }}>
              ไม่มีการแจ้งเตือน
            </div>
          ) : (
            items.map((n) => (
              <div key={n.id} style={{
                display: "flex", gap: 10, padding: "10px 14px",
                borderBottom: "1px solid var(--color-border)",
                background: n.readAt ? "var(--color-surface)" : "var(--color-primary-soft)",
              }}>
                <div style={{ marginTop: 2 }}>{sevIcon(n.severity)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{n.title}</div>
                  {n.body && <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2 }}>{n.body}</div>}
                  <div style={{ fontSize: 11, color: "var(--color-text-subtle)", marginTop: 4 }}>{ago(n.createdAt)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
