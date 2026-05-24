import { cookies } from "next/headers";
import { fmtDate } from "../../../_lib/datetime";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { ArrowLeft, FileDown, Smartphone, Globe } from "lucide-react";
import { authConfig, resolveSession } from "@vpnhub/auth";
import { sql } from "@vpnhub/db";
import { decryptSecret } from "@vpnhub/shared";
import TunnelActions from "./actions-client";
import SstpCreds from "./sstp-creds-client";
import ConnInfo from "./copy-field-client";

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
      description: string | null;
      status: string;
      protocol: string;
      private_ip: string;
      wg_private_key_encrypted: string;
      gw_pub: string | null;
      wg_endpoint: string | null;
      wg_port: number | null;
      private_subnet: string;
      ovpn_endpoint: string | null;
      ovpn_port: number | null;
      sstp_endpoint: string | null;
      ovpn_client_cert: string | null;
      ovpn_client_key_encrypted: string | null;
      config_blob: string | null;
      created_at: Date;
      next_billing_at: Date;
    }[]
  >`
    SELECT t.name, t.description, t.status, t.protocol, host(t.private_ip) AS private_ip,
           t.wg_private_key_encrypted, g.wg_public_key AS gw_pub,
           g.wg_endpoint, g.wg_port, g.private_subnet::text AS private_subnet,
           g.ovpn_endpoint, g.ovpn_port, g.sstp_endpoint,
           t.ovpn_client_cert, t.ovpn_client_key_encrypted, t.config_blob,
           t.created_at, t.next_billing_at
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${id} AND t.user_id = ${sess.userId}
      AND t.deleted_at IS NULL`;
  if (!t) notFound();

  const pubIps = await sql<{ ip: string; block_id: string | null }[]>`
    SELECT host(ip_address) AS ip, block_id::text AS block_id FROM public_ips
    WHERE tunnel_id = ${id} AND status = 'allocated'
    ORDER BY ip_address`;
  // Sold blocks route as their CIDR (e.g. a /25), not N separate /32s.
  const blockCidrs = (
    await sql<{ cidr: string }[]>`
      SELECT DISTINCT b.block::text AS cidr
      FROM ip_blocks b JOIN public_ips p ON p.block_id = b.id
      WHERE p.tunnel_id = ${id} AND p.status = 'allocated'
      ORDER BY 1`
  ).map((r) => r.cidr);
  const singleIps = pubIps.filter((p) => !p.block_id).map((p) => p.ip);
  // Routable prefixes shown in the config + the IP list (singles/32 + blocks).
  const routableCidrs = [...singleIps.map((ip) => `${ip}/32`), ...blockCidrs];

  // Live online status from the latest connection event (connect/ip_change=online).
  const [lastEv] = await sql<{ event: string; created_at: Date }[]>`
    SELECT event, created_at FROM connection_events
    WHERE tunnel_id = ${id} ORDER BY created_at DESC LIMIT 1`;
  const isOnline = lastEv ? lastEv.event !== "disconnect" : false;

  const others = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM tunnels
    WHERE user_id = ${sess.userId} AND id <> ${id}
      AND deleted_at IS NULL AND status = 'active'
    ORDER BY name`;

  const statusBadge = t.status === "active" ? "badge-success"
    : t.status === "provisioning" ? "badge-warning"
    : t.status === "suspended" ? "badge-danger" : "badge-neutral";

  const proto = t.protocol;
  const protoMeta =
    proto === "openvpn" ? { label: "OpenVPN", badge: "badge-info" }
    : proto === "sstp" ? { label: "SSTP", badge: "badge-warning" }
    : { label: "WireGuard", badge: "badge-primary" };

  // WireGuard config + QR (only for WG tunnels; gw_pub is null for OVPN/SSTP).
  let wgConf: string | null = null;
  let qrDataUrl: string | null = null;
  if (proto === "wireguard" && t.gw_pub) {
    const allowedIPs = [t.private_subnet, ...routableCidrs].join(", ");
    const privateKey = decryptSecret(t.wg_private_key_encrypted);
    wgConf =
      `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${t.private_ip}/32\n\n` +
      `[Peer]\nPublicKey = ${t.gw_pub}\nEndpoint = ${t.wg_endpoint}:${t.wg_port}\n` +
      `AllowedIPs = ${allowedIPs}\nPersistentKeepalive = 25\n`;
    // A WG config with many public IPs (e.g. a /24 block) can exceed the QR
    // capacity — that's fine, just skip the QR (the .conf download + raw view
    // still work). Don't let it crash the whole page.
    try {
      qrDataUrl = await QRCode.toDataURL(wgConf, {
        margin: 1, scale: 6, color: { dark: "#0f172a", light: "#ffffff" },
      });
    } catch {
      qrDataUrl = null;
    }
  }

  // OpenVPN raw .ovpn — assembled from the cached creds (no agent call). Only
  // available once the .ovpn has been downloaded at least once (creds cached).
  let ovpnConf: string | null = null;
  if (proto === "openvpn" && t.ovpn_client_cert && t.ovpn_client_key_encrypted && t.config_blob) {
    try {
      const node = JSON.parse(t.config_blob) as { ca: string };
      const host = String(t.ovpn_endpoint).split(":")[0];
      const clientKey = decryptSecret(t.ovpn_client_key_encrypted);
      ovpnConf =
        `client\ndev tun\nproto udp\nremote ${host} ${t.ovpn_port ?? 1194}\n` +
        `resolv-retry infinite\nnobind\npersist-key\npersist-tun\n` +
        `remote-cert-tls server\ncipher AES-256-GCM\n` +
        `data-ciphers AES-256-GCM:CHACHA20-POLY1305\nauth SHA256\nverb 3\nmssfix 1400\n\n` +
        `<ca>\n${node.ca.trim()}\n</ca>\n` +
        `<cert>\n${t.ovpn_client_cert.trim()}\n</cert>\n` +
        `<key>\n${clientKey.trim()}\n</key>\n`;
    } catch { /* malformed cache → no raw view */ }
  }

  // SSTP credentials (shown so the user can configure manually too).
  const sstpUser = proto === "sstp" ? t.ovpn_client_cert : null;
  const sstpPass =
    proto === "sstp" && t.ovpn_client_key_encrypted
      ? decryptSecret(t.ovpn_client_key_encrypted)
      : null;

  const endpoint =
    proto === "openvpn" ? `${t.ovpn_endpoint} (UDP 1194)`
    : proto === "sstp" ? `${t.sstp_endpoint} (TCP 443)`
    : t.wg_endpoint ? `${t.wg_endpoint}:${t.wg_port}` : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--color-primary)", textDecoration: "none", marginBottom: 12 }}>
          <ArrowLeft size={14} strokeWidth={2} /> Dashboard
        </Link>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h1 className="page-title">{t.name}</h1>
          <span className={`badge ${protoMeta.badge}`}>{protoMeta.label}</span>
          <span className={`badge ${statusBadge}`}>{t.status}</span>
          <span className={`badge ${isOnline ? "badge-success" : "badge-neutral"}`}>
            {isOnline ? "● Online" : "○ Offline"}
          </span>
        </div>
        {t.description && (
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 4 }}>{t.description}</p>
        )}
        <p className="page-subtitle mono" style={{ fontSize: 12 }}>
          {id} · private {t.private_ip} · {endpoint} · next billing {fmtDate(t.next_billing_at)}
        </p>
      </div>

      {/* Config + downloads (per protocol) */}
      <div className="card">
        <h2 className="section-title">Client config</h2>
        <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 2 }}>
          {proto === "wireguard" && "ดาวน์โหลด .conf หรือสแกน QR ด้วย WireGuard mobile app · หรือใช้ Mikrotik script"}
          {proto === "openvpn" && "ดาวน์โหลด .ovpn เข้า OpenVPN client (มือถือ/คอม) · Mikrotik ใช้ .rsc (อัปโหลดไฟล์ .ovpn ก่อน import)"}
          {proto === "sstp" && "SSTP วิ่งบน TLS:443 (ผ่าน firewall เข้มได้) · Mikrotik ใช้ .rsc · หรือกรอก user/pass ด้านล่างเอง"}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: qrDataUrl ? "auto 1fr" : "1fr", gap: 24, marginTop: 16, alignItems: "start" }}>
          {qrDataUrl && (
            <div style={{ background: "var(--color-bg)", padding: 8, borderRadius: 10, border: "1px solid var(--color-border)" }}>
              <img src={qrDataUrl} alt="WireGuard config QR" style={{ width: 240, height: 240, display: "block", borderRadius: 6 }} />
              <p style={{ fontSize: 11, color: "var(--color-text-muted)", textAlign: "center", marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                <Smartphone size={12} strokeWidth={2} /> Scan with WireGuard app
              </p>
            </div>
          )}
          <div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {proto === "wireguard" && (
                <>
                  <a href={`/v1/tunnels/${id}/config`} download={`${t.name}.conf`} className="btn btn-primary">
                    <FileDown size={16} /> Download .conf
                  </a>
                  <a href={`/v1/tunnels/${id}/config?format=mikrotik`} download={`${t.name}.mikrotik.rsc`} className="btn btn-secondary">
                    <FileDown size={16} /> Mikrotik script
                  </a>
                </>
              )}
              {proto === "openvpn" && (
                <>
                  <a href={`/v1/tunnels/${id}/config?format=ovpn`} download={`${t.name}.ovpn`} className="btn btn-primary">
                    <FileDown size={16} /> Download .ovpn
                  </a>
                  <a href={`/v1/tunnels/${id}/config?format=mikrotik`} download={`${t.name}.ovpn.rsc`} className="btn btn-secondary">
                    <FileDown size={16} /> Mikrotik script
                  </a>
                </>
              )}
              {proto === "sstp" && (
                <a href={`/v1/tunnels/${id}/config?format=sstp`} download={`${t.name}.sstp.rsc`} className="btn btn-primary">
                  <FileDown size={16} /> Mikrotik script (.rsc)
                </a>
              )}
            </div>

            {proto === "wireguard" && t.wg_endpoint && (
              <ConnInfo server={String(t.wg_endpoint)} port={`${t.wg_port ?? 51820}`} />
            )}
            {proto === "openvpn" && (
              <ConnInfo server={String(t.ovpn_endpoint)} port={`${t.ovpn_port ?? 1194}`} />
            )}
            {proto === "sstp" && (
              <SstpCreds tunnelId={id} server={String(t.sstp_endpoint)} port="443" username={sstpUser} password={sstpPass} />
            )}

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
                  {routableCidrs.map((c) => <li key={c} style={{ marginBottom: 2 }}>{c}</li>)}
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

      {(wgConf || ovpnConf) && (
        <div className="card">
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--color-text-muted)" }}>
              Show raw {wgConf ? ".conf" : ".ovpn"} <span style={{ color: "var(--color-danger)" }}>(contains private key)</span>
            </summary>
            <pre className="mono" style={{ marginTop: 12, padding: 12, background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {wgConf ?? ovpnConf}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
