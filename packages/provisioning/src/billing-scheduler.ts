// Billing scheduler (design §7.3) — per-item daily charge with a 3-day
// grace period before auto-cancellation.
//
// Each tunnel / public_ip (/32) / ip_block is billed INDEPENDENTLY on its own
// next_billing_at — items bought on different days don't bundle into one bill.
//
// State machine for a single item:
//   active                       (next_billing_at > NOW)
//     ↓ next_billing_at <= NOW
//   try charge (FOR UPDATE on wallet)
//     ├─ success → advance next_billing_at += 31d, clear suspension
//     └─ insufficient credit → status='suspended',
//                              suspended_at = NOW,
//                              delete_after = NOW + 3d
//   suspended (next_billing_at <= NOW, delete_after pending)
//     ├─ user tops up → next tick re-tries charge → back to active
//     └─ delete_after <= NOW → force-cancel:
//                              tunnel: unassign all attached IPs, soft-delete
//                              ip/block: detach from tunnel, return to pool
import { sql } from "@vpnhub/db";
import {
  chargeIdempotencyKey,
  deleteAfter,
  nextBillingAt,
  type SpeedTier,
} from "@vpnhub/billing";
import { speedTierPrice, ipPrice } from "./pricing";
import { notify } from "./notify";
import { buildGatewayClient } from "./gateway-client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const GRACE_DAYS = 3;
const DAY_MS = 86_400_000;

export interface BillingTickReport {
  tunnels: { charged: number; suspended: number; cancelled: number };
  ips: { charged: number; suspended: number; cancelled: number };
  blocks: { charged: number; suspended: number; cancelled: number };
  errors: { kind: string; id: string; error: string }[];
}

export async function runBillingTick(
  now: Date = new Date(),
): Promise<BillingTickReport> {
  const r: BillingTickReport = {
    tunnels: { charged: 0, suspended: 0, cancelled: 0 },
    ips: { charged: 0, suspended: 0, cancelled: 0 },
    blocks: { charged: 0, suspended: 0, cancelled: 0 },
    errors: [],
  };

  // Phase 1: tunnels charge/suspend
  const dueTunnels: { id: string }[] = await sql`
    SELECT id FROM tunnels
    WHERE deleted_at IS NULL
      AND status IN ('active', 'suspended')
      AND next_billing_at <= ${now.toISOString()}
      AND (delete_after IS NULL OR delete_after > ${now.toISOString()})`;
  for (const t of dueTunnels) {
    try {
      const outcome = await chargeOneTunnel(t.id, now);
      if (outcome === "charged") r.tunnels.charged++;
      else if (outcome === "suspended") r.tunnels.suspended++;
    } catch (e) {
      r.errors.push({ kind: "tunnel", id: t.id, error: (e as Error).message });
    }
  }

  // Phase 2: /32 public_ips charge/suspend (skip block members)
  const dueIps: { ip: string }[] = await sql`
    SELECT host(ip_address) AS ip FROM public_ips
    WHERE status IN ('allocated', 'suspended')
      AND block_id IS NULL
      AND user_id IS NOT NULL
      AND next_billing_at <= ${now.toISOString()}
      AND (delete_after IS NULL OR delete_after > ${now.toISOString()})`;
  for (const row of dueIps) {
    try {
      const outcome = await chargeOnePublicIp(row.ip, now);
      if (outcome === "charged") r.ips.charged++;
      else if (outcome === "suspended") r.ips.suspended++;
    } catch (e) {
      r.errors.push({ kind: "ip", id: row.ip, error: (e as Error).message });
    }
  }

  // Phase 3: ip_blocks charge/suspend
  const dueBlocks: { id: string }[] = await sql`
    SELECT id FROM ip_blocks
    WHERE status IN ('active', 'suspended')
      AND next_billing_at <= ${now.toISOString()}
      AND (delete_after IS NULL OR delete_after > ${now.toISOString()})`;
  for (const b of dueBlocks) {
    try {
      const outcome = await chargeOneIpBlock(b.id, now);
      if (outcome === "charged") r.blocks.charged++;
      else if (outcome === "suspended") r.blocks.suspended++;
    } catch (e) {
      r.errors.push({ kind: "block", id: b.id, error: (e as Error).message });
    }
  }

  // Phase 4: cancel items whose grace has expired
  const expiredTunnels: { id: string }[] = await sql`
    SELECT id FROM tunnels
    WHERE deleted_at IS NULL
      AND delete_after IS NOT NULL
      AND delete_after <= ${now.toISOString()}`;
  for (const t of expiredTunnels) {
    try {
      await forceCancelTunnel(t.id);
      r.tunnels.cancelled++;
    } catch (e) {
      r.errors.push({ kind: "tunnel", id: t.id, error: (e as Error).message });
    }
  }

  const expiredIps: { ip: string; block_id: string | null }[] = await sql`
    SELECT host(ip_address) AS ip, block_id::text AS block_id FROM public_ips
    WHERE status IN ('allocated', 'suspended')
      AND block_id IS NULL
      AND delete_after IS NOT NULL
      AND delete_after <= ${now.toISOString()}`;
  for (const row of expiredIps) {
    try {
      await forceCancelPublicIp(row.ip);
      r.ips.cancelled++;
    } catch (e) {
      r.errors.push({ kind: "ip", id: row.ip, error: (e as Error).message });
    }
  }

  const expiredBlocks: { id: string }[] = await sql`
    SELECT id FROM ip_blocks
    WHERE status IN ('active', 'suspended')
      AND delete_after IS NOT NULL
      AND delete_after <= ${now.toISOString()}`;
  for (const b of expiredBlocks) {
    try {
      await forceCancelIpBlock(b.id);
      r.blocks.cancelled++;
    } catch (e) {
      r.errors.push({ kind: "block", id: b.id, error: (e as Error).message });
    }
  }

  return r;
}

