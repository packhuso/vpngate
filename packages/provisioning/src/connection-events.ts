// Connection events (connect/disconnect/ip_change) pushed by the gateways.
// Stored centrally for the admin connection-history view (migration 0012).
// Kept bounded by debounce-on-write + a 90-day retention prune.
import { sql } from "@vpnhub/db";

export type ConnEventType = "connect" | "disconnect" | "ip_change";

export interface IngestEvent {
  protocol: string; // wireguard | openvpn | sstp
  peerKey: string; // WG pubkey / OpenVPN CN / SSTP raw key — maps to tunnels.wg_public_key
  event: ConnEventType;
  clientIp?: string | null;
  detail?: string | null;
  ts?: string | null; // ISO; defaults to now()
}

const DEBOUNCE_SECONDS = 30; // ignore an identical event for the same tunnel within this window

// Mirror the gateway agent's sanitizeCN (openvpn.go): OpenVPN/SSTP CNs are a
// lossy-sanitized form of wg_public_key (e.g. "+"/"=" → "_"), so a peerKey that
// is a CN won't match wg_public_key directly — reverse-match against this.
function sanitizeCN(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Resolve a peer key (raw wg_public_key OR a sanitized CN) to a tunnel id. */
async function mapPeerToTunnel(protocol: string, peerKey: string): Promise<string | null> {
  const [direct] = await sql<{ id: string }[]>`
    SELECT id FROM tunnels WHERE wg_public_key = ${peerKey} AND deleted_at IS NULL LIMIT 1`;
  if (direct?.id) return direct.id;
  // fallback: the peerKey is a sanitized CN → compare sanitize(wg_public_key)
  const cands = await sql<{ id: string; wg_public_key: string }[]>`
    SELECT id, wg_public_key FROM tunnels
    WHERE protocol = ${protocol} AND deleted_at IS NULL`;
  return cands.find((c) => sanitizeCN(c.wg_public_key) === peerKey)?.id ?? null;
}

/** Record a batch of events: map peerKey→tunnel, debounce repeats, insert.
 *  Returns how many were stored vs skipped. Never throws on a single bad row. */
export async function recordConnectionEvents(
  events: IngestEvent[],
): Promise<{ stored: number; skipped: number }> {
  let stored = 0;
  let skipped = 0;
  for (const e of events) {
    if (!e?.protocol || !e?.peerKey || !e?.event) {
      skipped++;
      continue;
    }
    try {
      const tunnelId = await mapPeerToTunnel(e.protocol, e.peerKey);
      // Debounce: skip an identical (tunnel, event) within the window — stops a
      // flapping client from spamming rows.
      if (tunnelId) {
        const [recent] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM connection_events
          WHERE tunnel_id = ${tunnelId} AND event = ${e.event}
            AND created_at > now() - ${`${DEBOUNCE_SECONDS} seconds`}::interval`;
        if (Number(recent?.n ?? 0) > 0) {
          skipped++;
          continue;
        }
      }
      const ts = e.ts ? new Date(e.ts) : new Date();
      await sql`
        INSERT INTO connection_events (tunnel_id, protocol, event, client_ip, detail, created_at)
        VALUES (${tunnelId}, ${e.protocol}, ${e.event},
          ${e.clientIp ? sql`${e.clientIp}::inet` : null}, ${e.detail ?? null}, ${ts.toISOString()})`;
      stored++;
    } catch {
      skipped++;
    }
  }
  return { stored, skipped };
}

export interface ConnEventRow {
  id: string;
  protocol: string;
  event: string;
  clientIp: string | null;
  detail: string | null;
  createdAt: Date;
}

/** Recent connection events for one tunnel (admin view). */
export async function getConnectionEvents(
  tunnelId: string,
  limit = 50,
): Promise<ConnEventRow[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const rows = await sql<
    { id: string; protocol: string; event: string; client_ip: string | null; detail: string | null; created_at: Date }[]
  >`
    SELECT id, protocol, event, host(client_ip) AS client_ip, detail, created_at
    FROM connection_events
    WHERE tunnel_id = ${tunnelId}
    ORDER BY created_at DESC LIMIT ${lim}`;
  return rows.map((r) => ({
    id: r.id, protocol: r.protocol, event: r.event,
    clientIp: r.client_ip, detail: r.detail, createdAt: r.created_at,
  }));
}

/** Retention prune — delete events older than `days` (default 90). */
export async function pruneConnectionEvents(days = 90): Promise<number> {
  const r = await sql`
    DELETE FROM connection_events WHERE created_at < now() - ${`${days} days`}::interval`;
  return r.count ?? 0;
}
