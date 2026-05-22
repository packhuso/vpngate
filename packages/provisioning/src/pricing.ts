// DB-backed pricing + protocol×tier allow matrix (migration 0010). Replaces the
// hardcoded billing constants so admins can change prices and control which
// protocol sells which speed tier. Read on every charge/purchase/display — the
// volume is low, so no caching; correctness over micro-optimisation.
import { sql } from "@vpnhub/db";

export interface SpeedPrice {
  tier: string;
  priceSatang: number;
  sortOrder: number;
}
export interface IpPrice {
  blockSize: number; // 1 = single /32, 2..256 = aligned block
  priceSatang: number;
}
export interface AllowCell {
  protocol: string;
  tier: string;
  enabled: boolean;
}
export interface PricingConfig {
  speed: SpeedPrice[];
  ip: IpPrice[];
  allow: AllowCell[];
}

/** Full pricing config — for the admin editor and the customer pricing endpoint. */
export async function getPricing(): Promise<PricingConfig> {
  const [speed, ip, allow] = await Promise.all([
    sql<{ tier: string; price_satang: string; sort_order: number }[]>`
      SELECT tier, price_satang, sort_order FROM pricing_speed ORDER BY sort_order`,
    sql<{ block_size: number; price_satang: string }[]>`
      SELECT block_size, price_satang FROM pricing_ip ORDER BY block_size`,
    sql<{ protocol: string; tier: string; enabled: boolean }[]>`
      SELECT protocol, tier, enabled FROM pricing_protocol_tier`,
  ]);
  return {
    speed: speed.map((r) => ({ tier: r.tier, priceSatang: Number(r.price_satang), sortOrder: r.sort_order })),
    ip: ip.map((r) => ({ blockSize: r.block_size, priceSatang: Number(r.price_satang) })),
    allow: allow.map((r) => ({ protocol: r.protocol, tier: r.tier, enabled: r.enabled })),
  };
}

/** Enforced+charged price for a speed tier. Throws if the tier is unknown. */
export async function speedTierPrice(tier: string): Promise<number> {
  const [r] = await sql<{ price_satang: string }[]>`
    SELECT price_satang FROM pricing_speed WHERE tier = ${tier}`;
  if (!r) throw new Error(`unknown speed tier: ${tier}`);
  return Number(r.price_satang);
}

/** Price for a single /32 (blockSize=1) or an aligned block. Throws if unknown. */
export async function ipPrice(blockSize: number): Promise<number> {
  const [r] = await sql<{ price_satang: string }[]>`
    SELECT price_satang FROM pricing_ip WHERE block_size = ${blockSize}`;
  if (!r) throw new Error(`no price for block size: ${blockSize}`);
  return Number(r.price_satang);
}

/** Whether a protocol may sell a tier right now (false if disabled or unknown). */
export async function tierAllowed(protocol: string, tier: string): Promise<boolean> {
  const [r] = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM pricing_protocol_tier
    WHERE protocol = ${protocol} AND tier = ${tier}`;
  return r?.enabled ?? false;
}

export interface SavePricingInput {
  speed?: { tier: string; priceSatang: number }[];
  ip?: { blockSize: number; priceSatang: number }[];
  allow?: { protocol: string; tier: string; enabled: boolean }[];
}

/** Persist admin edits. Only updates existing tiers/sizes (no schema growth) and
 *  upserts allow cells. Runs in one transaction. */
export async function savePricing(input: SavePricingInput): Promise<void> {
  await sql.begin(async (tx) => {
    for (const s of input.speed ?? []) {
      if (!Number.isInteger(s.priceSatang) || s.priceSatang < 0) {
        throw new Error(`invalid price for ${s.tier}`);
      }
      await tx`UPDATE pricing_speed SET price_satang = ${s.priceSatang} WHERE tier = ${s.tier}`;
    }
    for (const p of input.ip ?? []) {
      if (!Number.isInteger(p.priceSatang) || p.priceSatang < 0) {
        throw new Error(`invalid price for block ${p.blockSize}`);
      }
      await tx`UPDATE pricing_ip SET price_satang = ${p.priceSatang} WHERE block_size = ${p.blockSize}`;
    }
    for (const a of input.allow ?? []) {
      await tx`
        INSERT INTO pricing_protocol_tier (protocol, tier, enabled)
        VALUES (${a.protocol}, ${a.tier}, ${a.enabled})
        ON CONFLICT (protocol, tier) DO UPDATE SET enabled = ${a.enabled}`;
    }
  });
}
