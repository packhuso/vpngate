// Admin tool — mark public IPs as 'single' / 'block_only' / 'reserved'.
// Usage:
//   MODE=block_only IPS="104.238.11.0-104.238.11.31" node dist/scripts/admin-ip-mode.js
//   MODE=reserved IPS="104.238.11.1" node dist/scripts/admin-ip-mode.js
//   MODE=single IPS="104.238.11.0/29" node dist/scripts/admin-ip-mode.js
import { sql } from "@vpnhub/db";

const ip4ToInt = (ip: string): number =>
  ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp4 = (n: number): string =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

function expand(spec: string): string[] {
  // a-b range
  if (spec.includes("-")) {
    const [a, b] = spec.split("-").map((x) => x.trim());
    const out: string[] = [];
    for (let n = ip4ToInt(a); n <= ip4ToInt(b); n++) out.push(intToIp4(n));
    return out;
  }
  // CIDR
  if (spec.includes("/")) {
    const [base, lenStr] = spec.split("/");
    const len = Number(lenStr);
    const size = 1 << (32 - len);
    const net = ip4ToInt(base);
    return Array.from({ length: size }, (_, i) => intToIp4(net + i));
  }
  // single IP
  return [spec];
}

async function main() {
  const mode = process.env.MODE;
  const ipsSpec = process.env.IPS;
  if (
    !mode ||
    !["single", "block_only", "reserved"].includes(mode) ||
    !ipsSpec
  ) {
    throw new Error(
      "MODE=single|block_only|reserved IPS='<ip|cidr|a-b>' required",
    );
  }
  const ips = ipsSpec.split(",").flatMap((s) => expand(s.trim()));

  // Find each IP's pool and upsert with sale_mode
  let touched = 0;
  for (const ip of ips) {
    const [pool] = await sql<{ id: string }[]>`
      SELECT id FROM ip_pool WHERE block >>= ${ip}::inet LIMIT 1`;
    if (!pool) {
      console.log(`  skip ${ip} — not in any pool`);
      continue;
    }
    await sql`
      INSERT INTO public_ips (ip_address, pool_id, status, sale_mode)
      VALUES (${ip}::inet, ${pool.id}, 'available', ${mode})
      ON CONFLICT (ip_address) DO UPDATE SET sale_mode = ${mode}
        WHERE public_ips.status = 'available'`;
    touched++;
  }
  console.log(`updated sale_mode='${mode}' on ${touched}/${ips.length} IPs`);

  const counts = await sql<{ sale_mode: string; n: string }[]>`
    SELECT sale_mode, count(*) AS n FROM public_ips
    WHERE status = 'available'
    GROUP BY sale_mode ORDER BY sale_mode`;
  console.log("\navailable IPs by sale_mode:");
  for (const r of counts) console.log(`  ${r.sale_mode}: ${r.n}`);
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("FAIL:", e);
    await sql.end();
    process.exit(1);
  });