// ─── per-item charge ──────────────────────────────────────────────────

type ChargeOutcome = "charged" | "suspended" | "skipped";

export async function chargeOneTunnel(
  tunnelId: string,
  now: Date = new Date(),
): Promise<ChargeOutcome> {
  return sql.begin(async (tx: Tx) => {
    const tRows: {
      id: string;
      user_id: string;
      name: string;
      speed_tier: SpeedTier;
      status: string;
      next_billing_at: string;
    }[] = await tx`
      SELECT id, user_id, name, speed_tier, status, next_billing_at
      FROM tunnels
      WHERE id = ${tunnelId} AND deleted_at IS NULL FOR UPDATE`;
    const t = tRows[0];
    if (!t) return "skipped";
    let price: number;
    try {
      price = await speedTierPrice(t.speed_tier);
    } catch {
      return "skipped";
    }

    const wRows: { id: string; balance_satang: string }[] = await tx`
      SELECT id, balance_satang FROM credit_wallets
      WHERE user_id = ${t.user_id} FOR UPDATE`;
    const w = wRows[0];
    if (!w) return "skipped";

    if (Number(w.balance_satang) < price) {
      return await suspend(tx, "tunnel", t.id, t.status, now, t.user_id, t.name);
    }

    const newBalance = Number(w.balance_satang) - price;
    const cycleDate = new Date(t.next_billing_at);
    // Idempotency-protected insert first; if no row inserted, this cycle is
    // already charged (worker retry / clock-skew double-tick) → skip wallet drain.
    const inserted: { id: string }[] = await tx`
      INSERT INTO credit_transactions (user_id, wallet_id, type,
        amount_satang, balance_after, description, idempotency_key)
      VALUES (${t.user_id}, ${w.id}, 'subscription_charge',
        ${-price}, ${newBalance},
        ${"Renewal: tunnel " + t.name + " (" + t.speed_tier + ")"},
        ${chargeIdempotencyKey("tunnel", t.id, cycleDate)})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return "skipped";
    await tx`UPDATE credit_wallets
             SET balance_satang = ${newBalance},
                 lifetime_spent_satang = lifetime_spent_satang + ${price},
                 version = version + 1
             WHERE id = ${w.id}`;
    const next = nextBillingAt(cycleDate);
    await tx`UPDATE tunnels
             SET next_billing_at = ${next.toISOString()},
                 last_billed_at = ${now.toISOString()},
                 status = 'active',
                 suspended_at = NULL,
                 delete_after = NULL
             WHERE id = ${t.id}`;
    return "charged";
  });
}

export async function chargeOnePublicIp(
  ip: string,
  now: Date = new Date(),
): Promise<ChargeOutcome> {
  const SINGLE_IP_SATANG = await ipPrice(1); // admin-configurable (migration 0010)
  return sql.begin(async (tx: Tx) => {
    const rows: {
      ip_address: string;
      user_id: string | null;
      status: string;
      next_billing_at: string;
      block_id: string | null;
    }[] = await tx`
      SELECT host(ip_address) AS ip_address, user_id, status,
             next_billing_at, block_id
      FROM public_ips
      WHERE ip_address = ${ip}::inet FOR UPDATE`;
    const r = rows[0];
    if (!r || r.block_id || !r.user_id) return "skipped";

    const wRows: { id: string; balance_satang: string }[] = await tx`
      SELECT id, balance_satang FROM credit_wallets
      WHERE user_id = ${r.user_id} FOR UPDATE`;
    const w = wRows[0];
    if (!w) return "skipped";

    if (Number(w.balance_satang) < SINGLE_IP_SATANG) {
      return await suspendPublicIp(tx, ip, r.status, now, r.user_id ?? undefined);
    }

    const newBalance = Number(w.balance_satang) - SINGLE_IP_SATANG;
    const cycleDate = new Date(r.next_billing_at);
    const inserted: { id: string }[] = await tx`
      INSERT INTO credit_transactions (user_id, wallet_id, type,
        amount_satang, balance_after, description, idempotency_key)
      VALUES (${r.user_id}, ${w.id}, 'ip_charge',
        ${-SINGLE_IP_SATANG}, ${newBalance},
        ${"Renewal: Public IP " + ip},
        ${chargeIdempotencyKey("ip", ip, cycleDate)})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return "skipped";
    await tx`UPDATE credit_wallets
             SET balance_satang = ${newBalance},
                 lifetime_spent_satang = lifetime_spent_satang + ${SINGLE_IP_SATANG},
                 version = version + 1
             WHERE id = ${w.id}`;
    const next = nextBillingAt(cycleDate);
    await tx`UPDATE public_ips
             SET next_billing_at = ${next.toISOString()},
                 last_billed_at = ${now.toISOString()},
                 status = 'allocated',
                 suspended_at = NULL,
                 delete_after = NULL
             WHERE ip_address = ${ip}::inet`;
    return "charged";
  });
}

