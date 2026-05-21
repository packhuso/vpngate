import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { authConfig, resolveSession } from "@vpnhub/auth";
import Sidebar from "../_components/sidebar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(authConfig.cookieName)?.value;
  const sess = await resolveSession(token);
  if (!sess) redirect("/");
  if (!sess.isAdmin) redirect("/dashboard");

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar email={sess.email} isAdmin={sess.isAdmin} balanceBaht="" variant="admin" />
      <main style={{ flex: 1, padding: "32px 40px", maxWidth: 1400, width: "100%" }}>
        {children}
      </main>
    </div>
  );
}
