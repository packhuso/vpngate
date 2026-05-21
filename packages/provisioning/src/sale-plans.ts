// Helpers for ip_sale_plans-driven allocation (design 2.1, migration 0002).
// A sale plan is a sub-CIDR within a pool with sale_mode='single' or 'block'.
// Plans are non-overlapping; pools without plans fall back to "all single".

export interface SalePlan {
  id: string;
  cidr: string;
  saleMode: "single" | "block";
  blockSize: number | null;
}

export const ip4ToInt = (ip: string): number =>
  ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
export const intToIp4 = (n: number): string =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

export function parseCidr(cidr: string): {
  net: number;
  size: number;
  prefix: number;
} {
  const [base, lenStr] = cidr.split("/");
  const prefix = Number(lenStr);
  return { net: ip4ToInt(base), size: 1 << (32 - prefix), prefix };
}

/** Returns true if `inner` is fully contained within `outer`. */
export function cidrContains(outer: string, inner: string): boolean {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  return i.net >= o.net && i.net + i.size <= o.net + o.size;
}

/** Returns true if the CIDR is aligned (network address has all host-bits zero). */
export function isAligned(cidr: string): boolean {
  const { net, size } = parseCidr(cidr);
  return (net & (size - 1)) === 0;
}

/** Returns true if two CIDRs overlap. */
export function cidrsOverlap(a: string, b: string): boolean {
  const A = parseCidr(a);
  const B = parseCidr(b);
  return A.net < B.net + B.size && B.net < A.net + A.size;
}

/** Find the first free /32 in any 'single' plan of the pool.
 *  If pool has NO plans, falls back to "whole pool is single". */
export function findFreeSingleIp(
  poolCidr: string,
  plans: SalePlan[],
  takenSet: Set<number>,
): string | null {
  const singlePlans = plans.filter((p) => p.saleMode === "single");
  // Fallback: pool has no plans at all → legacy "all single" behaviour
  const ranges: { net: number; size: number }[] =
    plans.length === 0
      ? [parseCidr(poolCidr)]
      : singlePlans.map((p) => {
          const { net, size } = parseCidr(p.cidr);
          return { net, size };
        });
  for (const r of ranges) {
    for (let off = 0; off < r.size; off++) {
      if (!takenSet.has(r.net + off)) return intToIp4(r.net + off);
    }
  }
  return null;
}

/** Find the first aligned block of exactly `blockSize` in any matching plan. */
export function findFreeBlock(
  poolCidr: string,
  plans: SalePlan[],
  blockSize: number,
  takenSet: Set<number>,
): { net: number; ips: string[] } | null {
  const blockPlans = plans.filter(
    (p) => p.saleMode === "block" && p.blockSize === blockSize,
  );
  const ranges: { net: number; size: number }[] =
    plans.length === 0
      ? [parseCidr(poolCidr)]
      : blockPlans.map((p) => {
          const { net, size } = parseCidr(p.cidr);
          return { net, size };
        });
  for (const r of ranges) {
    for (let off = 0; off + blockSize <= r.size; off += blockSize) {
      let free = true;
      for (let i = 0; i < blockSize; i++) {
        if (takenSet.has(r.net + off + i)) { free = false; break; }
      }
      if (free) {
        const start = r.net + off;
        const ips: string[] = [];
        for (let i = 0; i < blockSize; i++) ips.push(intToIp4(start + i));
        return { net: start, ips };
      }
    }
  }
  return null;
}

/** For explicit-IP buy: returns true if the IP is sellable as single. */
export function isIpSellableAsSingle(
  ip: string,
  plans: SalePlan[],
): { ok: true } | { ok: false; reason: string } {
  if (plans.length === 0) return { ok: true };
  const ipInt = ip4ToInt(ip);
  const cover = plans.find((p) => {
    const { net, size } = parseCidr(p.cidr);
    return ipInt >= net && ipInt < net + size;
  });
  if (!cover) {
    return { ok: false, reason: `${ip} is not in any sale plan for this pool` };
  }
  if (cover.saleMode !== "single") {
    return {
      ok: false,
      reason: `${ip} is in a block-only range (${cover.cidr}, /${
        cover.blockSize
      })`,
    };
  }
  return { ok: true };
}
