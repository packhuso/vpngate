// Worker-side GRE health check + DNS re-resolve. Called every 60s from
// worker-internal. For each active GRE tunnel:
//
//  1. Ask the gateway agent to ping the customer's tunnel-side IP.
//  2. On success → reset fail counter.
//  3. On fail   → increment. At 3 consecutive fails → resolveGreEndpoint()
//     which re-resolves the domain and patches the agent's `remote` if the
//     IP changed. Reset counter regardless (either DNS moved us to a new IP
//     which needs its own 3-fail clock, or DNS is stable and there's no
//     more auto-heal we can do — customer-side issue).
//
// State (per-tunnel fail counter) is in-memory. A worker restart resets
// every counter to 0 — no harm, just costs 3 minutes of extra silence
// before the next auto-reresolve would kick in.
import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "./gateway-client";
import { resolveGreEndpoint, peerIdFromTunnelId } from "./gre";

const FAIL_THRESHOLD = 3;

const consecutiveFails = new Map<string, number>();

export interface GreMonitorResult {
  checked: number;
  reachable: number;
  unreachable: number;
  reresolves: number;
  ipChanges: number;
  errors: string[];
}

export async function monitorGreTunnels(): Promise<GreMonitorResult> {
  const res: GreMonitorResult = {
    checked: 0, reachable: 0, unreachable: 0,
    reresolves: 0, ipChanges: 0, errors: [],
  };

  const rows = await sql<
    {
      id: string;
      gw_end: string;                // our end of the /30 (used to compute customer end)
      agent_endpoint: string;
      agent_ca_cert: string;
      agent_token: string;
    }[]
  >`
    SELECT t.id::text, host(t.private_ip) AS gw_end,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.protocol = 'gre' AND t.deleted_at IS NULL
      AND t.status = 'active' AND g.status = 'active'`;
  if (rows.length === 0) return res;

  // Track active IDs so we can drop stale counters when tunnels are deleted.
  const activeIds = new Set(rows.map((r) => r.id));
  for (const id of consecutiveFails.keys()) {
    if (!activeIds.has(id)) consecutiveFails.delete(id);
  }

  for (const t of rows) {
    res.checked++;
    // customer end = gwEnd + 1 (odd/even pattern from the /30 allocator)
    const gwEndInt = ipToInt(t.gw_end);
    const custEnd = intToIp(gwEndInt + 1);
    const client = buildGatewayClient(t);
    let reachable = false;
    try {
      const r = await client.pingPeer(custEnd, 3);
      reachable = r.received > 0;
    } catch (e) {
      res.errors.push(`ping ${t.id.slice(0, 8)}: ${(e as Error).message}`);
    }
    if (reachable) {
      res.reachable++;
      consecutiveFails.delete(t.id);
      // Stamp handshake — used by tunnels.service.listForUser to derive online
      // status for GRE tunnels (which have no connection-event reporter).
      await sql`UPDATE tunnels SET last_handshake_at = NOW() WHERE id = ${t.id}`;
      continue;
    }
    res.unreachable++;
    const fails = (consecutiveFails.get(t.id) ?? 0) + 1;
    consecutiveFails.set(t.id, fails);
    if (fails < FAIL_THRESHOLD) continue;

    // Threshold hit — try DNS re-resolve, then reset the counter regardless.
    res.reresolves++;
    consecutiveFails.set(t.id, 0);
    try {
      const rr = await resolveGreEndpoint(t.id);
      if (rr.changed) res.ipChanges++;
    } catch (e) {
      res.errors.push(`reresolve ${t.id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  return res;
}

/** Proactive DNS re-resolve for tunnels whose cache is old — runs less often
 *  than monitorGreTunnels, catches DNS moves that happened while the tunnel
 *  was UP (rare but real: customer changed DDNS provider). */
export async function refreshStaleGreEndpoints(maxAgeMinutes = 60): Promise<{
  refreshed: number;
  changed: number;
  errors: string[];
}> {
  const out = { refreshed: 0, changed: 0, errors: [] as string[] };
  const rows = await sql<{ id: string }[]>`
    SELECT id::text FROM tunnels
    WHERE protocol = 'gre' AND deleted_at IS NULL AND status = 'active'
      AND (remote_endpoint_resolved_at IS NULL
           OR remote_endpoint_resolved_at < NOW() - (${maxAgeMinutes}::text || ' minutes')::interval)
    LIMIT 200`;
  for (const t of rows) {
    out.refreshed++;
    try {
      const r = await resolveGreEndpoint(t.id);
      if (r.changed) out.changed++;
    } catch (e) {
      out.errors.push(`${t.id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  return out;
}

// Local helpers — duplicated tiny arithmetic to avoid cross-file coupling.
function ipToInt(ip: string): number {
  const o = ip.split(".").map(Number);
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// Kept unused for now — reserved for a future admin action.
export function _peerIdForTunnel(tunnelId: string): string {
  return peerIdFromTunnelId(tunnelId);
}
