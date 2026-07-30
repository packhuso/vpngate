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
  }[]>`SELECT id, hostname, agent_endpoint, agent_ca_cert, agent_token
       FROM vpn_gateways WHERE status = 'active'`;

  for (const gw of gateways) {
    let stats;
    try {
      stats = await buildGatewayClient(gw).getPeerStats();
      res.gatewaysOk++;
    } catch (e) {
      res.gatewaysFailed++;
      res.errors.push(`${gw.hostname}: ${(e as Error).message}`);
      continue;
    }

    // Map peer pubkey → tunnel id for THIS gateway's active tunnels.
    const tunnels = await sql<{ id: string; wg_public_key: string }[]>`
      SELECT id, wg_public_key FROM tunnels
      WHERE gateway_id = ${gw.id} AND deleted_at IS NULL`;
    const byPk = new Map(tunnels.map((t) => [t.wg_public_key, t.id]));

    for (const p of stats.peers) {
      const tunnelId = byPk.get(p.publicKey);
      if (!tunnelId) continue;
      res.tunnels++;

      // Delta against last observed cumulative. Negative delta (reset) →
      // treat current as delta (may under-count a bit, never spike).
      const [prev] = await sql<{ last_bytes_rx: string; last_bytes_tx: string }[]>`
        SELECT last_bytes_rx::text, last_bytes_tx::text
        FROM tunnel_stats_last WHERE tunnel_id = ${tunnelId}`;

      // Always seed/refresh the scratch so the NEXT tick has a baseline.
      await sql`
        INSERT INTO tunnel_stats_last (tunnel_id, last_bytes_rx, last_bytes_tx, last_ts)
        VALUES (${tunnelId}, ${p.bytesRx}, ${p.bytesTx}, ${nowIso})
        ON CONFLICT (tunnel_id) DO UPDATE SET
          last_bytes_rx = EXCLUDED.last_bytes_rx,
          last_bytes_tx = EXCLUDED.last_bytes_tx,
          last_ts = EXCLUDED.last_ts`;

      // No prior sample → we can't compute a true delta. Skip inserting a
      // bandwidth_usage row (would otherwise show cumulative-since-boot as
      // a giant fake spike on the chart). Next tick will produce a real one.
      if (!prev) continue;

      const prevRx = Number(prev.last_bytes_rx);
      const prevTx = Number(prev.last_bytes_tx);
      const dRx = p.bytesRx >= prevRx ? p.bytesRx - prevRx : p.bytesRx;
      const dTx = p.bytesTx >= prevTx ? p.bytesTx - prevTx : p.bytesTx;

      if (dRx === 0 && dTx === 0) continue;
      const ins = await sql`
        INSERT INTO bandwidth_usage (tunnel_id, bucket_start, rx_bytes, tx_bytes)
        VALUES (${tunnelId}, ${bucket}, ${dRx}, ${dTx})
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
