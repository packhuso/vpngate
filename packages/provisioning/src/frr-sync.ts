// Keep the VPN-POOLS prefix-list on every BGP-enabled gateway in sync with the
// pools table. Without this, a new pool's CIDR would be filtered by FRR's
// route-map ANNOUNCE-POOLS → not advertised → IPs in the pool can be sold and
// assigned but won't actually reach Mikrotik / the upstream → silent breakage.
//
// Source of truth: `ip_pool.block`. One prefix-list entry per pool, of the
// form `permit <pool>/<n> ge <n>` (accept the pool and any more-specific
// allocation within it). Push is atomic per-gateway (one vtysh call); failures
// per gateway are collected and returned so the caller can surface them.
import { sql } from "@vpnhub/db";
import { buildGatewayClient } from "./gateway-client";

export interface FrrSyncFailure {
  gateway: string;
  error: string;
}

export interface FrrSyncResult {
  pushed: number; // gateways that succeeded
  failures: FrrSyncFailure[];
  entries: { prefix: string; ge: number }[];
}

/** Re-push VPN-POOLS to every active bgp_enabled gateway based on current DB
 *  pools. Idempotent and safe to call on any pool create/delete/edit. */
export async function syncPoolPrefixListsAllGateways(): Promise<FrrSyncResult> {
  const pools = await sql<{ block: string }[]>`
    SELECT block::text AS block FROM ip_pool ORDER BY block`;
  const entries = pools.map((p) => {
    const ge = Number(p.block.split("/")[1] ?? "32");
    return { prefix: p.block, ge };
  });

  const gws = await sql<{
    hostname: string;
    agent_endpoint: string;
    agent_ca_cert: string;
    agent_token: string;
  }[]>`
    SELECT hostname, agent_endpoint, agent_ca_cert, agent_token
    FROM vpn_gateways
    WHERE status = 'active' AND bgp_enabled = true`;

  const failures: FrrSyncFailure[] = [];
  let pushed = 0;
  for (const gw of gws) {
    try {
      await buildGatewayClient(gw).syncFrrPrefixList(
        "VPN-POOLS",
        entries,
        `prefix-list-sync-${Date.now()}-${gw.hostname}`,
      );
      pushed++;
    } catch (e) {
      failures.push({ gateway: gw.hostname, error: (e as Error).message });
    }
  }
  return { pushed, failures, entries };
}
