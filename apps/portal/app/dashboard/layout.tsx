import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { authConfig, resolveSession } from "@vpnhub/auth";
import { sql } from "@vpnhub/db";
import Sidebar from "../_components/sidebar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fmt = (s: number) =>
  `฿ ${(s / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(authConfig.cookieName)?.value;
  const sess = await resolveSession(token);
  if (!sess) redirect("/");

  const [w] = await sql<{ balance_satang: string }[]>`
    SELECT balance_satang FROM credit_wallets WHERE user_id = ${sess.userId}`;
  const balanceBaht = fmt(Number(w?.balance_satang ?? 0));

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar email={sess.email} isAdmin={sess.isAdmin} balanceBaht={balanceBaht} variant="customer" />
      <main style={{ flex: 1, padding: "32px 40px", maxWidth: 1280, width: "100%" }}>
        {children}
      </main>
    </div>
  );
}
