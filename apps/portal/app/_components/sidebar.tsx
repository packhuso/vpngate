"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { onDataChanged } from "./refresh-bus";
import {
  LayoutDashboard,
  Cable,
  Globe,
  Wallet,
  Receipt,
  Shield,
  LogOut,
  Users,
  Ticket,
  ScrollText,
  Network,
} from "lucide-react";
import NotificationBell from "./notification-bell";

interface SidebarProps {
  email: string;
  isAdmin: boolean;
  balanceBaht: string;
  variant?: "customer" | "admin";
}

const CUSTOMER_NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/tunnels", label: "Tunnels", icon: Cable },
  { href: "/dashboard/ips", label: "Public IPs", icon: Globe },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet },
  { href: "/dashboard/billing", label: "Billing", icon: Receipt },
];

const ADMIN_NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/codes", label: "Codes", icon: Ticket },
  { href: "/admin/ips", label: "IP Pools", icon: Network },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
];

const fmtBaht = (satang: number) =>
  `฿ ${(satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Sidebar({ email, isAdmin, balanceBaht, variant = "customer" }: SidebarProps) {
  const pathname = usePathname();
  const items = variant === "admin" ? ADMIN_NAV : CUSTOMER_NAV;
  const isActive = (href: string) =>
    href === pathname || (href !== "/dashboard" && href !== "/admin" && pathname.startsWith(href));

  // The balance prop is server-rendered at navigation; refetch it live so it
  // reflects buys/top-ups without a full page refresh (panels fire data-changed).
  const [balance, setBalance] = useState(balanceBaht);
  useEffect(() => setBalance(balanceBaht), [balanceBaht]);
  useEffect(() => {
    if (variant !== "customer") return;
    const refetch = async () => {
      try {
        const r = await fetch("/v1/wallet", { credentials: "same-origin" });
        if (r.ok) {
          const d = await r.json();
          if (typeof d?.balanceSatang === "number") setBalance(fmtBaht(d.balanceSatang));
        }
      } catch { /* keep last value */ }
    };
    return onDataChanged(refetch);
  }, [variant]);

  return (
    <aside
      style={{
        width: 240, flexShrink: 0,
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
        display: "flex", flexDirection: "column",
        position: "sticky", top: 0, height: "100vh",
      }}>
      {/* Brand */}
      <div style={{ padding: "20px 16px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: "var(--color-primary)",
          display: "grid", placeItems: "center",
          color: "#fff", fontWeight: 700, fontSize: 14,
        }}>V</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.2 }}>VPN Hub</div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {variant === "admin" ? "Admin console" : "Customer portal"}
          </div>
        </div>
        <NotificationBell />
      </div>

      {/* Wallet pill */}
      {variant === "customer" && (
        <Link href="/dashboard/wallet"
          style={{
            margin: "0 12px 12px", padding: "10px 12px",
            border: "1px solid var(--color-border)", borderRadius: 10,
            background: "var(--color-bg)", textDecoration: "none",
            color: "var(--color-text)",
          }}>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Wallet balance</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2, fontFamily: "var(--font-mono)" }}>
            {balance}
          </div>
        </Link>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="nav-section-label" style={{ marginTop: 0 }}>
          {variant === "admin" ? "Manage" : "Account"}
        </div>
        {items.map((it) => {
          const active = isActive(it.href);
          const Icon = it.icon;
          return (
            <Link key={it.href} href={it.href}
              className={active ? "nav-item nav-item-active" : "nav-item"}>
              <Icon size={16} strokeWidth={2} />
              {it.label}
            </Link>
          );
        })}

        {/* Cross-link */}
        {variant === "customer" && isAdmin && (
          <>
            <div className="nav-section-label">
              Admin
            </div>
            <Link href="/admin" className="nav-item">
              <Shield size={16} strokeWidth={2} />
              Admin console
            </Link>
          </>
        )}
        {variant === "admin" && (
          <>
            <div className="nav-section-label">
              Switch
            </div>
            <Link href="/dashboard" className="nav-item">
              <Cable size={16} strokeWidth={2} />
              Customer portal
            </Link>
          </>
        )}
      </nav>

      {/* User footer */}
      <div style={{ padding: 12, borderTop: "1px solid var(--color-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: "var(--color-surface-2)",
            display: "grid", placeItems: "center",
            color: "var(--color-text-muted)", fontWeight: 600, fontSize: 13,
          }}>{email.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {email}
            </div>
            {isAdmin && <div style={{ fontSize: 10, color: "var(--color-warning)" }}>admin</div>}
          </div>
          <a href="/api/auth/logout" title="Sign out"
            className="btn btn-ghost btn-sm" style={{ padding: 6 }}>
            <LogOut size={14} />
          </a>
        </div>
      </div>
    </aside>
  );
}

// Re-exports so pages can also use these icons in headers.
export { Cable, Globe, Wallet, Receipt };
