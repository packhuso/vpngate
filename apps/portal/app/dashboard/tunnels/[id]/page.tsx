import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { ArrowLeft, FileDown, Smartphone, Globe } from "lucide-react";
import { authConfig, resolveSession } from "@vpnhub/auth";
import { sql } from "@vpnhub/db";
import { decryptSecret } from "@vpnhub/shared";
import TunnelActions from "./actions-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params { params: Promise<{ id: string }> }

export default async function TunnelDetail({ params }: Params) {
  const { id } = await params;
  const token = (await cookies()).get(authConfig.cookieName)?.value;
  const sess = await resolveSession(token);
  if (!sess) redirect("/");

  const [t] = await sql<
    {
      name: string;
      status: string;
      private_ip: string;
      wg_private_key_encrypted: string;
      gw_pub: string;
      wg_endpoint: string;
      wg_port: number;
      private_subnet: string;
      created_at: Date;
      next_billing_at: Date;
    }[]
  >`
    SELECT t.name, t.status, host(t.private_ip) AS private_ip,
           t.wg_private_key_encrypted, g.wg_public_key AS gw_pub,
           g.wg_endpoint, g.wg_port, g.private_subnet::text AS private_subnet,
           t.created_at, t.next_billing_at
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${id} AND t.user_id = ${sess.userId}
      AND t.deleted_at IS NULL`;
  if (!t) notFound();

  const pubIps = await sql<{ ip: string; block_id: string | null }[]>`
    SELECT host(ip_address) AS ip, block_id::text AS block_id FROM public_ips
    WHERE tunnel_id = ${id} AND status = 'allocated'
    ORDER BY ip_address`;

  const others = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM tunnels
    WHERE user_id = ${sess.userId} AND id <> ${id}
      AND deleted_at IS NULL AND status = 'active'
    ORDER BY name`;

  const allowedIPs = [t.private_subnet, ...pubIps.map((p) => `${p.ip}/32`)].join(", ");
  const privateKey = decryptSecret(t.wg_private_key_encrypted);
  const conf =
    `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${t.private_ip}/32\n\n` +
    `[Peer]\nPublicKey = ${t.gw_pub}\nEndpoint = ${t.wg_endpoint}:${t.wg_port}\n` +
    `AllowedIPs = ${allowedIPs}\nPersistentKeepalive = 25\n`;

  // QR — light-theme friendly colors
  const qrDataUrl = await QRCode.toDataURL(conf, {
    margin: 1, scale: 6,
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  const statusBadge = t.status === "active" ? "badge-success"
    : t.status === "provisioning" ? "badge-warning"
    : t.status === "suspended" ? "badge-danger" : "badge-neutral";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--color-primary)", textDecoration: "none", marginBottom: 12 }}>
          <ArrowLeft size={14} strokeWidth={2} /> Dashboard
        </Link>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h1 className="page-title">{t.name}</h1>
          <span className={`badge ${statusBadge}`}>{t.status}</span>
        </div>
        <p className="page-subtitle mono" style={{ fontSize: 12 }}>
          {id} · private {t.private_ip} · next billing {new Date(t.next_billing_at).toISOString().slice(0, 10)}
        </p>
      </div>

      {/* Config + downloads */}
      <div className="card">
        <h2 className="section-title">Client config</h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          ดาวน์โหลด config สำหรับเครื่อง client หรือสแกน QR ด้วย WireGuard mobile app
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 24, marginTop: 16, alignItems: "start" }}>
          <div style={{ background: "var(--color-bg)", padding: 8, borderRadius: 10, border: "1px solid var(--color-border)" }}>
            <img src={qrDataUrl} alt="WireGuard config QR" style={{ width: 240, height: 240, display: "block", borderRadius: 6 }} />
            <p style={{ fontSize: 11, color: "var(--color-text-muted)", textAlign: "center", marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
              <Smartphone size={12} strokeWidth={2} /> Scan with WireGuard app
            </p>
          </div>
          <div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a href={`/v1/tunnels/${id}/config`} download={`${t.name}.conf`}
                className="btn btn-primary">
                <FileDown size={16} /> Download .conf
              </a>
              <a href={`/v1/tunnels/${id}/config?format=mikrotik`} download={`${t.name}.mikrotik.rsc`}
                className="btn btn-secondary">
                <FileDown size={16} /> Mikrotik script
              </a>
            </div>

            <div className="card-compact" style={{ marginTop: 16, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500 }}>
                <Globe size={14} strokeWidth={2} /> Public IPs <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({pubIps.length})</span>
              </div>
              {pubIps.length === 0 ? (
                <p style={{ color: "var(--color-text-muted)", fontSize: 12, marginTop: 6 }}>
                  No public IPs yet — buy one on the dashboard to expose services to the internet.
                </p>
              ) : (
                <ul className="mono" style={{ fontSize: 12, marginTop: 6, paddingLeft: 18 }}>
                  {pubIps.map((p) => <li key={p.ip} style={{ marginBottom: 2 }}>{p.ip}/32</li>)}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      <TunnelActions
        tunnelId={id}
        tunnelName={t.name}
        publicIps={pubIps.map((p) => ({ ip: p.ip, blockId: p.block_id }))}
        others={others}
      />

      <div className="card">
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--color-text-muted)" }}>
            Show raw .conf <span style={{ color: "var(--color-danger)" }}>(contains private key)</span>
          </summary>
          <pre className="mono" style={{ marginTop: 12, padding: 12, background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {conf}
          </pre>
        </details>
      </div>
    </div>
  );
}
