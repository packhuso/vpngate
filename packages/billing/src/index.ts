// VPN Hub — billing logic (design Section 2.1 pricing, 2.2 31-day cycle).
import { BILLING_CYCLE_DAYS, type Satang } from "@vpnhub/shared";

export type SpeedTier = "tier_100mb" | "tier_500mb" | "tier_1gb";

/** Speed package monthly price (design Section 2.1), in satang. */
export const TIER_PRICE_SATANG: Record<SpeedTier, Satang> = {
  tier_100mb: 10000, // 100 ฿
  tier_500mb: 20000, // 200 ฿
  tier_1gb: 30000, // 300 ฿
};

/** Per-tunnel bandwidth cap in kilobits/sec — passed straight to `tc rate`
 *  on the gateway (HTB egress on wg0 + ifb0 ingress mirror). Both directions
 *  are capped at the same rate. */
export const TIER_RATE_KBIT: Record<SpeedTier, number> = {
  tier_100mb: 100_000, //  100 Mbps
  tier_500mb: 500_000, //  500 Mbps
  tier_1gb: 1_000_000, // 1000 Mbps
};

/** Resolve a tunnel's bandwidth cap (kbit/s) from its speed tier.
 *  Falls back to the 100 Mbps tier if an unknown value is passed. */
export function tierRateKbit(tier: string): number {
  return TIER_RATE_KBIT[tier as SpeedTier] ?? TIER_RATE_KBIT.tier_100mb;
}

/** Public IP add-on pricing (design Section 2.1 + /31 /30 extension), in satang.
 *  /32 = single (100 ฿).
 *  /31 /30 charge full per-IP price (no volume discount until /29).
 *  /29 .. /24 follow design's tiered discount. */
export const SINGLE_IP_SATANG: Satang = 10000; // 100 ฿
export const IP_BLOCK_SATANG: Record<number, Satang> = {
  2: 20000, //  /31 — 100 ฿/IP × 2
  4: 40000, //  /30 — 100 ฿/IP × 4
  8: 80000, //  /29 — design
  16: 150000, // /28
  32: 280000, // /27
  64: 520000, // /26
  128: 980000, // /25
  256: 1800000, // /24
};

/** block_size → CIDR prefix length, for display + cert/SAN. */
export const BLOCK_SIZE_TO_PREFIX: Record<number, number> = {
  2: 31,
  4: 30,
  8: 29,
  16: 28,
  32: 27,
  64: 26,
  128: 25,
  256: 24,
};

const DAY_MS = 86_400_000;

/** Next billing date = +31 days, no pro-rating (design Section 2.2). */
export function nextBillingAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + BILLING_CYCLE_DAYS * DAY_MS);
}

/** Deletion deadline after suspension: +3 days (design Section 2.3). */
export function deleteAfter(suspendedAt: Date = new Date()): Date {
  return new Date(suspendedAt.getTime() + 3 * DAY_MS);
}

export function canAfford(balanceSatang: Satang, priceSatang: Satang): boolean {
  return balanceSatang >= priceSatang;
}

/** Idempotency key for a billing charge — includes cycle date so a
 *  re-run of the scheduler never double-charges (design Section 7.3). */
export function chargeIdempotencyKey(
  kind: "tunnel" | "ip" | "block",
  id: string,
  cycleDate: Date,
): string {
  return `charge-${kind}-${id}-${cycleDate.toISOString().slice(0, 10)}`;
}