export async function chargeOneIpBlock(
  blockId: string,
  now: Date = new Date(),
): Promise<ChargeOutcome> {
  return sql.begin(async (tx: Tx) => {
    const bRows: {
      id: string;
      user_id: string;
      status: string;
      block: string;
      block_size: number;
      price_satang: string;
      next_billing_at: string;
    }[] = await tx`
      SELECT id, user_id, status, block::text AS block, block_size,
             price_satang, next_billing_at
      FROM ip_blocks WHERE id = ${blockId} FOR UPDATE`;
    const b = bRows[0];
    if (!b) return "skipped";
    const price = await ipPrice(b.block_size).catch(() => Number(b.price_satang));

    const wRows: { id: string; balance_satang: string }[] = await tx`
      SELECT id, balance_satang FROM credit_wallets
      WHERE user_id = ${b.user_id} FOR UPDATE`;
    const w = wRows[0];
    if (!w) return "skipped";

    if (Number(w.balance_satang) < price) {
      return await suspend(tx, "block", b.id, b.status, now, b.user_id, b.block);
    }

    const newBalance = Number(w.balance_satang) - price;
    const cycleDate = new Date(b.next_billing_at);
    const inserted: { id: string }[] = await tx`
      INSERT INTO credit_transactions (user_id, wallet_id, type,
        amount_satang, balance_after, description, idempotency_key)
      VALUES (${b.user_id}, ${w.id}, 'ip_charge',
        ${-price}, ${newBalance},
        ${"Renewal: IP block " + b.block},
        ${chargeIdempotencyKey("block", b.id, cycleDate)})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return "skipped";
    await tx`UPDATE credit_wallets
             SET balance_satang = ${newBalance},
                 lifetime_spent_satang = lifetime_spent_satang + ${price},
                 version = version + 1
             WHERE id = ${w.id}`;
    const next = nextBillingAt(cycleDate);
    await tx`UPDATE ip_blocks
             SET next_billing_at = ${next.toISOString()},
                 last_billed_at = ${now.toISOString()},
                 status = 'active',
                 suspended_at = NULL,
                 delete_after = NULL
             WHERE id = ${b.id}`;
    return "charged";
  });
}

async function suspend(
  tx: Tx,
  kind: "tunnel" | "block",
  id: string,
  currentStatus: string,
  now: Date,
  userId?: string,
  label?: string,
): Promise<"suspended"> {
  const cutoff = deleteAfter(now);
  if (kind === "tunnel") {
    await tx`UPDATE tunnels
             SET status = 'suspended',
                 suspended_at = COALESCE(suspended_at, ${now.toISOString()}),
                 delete_after = COALESCE(delete_after, ${cutoff.toISOString()})
             WHERE id = ${id}`;
  } else {
    await tx`UPDATE ip_blocks
             SET status = 'suspended',
                 suspended_at = COALESCE(suspended_at, ${now.toISOString()}),
                 delete_after = COALESCE(delete_after, ${cutoff.toISOString()})
             WHERE id = ${id}`;
  }
  await tx`INSERT INTO audit_logs (actor_type, action, resource_type,
             resource_id, success, metadata)
           VALUES ('system', 'billing.suspend',
             ${kind === "tunnel" ? "tunnel" : "ip_block"}, ${id}, true,
             ${JSON.stringify({ previousStatus: currentStatus, deleteAfter: cutoff.toISOString() })}::jsonb)`;
  if (userId) {
    const what = kind === "tunnel" ? `Tunnel "${label}"` : `IP Block ${label}`;
    await notify(tx, userId, {
      type: "billing.suspended",
      severity: "warning",
      title: `${kind === "tunnel" ? "Tunnel" : "IP Block"} ถูกระงับ — เงินไม่พอ`,
      body: `${what} ถูกระงับเพราะเครดิตไม่พอต่ออายุ. เติมเงินก่อน ${cutoff.toISOString().slice(0, 10)} ไม่งั้นจะถูกลบอัตโนมัติ`,
      metadata: { kind, id, deleteAfter: cutoff.toISOString() },
    });
  }
  return "suspended";
}

async function suspendPublicIp(
  tx: Tx,
  ip: string,
  currentStatus: string,
  now: Date,
  userId?: string,
): Promise<"suspended"> {
  const cutoff = deleteAfter(now);
  await tx`UPDATE public_ips
           SET status = 'suspended',
               suspended_at = COALESCE(suspended_at, ${now.toISOString()}),
               delete_after = COALESCE(delete_after, ${cutoff.toISOString()})
           WHERE ip_address = ${ip}::inet`;
  await tx`INSERT INTO audit_logs (actor_type, action, resource_type,
             resource_id, success, metadata)
           VALUES ('system', 'billing.suspend', 'public_ip', NULL, true,
             ${JSON.stringify({ ip, previousStatus: currentStatus, deleteAfter: cutoff.toISOString() })}::jsonb)`;
  if (userId) {
    await notify(tx, userId, {
      type: "billing.suspended",
      severity: "warning",
      title: "Public IP ถูกระงับ — เงินไม่พอ",
      body: `IP ${ip} ถูกระงับเพราะเครดิตไม่พอต่ออายุ. เติมเงินก่อน ${cutoff.toISOString().slice(0, 10)} ไม่งั้นจะถูกลบอัตโนมัติ`,
      metadata: { kind: "ip", ip, deleteAfter: cutoff.toISOString() },
    });
  }
  return "suspended";
}

// ─── forced cancellation (grace expired) ─────────────────────────────

interface GwInfo {
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string;
}

async function loadGw(tx: Tx, tunnelId: string) {
  const rows: ({ gateway_id: string; wg_public_key: string } & GwInfo)[] = await tx`
    SELECT t.gateway_id, t.wg_public_key,
           g.agent_endpoint, g.agent_ca_cert, g.agent_token
    FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
    WHERE t.id = ${tunnelId}`;
  return rows[0] ?? null;
}

async function syncPeerIps(tx: Tx, tunnelId: string, idempotencyTag: string) {
  const rows: { ip: string; private_ip: string; wg_public_key: string }[] = await tx`
    SELECT host(p.ip_address) AS ip,
           host(t.private_ip) AS private_ip,
           t.wg_public_key
    FROM public_ips p
    RIGHT JOIN tunnels t ON t.id = ${tunnelId}
    WHERE (p.tunnel_id = ${tunnelId} AND p.status = 'allocated') OR p.ip_address IS NULL
    ORDER BY p.ip_address`;
  if (rows.length === 0) return;
  const privateIp = rows[0].private_ip;
  const pubKey = rows[0].wg_public_key;
  const ips = rows.filter((r) => r.ip).map((r) => r.ip);
  const gw = await loadGw(tx, tunnelId);
  if (!gw) return;
  await buildGatewayClient(gw).updatePeerIps(pubKey, privateIp, ips, idempotencyTag);
}

export async function forceCancelTunnel(tunnelId: string): Promise<void> {
  const phase = await sql.begin(async (tx: Tx) => {
    const tRows: { id: string; gateway_id: string; wg_public_key: string; user_id: string; name: string }[] = await tx`
      SELECT id, gateway_id, wg_public_key, user_id, name
      FROM tunnels
      WHERE id = ${tunnelId} AND deleted_at IS NULL FOR UPDATE`;
    const t = tRows[0];
    if (!t) return null;

    // Unassign all attached IPs first (they continue to bill on their own)
    const ipRows: { ip: string }[] = await tx`
      SELECT host(ip_address) AS ip FROM public_ips
      WHERE tunnel_id = ${tunnelId} AND status = 'allocated'`;
    if (ipRows.length > 0) {
      await tx`UPDATE public_ips SET tunnel_id = NULL
               WHERE tunnel_id = ${tunnelId}`;
    }

    await tx`UPDATE tunnels SET status = 'deleted', deleted_at = NOW(),
             suspended_at = NULL, delete_after = NULL
             WHERE id = ${tunnelId}`;
    await tx`UPDATE vpn_gateways
             SET current_tunnels = GREATEST(current_tunnels - 1, 0)
             WHERE id = ${t.gateway_id}`;
    await tx`INSERT INTO audit_logs (actor_type, action, resource_type,
               resource_id, success, metadata)
             VALUES ('system', 'billing.cancel', 'tunnel', ${tunnelId}, true,
               ${JSON.stringify({ unassignedIps: ipRows.length })}::jsonb)`;
    await notify(tx, t.user_id, {
      type: "billing.cancelled",
      severity: "error",
      title: "Tunnel ถูกลบ — หมดระยะผ่อนผัน",
      body: `Tunnel "${t.name}" ถูกลบเพราะไม่ได้เติมเงินภายใน 3 วันหลังถูกระงับ. Public IP ที่เคยผูกถูกปลดออก (ยังเป็นของคุณ).`,
      metadata: { kind: "tunnel", id: tunnelId },
    });

    const gwRows: GwInfo[] = await tx`
      SELECT agent_endpoint, agent_ca_cert, agent_token
      FROM vpn_gateways WHERE id = ${t.gateway_id}`;
    return { wgPub: t.wg_public_key, gw: gwRows[0] };
  });

  if (phase) {
    await buildGatewayClient(phase.gw)
      .deletePeer(phase.wgPub, `billing-cancel-${tunnelId}-${Date.now()}`)
      .catch((e) => console.error(`[billing] deletePeer failed for ${tunnelId}:`, e));
  }
}

export async function forceCancelPublicIp(ip: string): Promise<void> {
  const phase = await sql.begin(async (tx: Tx) => {
    const rows: { tunnel_id: string | null; pool_id: string; user_id: string | null }[] = await tx`
      SELECT tunnel_id, pool_id, user_id FROM public_ips
      WHERE ip_address = ${ip}::inet FOR UPDATE`;
    const r = rows[0];
    if (!r) return null;

    const wasTunnel = r.tunnel_id;
    const wasUser = r.user_id;
    if (wasTunnel) {
      await tx`UPDATE public_ips SET tunnel_id = NULL
               WHERE ip_address = ${ip}::inet`;
    }
    await tx`UPDATE public_ips
             SET status = 'available', tunnel_id = NULL, user_id = NULL,
                 released_at = NOW(), next_billing_at = NULL,
                 suspended_at = NULL, delete_after = NULL
             WHERE ip_address = ${ip}::inet`;
    await tx`UPDATE ip_pool
             SET available_count = available_count + 1,
                 allocated_count = GREATEST(allocated_count - 1, 0)
             WHERE id = ${r.pool_id}`;
    await tx`INSERT INTO audit_logs (actor_type, action, resource_type,
               resource_id, success, metadata)
             VALUES ('system', 'billing.cancel', 'public_ip', NULL, true,
               ${JSON.stringify({ ip, wasTunnel })}::jsonb)`;
    if (wasUser) {
      await notify(tx, wasUser, {
        type: "billing.cancelled",
        severity: "error",
        title: "Public IP ถูกลบ — หมดระยะผ่อนผัน",
        body: `IP ${ip} ถูกคืนเข้า pool เพราะไม่ได้เติมเงินภายใน 3 วันหลังถูกระงับ.`,
        metadata: { kind: "ip", ip },
      });
    }
    return { wasTunnel };
  });

  if (phase?.wasTunnel) {
    // push reduced allowed-ips to gateway for the (former) peer
    const gwRows: ({ wg_public_key: string; private_ip: string } & GwInfo)[] = await sql`
      SELECT t.wg_public_key, host(t.private_ip) AS private_ip,
             g.agent_endpoint, g.agent_ca_cert, g.agent_token
      FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
      WHERE t.id = ${phase.wasTunnel} AND t.deleted_at IS NULL`;
    const tg = gwRows[0];
    if (tg) {
      const cidrRows = await sql<{ cidr: string }[]>`
        SELECT host(ip_address) || '/32' AS cidr
        FROM public_ips
        WHERE tunnel_id = ${phase.wasTunnel} AND status = 'allocated' AND block_id IS NULL
        UNION ALL
        SELECT DISTINCT b.block::text AS cidr
        FROM public_ips p JOIN ip_blocks b ON b.id = p.block_id
        WHERE p.tunnel_id = ${phase.wasTunnel} AND p.status = 'allocated'
        ORDER BY cidr`;
      await buildGatewayClient(tg)
        .updatePeerIps(tg.wg_public_key, tg.private_ip, cidrRows.map((r) => r.cidr),
          `billing-cancel-ip-${ip}-${Date.now()}`)
        .catch((e) => console.error(`[billing] updatePeerIps failed for ${ip}:`, e));
    }
  }
}

export async function forceCancelIpBlock(blockId: string): Promise<void> {
  const phase = await sql.begin(async (tx: Tx) => {
    const bRows: { id: string; pool_id: string; block_size: number; user_id: string; block: string }[] = await tx`
      SELECT id, pool_id, block_size, user_id, block::text AS block FROM ip_blocks
      WHERE id = ${blockId} FOR UPDATE`;
    const b = bRows[0];
    if (!b) return null;

    const ipRows: { ip: string; tunnel_id: string | null }[] = await tx`
      SELECT host(ip_address) AS ip, tunnel_id FROM public_ips
      WHERE block_id = ${blockId}`;
    const tunnelIds = [
      ...new Set(ipRows.map((r) => r.tunnel_id).filter(Boolean) as string[]),
    ];

    await tx`UPDATE public_ips
             SET status = 'available', tunnel_id = NULL, user_id = NULL,
                 block_id = NULL, released_at = NOW(),
                 next_billing_at = NULL, suspended_at = NULL,
                 delete_after = NULL
             WHERE block_id = ${blockId}`;
    await tx`UPDATE ip_blocks SET status = 'released',
             suspended_at = NULL, delete_after = NULL
             WHERE id = ${blockId}`;
    await tx`UPDATE ip_pool
             SET available_count = available_count + ${b.block_size},
                 allocated_count = GREATEST(allocated_count - ${b.block_size}, 0)
             WHERE id = ${b.pool_id}`;
    await tx`INSERT INTO audit_logs (actor_type, action, resource_type,
               resource_id, success, metadata)
             VALUES ('system', 'billing.cancel', 'ip_block', ${blockId}, true,
               ${JSON.stringify({ freed: ipRows.length, affectedTunnels: tunnelIds })}::jsonb)`;
    if (b.user_id) {
      await notify(tx, b.user_id, {
        type: "billing.cancelled",
        severity: "error",
        title: "IP Block ถูกลบ — หมดระยะผ่อนผัน",
        body: `IP Block ${b.block} ถูกคืนเข้า pool เพราะไม่ได้เติมเงินภายใน 3 วันหลังถูกระงับ.`,
        metadata: { kind: "block", id: blockId, cidr: b.block },
      });
    }
    return { tunnelIds };
  });

  if (phase) {
    for (const tid of phase.tunnelIds) {
      try {
        const gwRows: ({ wg_public_key: string; private_ip: string } & GwInfo)[] = await sql`
          SELECT t.wg_public_key, host(t.private_ip) AS private_ip,
                 g.agent_endpoint, g.agent_ca_cert, g.agent_token
          FROM tunnels t JOIN vpn_gateways g ON g.id = t.gateway_id
          WHERE t.id = ${tid} AND t.deleted_at IS NULL`;
        const tg = gwRows[0];
        if (!tg) continue;
        const cidrRows = await sql<{ cidr: string }[]>`
          SELECT host(ip_address) || '/32' AS cidr
          FROM public_ips
          WHERE tunnel_id = ${tid} AND status = 'allocated' AND block_id IS NULL
          UNION ALL
          SELECT DISTINCT b.block::text AS cidr
          FROM public_ips p JOIN ip_blocks b ON b.id = p.block_id
          WHERE p.tunnel_id = ${tid} AND p.status = 'allocated'
          ORDER BY cidr`;
        await buildGatewayClient(tg).updatePeerIps(
          tg.wg_public_key, tg.private_ip,
          cidrRows.map((r) => r.cidr),
          `billing-cancel-block-${blockId}-${tid}-${Date.now()}`,
        );
      } catch (e) {
        console.error(`[billing] block cancel sync failed for tunnel ${tid}:`, e);
      }
    }
  }
}

// stub helper kept for future use (unused in cancel paths above which open their own tx)
void syncPeerIps;
void GRACE_DAYS;
void DAY_MS;
