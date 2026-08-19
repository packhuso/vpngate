// Periodic sampler: pulls per-peer cumulative counters from each active
// gateway agent, computes deltas against the last observed values, and
// writes one row per (tunnel, 5-min bucket) into bandwidth_usage.
//
// Delta semantics: current-cumulative minus last-cumulative. If negative
// (WG counter reset on peer re-add / gateway reboot), we treat CURRENT as
// the delta — under-counts a bit at the boundary but never spikes.
//
// Idempotent per bucket: ON CONFLICT DO NOTHING on (tunnel_id, bucket_start)
// so a mid-tick worker restart can't double-count. The scratch table
// (tunnel_stats_last) is what makes deltas survive worker restarts.
import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "./gateway-client";
import { peerIdFromTunnelId } from "./gre";

const BUCKET_MS = 5 * 60 * 1000;
const RETENTION_DAYS = 90;

export interface SampleResult {
  tunnels: number;
  inserted: number;
  gatewaysOk: number;
  gatewaysFailed: number;
  errors: string[];
}

/** Floor a Date to the current 5-min bucket boundary (UTC). */
function bucketOf(now: Date): string {
  return new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS).toISOString();
}

export async function sampleAllGateways(now: Date = new Date()): Promise<SampleResult> {
  const bucket = bucketOf(now);
  const nowIso = now.toISOString();
  const res: SampleResult = { tunnels: 0, inserted: 0, gatewaysOk: 0, gatewaysFailed: 0, errors: [] };

  const gateways = await sql<{
    id: string; hostname: string;
    agent_endpoint: string; agent_ca_cert: string; agent_token: string;
    supported_protocols: string[];
  }[]>`SELECT id, hostname, agent_endpoint, agent_ca_cert, agent_token,
              supported_protocols
       FROM vpn_gateways WHERE status = 'active'`;

  for (const gw of gateways) {
    const supports = gw.supported_protocols ?? ["wireguard"];
    const client = buildGatewayClient(gw);
    // Build a (tunnelId → {rx,tx}) map by unioning WG + GRE samples per gateway.
    // Same downstream delta/insert code handles both, keyed by tunnel_id.
    const samples: { tunnelId: string; rx: number; tx: number }[] = [];
    let gwOk = false;

    if (supports.includes("wireguard")) {
      try {
        const st = await client.getPeerStats();
        const tunnels = await sql<{ id: string; wg_public_key: string }[]>`
          SELECT id, wg_public_key FROM tunnels
          WHERE gateway_id = ${gw.id} AND deleted_at IS NULL
            AND protocol = 'wireguard' AND wg_public_key IS NOT NULL`;
        const byPk = new Map(tunnels.map((t) => [t.wg_public_key, t.id]));
        for (const p of st.peers) {
          const id = byPk.get(p.publicKey);
          if (id) samples.push({ tunnelId: id, rx: p.bytesRx, tx: p.bytesTx });
        }
        gwOk = true;
      } catch (e) {
        res.errors.push(`${gw.hostname} wg-stats: ${(e as Error).message}`);
      }
    }

    if (supports.includes("gre")) {
      try {
        const st = await client.listGrePeers();
        // Kernel counter conventions on a GRE interface:
        //   bytesRx = bytes RECEIVED into the tunnel from the customer
        //             (customer→gateway, i.e. their UPLOAD).
        //   bytesTx = bytes SENT out of the tunnel toward the customer
        //             (their DOWNLOAD).
        // Match the WG mapping (rx = customer upload, tx = customer download)
        // so the portal chart labels stay consistent.
        const gres = await sql<{ id: string }[]>`
          SELECT id::text FROM tunnels
          WHERE gateway_id = ${gw.id} AND deleted_at IS NULL
            AND protocol = 'gre'`;
        const byPeerId = new Map(gres.map((t) => [peerIdFromTunnelId(t.id), t.id]));
        for (const p of st.peers) {
          const id = byPeerId.get(p.peerId);
          if (id) samples.push({ tunnelId: id, rx: p.bytesRx, tx: p.bytesTx });
        }
        gwOk = true;
      } catch (e) {
        res.errors.push(`${gw.hostname} gre-stats: ${(e as Error).message}`);
      }
    }

    if (gwOk) res.gatewaysOk++;
    else { res.gatewaysFailed++; continue; }

    for (const s of samples) {
      res.tunnels++;

      const [prev] = await sql<{ last_bytes_rx: string; last_bytes_tx: string }[]>`
        SELECT last_bytes_rx::text, last_bytes_tx::text
        FROM tunnel_stats_last WHERE tunnel_id = ${s.tunnelId}`;

      // Always seed/refresh the scratch so the NEXT tick has a baseline.
      await sql`
        INSERT INTO tunnel_stats_last (tunnel_id, last_bytes_rx, last_bytes_tx, last_ts)
        VALUES (${s.tunnelId}, ${s.rx}, ${s.tx}, ${nowIso})
        ON CONFLICT (tunnel_id) DO UPDATE SET
          last_bytes_rx = EXCLUDED.last_bytes_rx,
          last_bytes_tx = EXCLUDED.last_bytes_tx,
          last_ts = EXCLUDED.last_ts`;

      // No prior sample → skip insert (would show cumulative-since-boot as a
      // giant fake spike on the chart). Next tick produces a real one.
      if (!prev) continue;

      const prevRx = Number(prev.last_bytes_rx);
      const prevTx = Number(prev.last_bytes_tx);
      // Negative delta (counter reset on peer re-add / gateway reboot) → treat
      // current as delta. May under-count once at the boundary, never spikes.
      const dRx = s.rx >= prevRx ? s.rx - prevRx : s.rx;
      const dTx = s.tx >= prevTx ? s.tx - prevTx : s.tx;

      if (dRx === 0 && dTx === 0) continue;
      const ins = await sql`
        INSERT INTO bandwidth_usage (tunnel_id, bucket_start, rx_bytes, tx_bytes)
        VALUES (${s.tunnelId}, ${bucket}, ${dRx}, ${dTx})
        ON CONFLICT (tunnel_id, bucket_start) DO UPDATE SET
          rx_bytes = bandwidth_usage.rx_bytes + EXCLUDED.rx_bytes,
          tx_bytes = bandwidth_usage.tx_bytes + EXCLUDED.tx_bytes`;
      res.inserted += ins.count ?? 0;
    }
  }

  return res;
}

/** Delete samples older than N days. Cheap; the ts index covers this. */
export async function pruneTrafficSamples(days = RETENTION_DAYS): Promise<number> {
  const r = await sql`
    DELETE FROM bandwidth_usage
    WHERE bucket_start < NOW() - ${`${days} days`}::interval`;
  return r.count ?? 0;
}
